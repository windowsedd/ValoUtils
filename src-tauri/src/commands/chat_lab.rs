//! Developer Test Lab probes for the local Riot Client chat API.
//!
//! Send still uses the same channel resolver as the rest of the app: All
//! never falls through to Team. Extra request headers from the Test Lab UI
//! are attached after the lockfile Basic auth and `rchat-blocking` headers.

use crate::riot::chat::RiotChatClient;
use crate::riot::client::{self as riot_client, RiotState};
use crate::riot::models::ChatChannel;
use serde_json::{json, Map, Value};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabInfoKind {
    Party,
    Pregame,
    Current,
    All,
}

pub fn parse_lab_info_kind(raw: &str) -> Result<LabInfoKind, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "party" => Ok(LabInfoKind::Party),
        "pregame" | "pre-game" => Ok(LabInfoKind::Pregame),
        "current" | "coregame" | "current-game" => Ok(LabInfoKind::Current),
        "all" => Ok(LabInfoKind::All),
        _ => Err(format!(
            "Unknown chat lab probe '{raw}'. Use party, pregame, current or all."
        )),
    }
}

pub fn parse_lab_send_channel(raw: &str) -> Result<ChatChannel, String> {
    ChatChannel::parse(raw)
        .ok_or_else(|| format!("Unknown chat channel '{raw}'. Use party, pregame, team or all."))
}

fn arg(args: &[Value], index: usize) -> String {
    args.get(index)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn is_valid_header_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name.bytes().all(|byte| {
            matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_')
        })
}

pub fn parse_extra_headers(value: Option<&Value>) -> Vec<(String, String)> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Vec::new();
    };
    object
        .iter()
        .filter_map(|(name, raw)| {
            if !is_valid_header_name(name) {
                return None;
            }
            Some((name.trim().to_string(), raw.as_str().unwrap_or("").to_string()))
        })
        .collect()
}

fn probe_path(kind: LabInfoKind) -> &'static str {
    match kind {
        LabInfoKind::Party => "/chat/v6/conversations/ares-parties",
        LabInfoKind::Pregame => "/chat/v6/conversations/ares-pregame",
        LabInfoKind::Current => "/chat/v6/conversations/ares-coregame",
        LabInfoKind::All => "/chat/v6/conversations",
    }
}

fn request_snapshot(method: &str, url: &str, headers: &[(String, String)]) -> Value {
    let mut map = Map::new();
    for (name, value) in headers {
        map.insert(name.clone(), json!(value));
    }
    json!({
        "method": method,
        "url": url,
        "headers": map,
    })
}

async fn lab_request(
    riot: &RiotState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    extra_headers: &[(String, String)],
) -> Result<(Value, Value), String> {
    let info = riot_client::get_riot_client_info(riot)?;
    let url = format!("{}://127.0.0.1:{}{}", info.protocol, info.port, path);
    let authorization = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(format!("riot:{}", info.password))
    };
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Basic {authorization}"),
        ),
        ("rchat-blocking".to_string(), "true".to_string()),
    ];
    for (name, value) in extra_headers {
        if let Some(existing) = headers.iter_mut().find(|(key, _)| key.eq_ignore_ascii_case(name)) {
            existing.1 = value.clone();
        } else {
            headers.push((name.clone(), value.clone()));
        }
    }
    let snapshot = request_snapshot(method.as_str(), &url, &headers);

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())?;
    let mut req = client.request(method, &url);
    for (name, value) in &headers {
        req = req.header(name.as_str(), value.as_str());
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Riot Client request failed ({status}) for {path}: {text}"
        ));
    }
    let data = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok((data, snapshot))
}

#[tauri::command]
pub async fn chat_lab_info(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let kind_input = arg(&args, 0);
    let kind = match parse_lab_info_kind(&kind_input) {
        Ok(kind) => kind,
        Err(error) => {
            return Ok(json!({ "success": false, "error": error }).to_string());
        }
    };
    let extra = parse_extra_headers(args.get(1));
    Ok(
        match lab_request(
            &riot,
            reqwest::Method::GET,
            probe_path(kind),
            None,
            &extra,
        )
        .await
        {
            Ok((data, request)) => json!({
                "success": true,
                "kind": kind_input,
                "request": request,
                "data": data,
            })
            .to_string(),
            Err(error) => json!({ "success": false, "kind": kind_input, "error": error }).to_string(),
        },
    )
}

#[tauri::command]
pub async fn chat_lab_send(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let channel_input = arg(&args, 0);
    let message = arg(&args, 1);
    if message.is_empty() {
        return Ok(json!({ "success": false, "error": "Message is empty." }).to_string());
    }
    let channel = match parse_lab_send_channel(&channel_input) {
        Ok(channel) => channel,
        Err(error) => return Ok(json!({ "success": false, "error": error }).to_string()),
    };
    let extra = parse_extra_headers(args.get(2));
    let client = match RiotChatClient::connect() {
        Ok(client) => client,
        Err(error) => {
            return Ok(json!({ "success": false, "error": error.to_string() }).to_string())
        }
    };
    let cid = match client.resolve_cid(channel).await {
        Ok(cid) => cid,
        Err(error) => {
            return Ok(json!({ "success": false, "error": error.to_string() }).to_string())
        }
    };
    let body = json!({
        "cid": cid,
        "message": message,
        "type": "groupchat",
    });
    Ok(
        match lab_request(
            &riot,
            reqwest::Method::POST,
            "/chat/v6/messages",
            Some(body),
            &extra,
        )
        .await
        {
            Ok((data, request)) => json!({
                "success": true,
                "channel": channel.as_str(),
                "cid": cid,
                "message": message,
                "request": request,
                "data": data,
            })
            .to_string(),
            Err(error) => json!({ "success": false, "error": error.to_string() }).to_string(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_four_lab_probes() {
        assert_eq!(parse_lab_info_kind("party").unwrap(), LabInfoKind::Party);
        assert_eq!(
            parse_lab_info_kind("pre-game").unwrap(),
            LabInfoKind::Pregame
        );
        assert_eq!(
            parse_lab_info_kind("current-game").unwrap(),
            LabInfoKind::Current
        );
        assert_eq!(parse_lab_info_kind("all").unwrap(), LabInfoKind::All);
        assert!(parse_lab_info_kind("team").is_err());
    }

    #[test]
    fn send_channels_stay_distinct() {
        assert_eq!(parse_lab_send_channel("party").unwrap(), ChatChannel::Party);
        assert_eq!(
            parse_lab_send_channel("pregame").unwrap(),
            ChatChannel::Pregame
        );
        assert_eq!(parse_lab_send_channel("team").unwrap(), ChatChannel::Team);
        assert_eq!(parse_lab_send_channel("all").unwrap(), ChatChannel::All);
        assert!(parse_lab_send_channel("current").is_err());
    }

    #[test]
    fn extra_headers_keep_valid_names_only() {
        assert!(is_valid_header_name("X-Debug"));
        assert!(is_valid_header_name("rchat-blocking"));
        assert!(!is_valid_header_name("Bad Header"));
        assert!(!is_valid_header_name("X:Inject"));
        let parsed = parse_extra_headers(Some(&json!({
            "X-Debug": "1",
            "Nope Space": "x",
            "rchat-blocking": "false"
        })));
        assert_eq!(
            parsed,
            vec![
                ("X-Debug".into(), "1".into()),
                ("rchat-blocking".into(), "false".into()),
            ]
        );
    }
}
