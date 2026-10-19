use crate::riot::{
    api,
    client::{self, RiotState},
    error::RiotError,
};
use serde_json::{json, Value};
use tauri::State;
use valorant_api::typing::bloomline::BloomlinePlayerResponse;

fn agent_uuid(input: &str) -> Option<String> {
    if input.len() != 32 && input.len() != 36 {
        return None;
    }
    if input.len() == 36 && ![8, 13, 18, 23].iter().all(|&i| input.as_bytes()[i] == b'-') {
        return None;
    }
    let hex = input.replace('-', "").to_ascii_lowercase();
    if hex.len() != 32 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

fn parse_bloomline(
    mut raw: Value,
    owner: &str,
    selected: Option<&str>,
) -> Result<Vec<Value>, RiotError> {
    let unreadable = || {
        RiotError::Other(
            "Riot returned Bloomline data this app could not read. Try refreshing.".into(),
        )
    };
    let entries = raw
        .get_mut("Bonsais")
        .and_then(Value::as_array_mut)
        .ok_or_else(unreadable)?;
    for entry in entries {
        if entry.get("Flourish").is_some_and(Value::is_null) {
            entry["Flourish"] = json!({});
        }
    }
    let response: BloomlinePlayerResponse =
        serde_json::from_value(raw).map_err(|_| unreadable())?;
    if !response.Subject.eq_ignore_ascii_case(owner) {
        return Err(unreadable());
    }
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for agent in response.Bonsais {
        let id = agent_uuid(&agent.BonsaiID).ok_or_else(unreadable)?;
        if !seen.insert(id.clone()) {
            return Err(unreadable());
        }
        if selected.is_some_and(|selected| selected != id) {
            continue;
        }
        let stats = agent.NumberModules.map(|modules| modules.into_iter()
            .filter(|module| !module.NumberID.is_empty() && !module.NumberID.chars().all(|c| c == '0' || c == '-'))
            .map(|module| json!({ "numberId": module.NumberID, "moduleId": module.ModuleID, "value": module.Value }))
            .collect::<Vec<_>>());
        rows.push(json!({
            "agentId": id,
            "level": agent.Flourish.ShortLevel.filter(|value| *value >= 0),
            "longLevel": agent.Flourish.LongLevel.filter(|value| *value >= 0),
            "points": agent.Flourish.Points.filter(|value| *value >= 0),
            "stats": stats,
        }));
    }
    if selected.is_some() && rows.is_empty() {
        return Err(unreadable());
    }
    Ok(rows)
}

async fn confirmed_bloomline(
    request: impl std::future::Future<Output = Result<(String, Option<Value>), RiotError>>,
    current_tokens: impl std::future::Future<Output = Result<Value, RiotError>>,
    selected: Option<&str>,
) -> Result<Value, RiotError> {
    let (owner, raw) = request.await?;
    let Some(raw) = raw else {
        return Ok(json!({"success":false,"code":"accountChanged"}));
    };
    // An account switch can keep the same lockfile while a PD request is in flight.
    let tokens = current_tokens.await?;
    if !tokens
        .get("subject")
        .and_then(Value::as_str)
        .is_some_and(|subject| subject.eq_ignore_ascii_case(&owner))
    {
        return Ok(json!({"success":false,"code":"accountChanged"}));
    }
    parse_bloomline(raw, &owner, selected)
        .map(|rows| json!({"success":true,"puuid":owner,"agents":rows}))
}

#[tauri::command]
pub async fn bloomline_get(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<Value, ()> {
    let agent = match args.first() {
        None => None,
        Some(value) => match value.as_str().and_then(agent_uuid) {
            Some(id) => Some(id),
            None => return Ok(json!({"success":false,"code":"invalidInput"})),
        },
    };
    let expected_owner = args
        .get(1)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    if agent.is_some() && expected_owner.is_none() {
        return Ok(json!({"success":false,"code":"invalidInput"}));
    }
    let request = api::with_api(&riot, |api| {
        let agent = agent.clone();
        async move {
            if expected_owner.is_some_and(|owner| !owner.eq_ignore_ascii_case(&api.puuid)) {
                return Ok((api.puuid, None));
            }
            let raw = api.get_bloomline(agent.as_deref()).await?;
            Ok((api.puuid, Some(raw)))
        }
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        confirmed_bloomline(request, client::get_tokens(&riot, true), agent.as_deref()),
    )
    .await
    .unwrap_or(Err(RiotError::Timeout));
    Ok(match result {
        Ok(reply) => reply,
        Err(error) => match super::rate_limited_reply(&error.to_string()).await {
            Some(reply) => reply,
            None => json!({"success":false,"code":error.code(),"error":error}),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AGENT: &str = "add6443a-41bd-e414-f6ad-e58d267f4e95";

    #[tokio::test]
    async fn bloomline_discards_a_response_when_the_account_changes_during_fetch() {
        let owner = std::sync::Mutex::new("first");
        let (release, pending) = tokio::sync::oneshot::channel();
        let request = async {
            pending.await.unwrap();
            Ok((
                "first".into(),
                Some(json!({"Subject":"first","Bonsais":[]})),
            ))
        };
        let tokens = async { Ok(json!({"subject": *owner.lock().unwrap()})) };
        let (result, ()) = tokio::join!(confirmed_bloomline(request, tokens, None), async {
            *owner.lock().unwrap() = "second";
            release.send(()).unwrap();
        },);
        assert_eq!(
            result.unwrap(),
            json!({"success":false,"code":"accountChanged"})
        );
        let reply = confirmed_bloomline(
            async {
                Ok((
                    "second".into(),
                    Some(json!({"Subject":"second","Bonsais":[]})),
                ))
            },
            async { Ok(json!({"subject":"second"})) },
            None,
        )
        .await
        .unwrap();
        assert_eq!(reply["success"], true);
        assert_eq!(reply["puuid"], "second");
    }

    #[test]
    fn bloomline_normalizes_agent_ids_and_preserves_zero_and_missing_values() {
        let rows = parse_bloomline(
            json!({"Subject":"me", "Bonsais":[{
                "BonsaiID":"ADD6443A41BDE414F6ADE58D267F4E95",
                "Flourish":{"ShortLevel":0,"Points":0},
                "NumberModules":[
                    {"NumberID":"00000000000000000000000000000000","Value":0},
                    {"NumberID":"kills-id","Value":0}
                ]
            }]}),
            "me",
            Some(AGENT),
        )
        .unwrap();
        assert_eq!(rows[0]["agentId"], AGENT);
        assert_eq!(rows[0]["level"], 0);
        assert_eq!(rows[0]["points"], 0);
        assert_eq!(rows[0]["longLevel"], Value::Null);
        assert_eq!(rows[0]["stats"].as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["stats"][0]["value"], 0.0);
    }

    #[test]
    fn bloomline_accepts_empty_accounts_and_unknown_progress() {
        assert!(
            parse_bloomline(json!({"Subject":"me","Bonsais":[]}), "me", None)
                .unwrap()
                .is_empty()
        );
        let rows = parse_bloomline(
            json!({"Subject":"me","Bonsais":[{"BonsaiID":AGENT,"Flourish":null}]}),
            "me",
            None,
        )
        .unwrap();
        assert_eq!(rows[0]["level"], Value::Null);
        assert_eq!(rows[0]["stats"], Value::Null);
    }

    #[test]
    fn bloomline_rejects_other_accounts_malformed_payloads_and_missing_agents() {
        for raw in [
            json!({"Subject":"other","Bonsais":[]}),
            json!({"Subject":"me"}),
            json!({"Subject":"me","Bonsais":{}}),
            json!({"Subject":"me","Bonsais":[{"BonsaiID":"../bad"}]}),
        ] {
            assert!(parse_bloomline(raw, "me", None).is_err());
        }
        assert!(parse_bloomline(json!({"Subject":"me","Bonsais":[]}), "me", Some(AGENT)).is_err());
    }
}
