use serde_json::Value;
use std::sync::Mutex;
use std::time::SystemTime;

/// Local Riot Client (lockfile-authenticated, self-signed cert) API client.
/// Mirrors electron/util/riot-client.ts.
#[derive(Default)]
pub struct RiotState {
    lockfile_cache: Mutex<Option<(RiotClientInfo, SystemTime)>>,
    tokens_cache: Mutex<Option<(Value, std::time::Instant)>>,
}

#[derive(Clone, serde::Serialize)]
pub struct RiotClientInfo {
    pub name: String,
    pub pid: i64,
    pub port: u16,
    pub password: String,
    pub protocol: String,
}

fn lockfile_path() -> std::path::PathBuf {
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    std::path::PathBuf::from(localappdata)
        .join("Riot Games")
        .join("Riot Client")
        .join("Config")
        .join("lockfile")
}

fn insecure_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .expect("failed to build insecure reqwest client")
    })
}

pub fn get_riot_client_info(state: &RiotState) -> Result<RiotClientInfo, String> {
    let path = lockfile_path();
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("Failed to read Riot Client lockfile: {e}"))?;

    {
        let cache = state.lockfile_cache.lock().unwrap();
        if let Some((info, cached_modified)) = cache.as_ref() {
            if *cached_modified == modified {
                return Ok(info.clone());
            }
        }
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read Riot Client lockfile: {e}"))?;
    let parts: Vec<&str> = content.trim().split(':').collect();
    if parts.len() < 5 {
        return Err("Failed to read Riot Client lockfile: malformed contents".into());
    }
    let info = RiotClientInfo {
        name: parts[0].to_string(),
        pid: parts[1].parse().unwrap_or(0),
        port: parts[2].parse().map_err(|_| "invalid port in lockfile".to_string())?,
        password: parts[3].to_string(),
        protocol: parts[4].to_string(),
    };

    *state.lockfile_cache.lock().unwrap() = Some((info.clone(), modified));
    Ok(info)
}

pub async fn send_internal_request(
    state: &RiotState,
    path: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<Value, String> {
    let info = get_riot_client_info(state)?;
    let url = format!("{}://127.0.0.1:{}{}", info.protocol, info.port, path);
    let authorization = base64_encode(&format!("riot:{}", info.password));

    let mut req = insecure_client()
        .request(method, &url)
        .header("Authorization", format!("Basic {authorization}"))
        .header("rchat-blocking", "true");
    if let Some(body) = body {
        req = req.json(&body);
    }

    let response = req.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Riot Client request failed ({status}): {text}"));
    }
    serde_json::from_str(&text).or(Ok(Value::String(text)))
}

fn base64_encode(input: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(input.as_bytes())
}

pub async fn get_tokens(state: &RiotState, skip_cache: bool) -> Result<Value, String> {
    if !skip_cache {
        let cache = state.tokens_cache.lock().unwrap();
        if let Some((tokens, cached_at)) = cache.as_ref() {
            if cached_at.elapsed() < std::time::Duration::from_secs(5 * 60) {
                return Ok(tokens.clone());
            }
        }
    }
    let tokens = send_internal_request(state, "/entitlements/v1/token", reqwest::Method::GET, None).await?;
    *state.tokens_cache.lock().unwrap() = Some((tokens.clone(), std::time::Instant::now()));
    Ok(tokens)
}

pub async fn get_user_info(state: &RiotState) -> Result<Value, String> {
    send_internal_request(state, "/riot-client-auth/v1/userinfo", reqwest::Method::GET, None).await
}

pub async fn swagger_spec(state: &RiotState) -> Result<Value, String> {
    send_internal_request(state, "/swagger/v3/openapi.json", reqwest::Method::GET, None).await
}

pub async fn get_region_locale(state: &RiotState) -> Result<Value, String> {
    send_internal_request(state, "/riotclient/region-locale", reqwest::Method::GET, None).await
}

pub async fn get_valorant_client_version(state: &RiotState) -> Result<String, String> {
    let sessions = send_internal_request(state, "/product-session/v1/external-sessions", reqwest::Method::GET, None).await?;
    let version = sessions
        .as_object()
        .and_then(|obj| obj.values().find(|s| s.get("productId").and_then(|v| v.as_str()) == Some("valorant")))
        .and_then(|s| s.get("version"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(version)
}

/// Presences of the local player and their friends. Each entry carries a
/// base64 `private` blob (VALORANT presence) that includes the player's
/// `partyId` — the only way to group players into parties during a live
/// game, since coregame/pregame strip PartyID. Tries v4, falls back to v2.
pub async fn get_presences(state: &RiotState) -> Result<Vec<Value>, String> {
    let data = match send_internal_request(state, "/chat/v4/presences", reqwest::Method::GET, None).await {
        Ok(data) => data,
        Err(_) => send_internal_request(state, "/chat/v2/presences", reqwest::Method::GET, None).await?,
    };
    Ok(data.get("presences").and_then(|v| v.as_array()).cloned().unwrap_or_default())
}

pub async fn get_friends(state: &RiotState) -> Result<Vec<Value>, String> {
    let data = send_internal_request(state, "/chat/v4/friends", reqwest::Method::GET, None).await?;
    Ok(data.get("friends").and_then(|v| v.as_array()).cloned().unwrap_or_default())
}

pub async fn get_chat_messages(state: &RiotState, conversation_id: Option<&str>) -> Result<Value, String> {
    let path = match conversation_id {
        Some(cid) => format!("/chat/v6/messages?cid={}", urlencoding_encode(cid)),
        None => "/chat/v6/messages".to_string(),
    };
    send_internal_request(state, &path, reqwest::Method::GET, None).await
}

pub async fn get_chat_conversations(state: &RiotState) -> Result<Value, String> {
    send_internal_request(state, "/chat/v6/conversations", reqwest::Method::GET, None).await
}

pub async fn get_party_chat_info(state: &RiotState) -> Result<Value, String> {
    send_internal_request(state, "/chat/v6/conversations/ares-parties", reqwest::Method::GET, None).await
}

pub async fn get_pre_game_chat_info(state: &RiotState) -> Result<Value, String> {
    send_internal_request(state, "/chat/v6/conversations/ares-pregame", reqwest::Method::GET, None).await
}

pub async fn get_current_game_chat_info(state: &RiotState) -> Result<Value, String> {
    send_internal_request(state, "/chat/v6/conversations/ares-coregame", reqwest::Method::GET, None).await
}

pub async fn send_chat_message(state: &RiotState, conversation_id: &str, message: &str, msg_type: &str) -> Result<Value, String> {
    let body = serde_json::json!({ "cid": conversation_id, "message": message, "type": msg_type });
    send_internal_request(state, "/chat/v6/messages", reqwest::Method::POST, Some(body)).await
}

pub fn urlencoding_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
