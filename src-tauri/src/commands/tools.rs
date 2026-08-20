use crate::fake_player;
use crate::riot::api;
use crate::riot::client::RiotState;
use serde_json::{json, Value};
use tauri::State;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlayerQuery {
    RiotId { game_name: String, tag_line: String },
    Puuid(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedPlayer {
    puuid: String,
    game_name: String,
    tag_line: String,
}

fn is_puuid(value: &str) -> bool {
    let hex_len = value.bytes().filter(u8::is_ascii_hexdigit).count();
    hex_len == 32
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

pub(crate) fn parse_player_query(input: &str) -> Result<PlayerQuery, &'static str> {
    let input = input.trim();
    if input.is_empty() {
        return Err("invalidInput");
    }
    if let Some((game_name, tag_line)) = input.rsplit_once('#') {
        let game_name = game_name.trim();
        let tag_line = tag_line.trim();
        if game_name.is_empty() || tag_line.is_empty() {
            return Err("invalidInput");
        }
        if game_name
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
            || tag_line
                .chars()
                .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
        {
            return Err("invalidInput");
        }
        return Ok(PlayerQuery::RiotId {
            game_name: game_name.to_owned(),
            tag_line: tag_line.to_owned(),
        });
    }
    if is_puuid(input) {
        return Ok(PlayerQuery::Puuid(input.to_owned()));
    }
    Err("invalidInput")
}

fn name_entry(entry: &Value) -> Option<ResolvedPlayer> {
    let puuid = entry.get("Subject").and_then(Value::as_str)?.trim();
    let game_name = entry.get("GameName").and_then(Value::as_str)?.trim();
    let tag_line = entry.get("TagLine").and_then(Value::as_str)?.trim();
    if puuid.is_empty() || game_name.is_empty() || tag_line.is_empty() {
        return None;
    }
    Some(ResolvedPlayer {
        puuid: puuid.to_owned(),
        game_name: game_name.to_owned(),
        tag_line: tag_line.to_owned(),
    })
}

pub(crate) fn resolved_player_from_names(
    value: &Value,
    expected_puuid: Option<&str>,
) -> Option<ResolvedPlayer> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(name_entry)
        .find(|player| match expected_puuid {
            Some(expected) => player.puuid.eq_ignore_ascii_case(expected),
            None => true,
        })
}

pub(crate) fn alias_lookup_path(game_name: &str, tag_line: &str) -> String {
    format!(
        "/player-account/aliases/v1/lookup?gameName={}&tagLine={}",
        crate::riot::client::urlencoding_encode(game_name),
        crate::riot::client::urlencoding_encode(tag_line)
    )
}

fn alias_lookup_entry(entry: &Value) -> Option<ResolvedPlayer> {
    let puuid = entry.get("puuid").and_then(Value::as_str)?.trim();
    let alias = entry.get("alias")?;
    let game_name = alias.get("game_name").and_then(Value::as_str)?.trim();
    let tag_line = alias.get("tag_line").and_then(Value::as_str)?.trim();
    if puuid.is_empty() || game_name.is_empty() || tag_line.is_empty() {
        return None;
    }
    Some(ResolvedPlayer {
        puuid: puuid.to_owned(),
        game_name: game_name.to_owned(),
        tag_line: tag_line.to_owned(),
    })
}

pub(crate) fn resolved_player_from_alias_lookup(value: &Value) -> Option<ResolvedPlayer> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .find_map(alias_lookup_entry)
}

pub(crate) fn local_resolved_player(query: &PlayerQuery) -> Option<ResolvedPlayer> {
    let matches = match query {
        PlayerQuery::RiotId {
            game_name,
            tag_line,
        } => {
            game_name.eq_ignore_ascii_case(fake_player::GAME_NAME)
                && tag_line.eq_ignore_ascii_case(fake_player::TAG_LINE)
        }
        PlayerQuery::Puuid(puuid) => puuid.eq_ignore_ascii_case(fake_player::PUUID),
    };
    matches.then(|| ResolvedPlayer {
        puuid: fake_player::PUUID.to_owned(),
        game_name: fake_player::GAME_NAME.to_owned(),
        tag_line: fake_player::TAG_LINE.to_owned(),
    })
}

fn resolve_error(code: &str, error: &str) -> String {
    json!({ "success": false, "code": code, "error": error }).to_string()
}

fn resolve_success(player: ResolvedPlayer) -> String {
    json!({
        "success": true,
        "puuid": player.puuid,
        "gameName": player.game_name,
        "tagLine": player.tag_line,
    })
    .to_string()
}

#[tauri::command]
pub async fn tools_player_resolve(
    args: Vec<Value>,
    riot: State<'_, RiotState>,
) -> Result<String, ()> {
    let query = match parse_player_query(args.first().and_then(Value::as_str).unwrap_or("")) {
        Ok(query) => query,
        Err(_) => {
            return Ok(resolve_error(
                "invalidInput",
                "Enter a Riot ID (Name#Tag) or player PUUID.",
            ));
        }
    };

    if let Some(player) = local_resolved_player(&query) {
        return Ok(resolve_success(player));
    }

    let result = match &query {
        PlayerQuery::RiotId {
            game_name,
            tag_line,
        } => {
            crate::riot::client::send_internal_request(
                &riot,
                &alias_lookup_path(game_name, tag_line),
                reqwest::Method::GET,
                None,
            )
            .await
        }
        PlayerQuery::Puuid(puuid) => {
            let puuid = puuid.clone();
            api::with_api(&riot, move |api| {
                let puuid = puuid.clone();
                async move { api.get_names(&[puuid]).await }
            })
            .await
        }
    };

    Ok(match result {
        Ok(payload) => {
            let player = match &query {
                PlayerQuery::RiotId { .. } => resolved_player_from_alias_lookup(&payload),
                PlayerQuery::Puuid(puuid) => {
                    resolved_player_from_names(&payload, Some(puuid.as_str()))
                }
            };
            match player {
                Some(player) => resolve_success(player),
                None => resolve_error("playerNotFound", "No Valorant player matched that lookup."),
            }
        }
        Err(error) if error.contains("lockfile") => {
            resolve_error("loginRequired", "Open the Riot Client and sign in.")
        }
        Err(error) if error.contains("\"status\":404") => {
            resolve_error("playerNotFound", "No Valorant player matched that lookup.")
        }
        Err(error) => resolve_error("unavailable", &error),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_riot_id_on_the_last_hash() {
        assert_eq!(
            parse_player_query("  TenZ#SEN  ").unwrap(),
            PlayerQuery::RiotId {
                game_name: "TenZ".into(),
                tag_line: "SEN".into(),
            }
        );
        assert_eq!(
            parse_player_query("weird#name#NA1").unwrap(),
            PlayerQuery::RiotId {
                game_name: "weird#name".into(),
                tag_line: "NA1".into(),
            }
        );
    }

    #[test]
    fn parses_canonical_puuids_and_rejects_bare_names() {
        assert_eq!(
            parse_player_query("  41c322a1-b328-495b-a004-5ccd3e45eae8  ").unwrap(),
            PlayerQuery::Puuid("41c322a1-b328-495b-a004-5ccd3e45eae8".into())
        );
        assert!(parse_player_query("").is_err());
        assert!(parse_player_query("   ").is_err());
        assert!(parse_player_query("TenZ").is_err());
        assert!(parse_player_query("#SEN").is_err());
        assert!(parse_player_query("TenZ#").is_err());
        assert!(parse_player_query("../bad#id").is_err());
    }

    #[test]
    fn builds_the_local_alias_lookup_path() {
        assert_eq!(
            alias_lookup_path("Ten Z", "S#N"),
            "/player-account/aliases/v1/lookup?gameName=Ten%20Z&tagLine=S%23N"
        );
    }

    #[test]
    fn reads_canonical_riot_id_from_local_alias_lookup() {
        let lookup = json!([{
            "alias": { "game_name": "baiii", "tag_line": "918" },
            "puuid": "player-baiii"
        }]);
        let resolved = resolved_player_from_alias_lookup(&lookup).expect("alias hit");
        assert_eq!(resolved.puuid, "player-baiii");
        assert_eq!(resolved.game_name, "baiii");
        assert_eq!(resolved.tag_line, "918");
        assert!(resolved_player_from_alias_lookup(&json!([])).is_none());
        assert!(resolved_player_from_alias_lookup(&json!([{
            "alias": { "game_name": "baiii", "tag_line": "918" },
            "puuid": ""
        }]))
        .is_none());
    }

    #[test]
    fn reads_canonical_riot_id_from_name_service_entries() {
        let names = json!([{
            "Subject": "player-a",
            "GameName": "TenZ",
            "TagLine": "SEN"
        }]);
        let resolved = resolved_player_from_names(&names, None).expect("alias hit");
        assert_eq!(resolved.puuid, "player-a");
        assert_eq!(resolved.game_name, "TenZ");
        assert_eq!(resolved.tag_line, "SEN");

        let by_puuid = resolved_player_from_names(&names, Some("PLAYER-A")).expect("puuid hit");
        assert_eq!(by_puuid.game_name, "TenZ");
        assert!(resolved_player_from_names(&names, Some("missing")).is_none());
        assert!(resolved_player_from_names(&json!([]), None).is_none());
        assert!(resolved_player_from_names(
            &json!([{ "Subject": "player-a", "GameName": "", "TagLine": "" }]),
            None
        )
        .is_none());
    }

    #[test]
    fn resolves_the_local_fake_player_without_riot() {
        let by_name = local_resolved_player(&PlayerQuery::RiotId {
            game_name: "valoutils bot".into(),
            tag_line: "bot".into(),
        })
        .expect("fake riot id");
        assert_eq!(by_name.puuid, fake_player::PUUID);
        assert_eq!(by_name.game_name, fake_player::GAME_NAME);
        assert_eq!(by_name.tag_line, fake_player::TAG_LINE);

        let by_puuid =
            local_resolved_player(&PlayerQuery::Puuid(fake_player::PUUID.to_ascii_uppercase()))
                .expect("fake puuid");
        assert_eq!(by_puuid.game_name, fake_player::GAME_NAME);
        assert!(local_resolved_player(&PlayerQuery::Puuid(
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into()
        ))
        .is_none());
    }
}
