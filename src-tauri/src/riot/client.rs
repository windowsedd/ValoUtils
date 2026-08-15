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

fn local_client_unavailable_error(path: &str) -> String {
    format!(
        "Riot Client is not ready (stale lockfile while requesting {path}). \
         Make sure the Riot Client is running, then try again."
    )
}

/// Whether a local-API error means "nobody is signed in" rather than a real
/// fault, so the caller can answer `{ code: "loginRequired" }` and the frontend
/// can show its sign-in panel instead of dumping a raw HTTP error at the player.
///
/// Callers: `friends_get`, `chat_get`, `chat_history`, `matches_get`. Keep this
/// the single definition — it used to be copied per command, and each copy knew
/// about a different subset of these conditions.
pub fn is_login_required_error(error: &str) -> bool {
    let value = error.to_lowercase();
    value.contains("lockfile")
        || value.contains("connection refused")
        || value.contains("failed to connect")
        || value.contains("error sending request for url (https://127.0.0.1")
        || value.contains("riot client is not running")
        || value.contains("authentication failed")
        || value.contains("session expired")
        // The Riot Client is up and answering, but its chat service never came
        // online because the player never signed in. Every chat route reports it
        // the same way: 503 RPC_ERROR, "not connected to chat".
        || value.contains("not connected to chat")
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
        port: parts[2]
            .parse()
            .map_err(|_| "invalid port in lockfile".to_string())?,
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

    let response = match req.send().await {
        Ok(response) => response,
        Err(_) => {
            *state.lockfile_cache.lock().unwrap() = None;
            *state.tokens_cache.lock().unwrap() = None;
            return Err(local_client_unavailable_error(path));
        }
    };
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Every local endpoint answering 404 "Invalid URI format" means we are
        // talking to a Riot Client that hasn't mounted its API routes — either
        // one that is still starting up, or a dead one whose lockfile was left
        // behind and whose port has since been reused. Both look identical over
        // HTTP, and both are fixed the same way: drop the cached lockfile so the
        // next call re-reads it, and report it as a "not signed in" condition so
        // the frontend shows its login-required state instead of a raw 404.
        //
        // The word "lockfile" in the message is load-bearing: friends_get,
        // chat_get and career_get map errors containing it to `loginRequired`.
        if status == reqwest::StatusCode::NOT_FOUND && text.contains("RESOURCE_NOT_FOUND") {
            *state.lockfile_cache.lock().unwrap() = None;
            *state.tokens_cache.lock().unwrap() = None;
            return Err(format!(
                "Riot Client is not ready (stale lockfile, no route for {path}). \
                 Make sure the Riot Client is running, then try again."
            ));
        }
        return Err(format!(
            "Riot Client request failed ({status}) for {path}: {text}"
        ));
    }
    serde_json::from_str(&text).or(Ok(Value::String(text)))
}

fn base64_encode(input: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(input.as_bytes())
}

/// Seconds left on an RSO access token, read from the JWT's `exp` claim.
/// `None` when the token can't be parsed, which is treated as "don't trust it".
fn access_token_ttl(tokens: &Value) -> Option<i64> {
    use base64::Engine;
    let jwt = tokens.get("accessToken").and_then(|v| v.as_str())?;
    let payload = jwt.split('.').nth(1)?;
    // Spec says base64url unpadded, but accept the padded and standard-alphabet
    // spellings too — a decode failure here would silently disable the cache.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(payload))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(payload))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    let exp = claims.get("exp").and_then(|v| v.as_i64())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some(exp - now)
}

/// Tokens for the signed-in player.
///
/// The cache is deliberately conservative: an entry is only reused while the
/// underlying access token still has real life left in it. A plain time-based
/// cache isn't enough — switching Riot accounts issues a brand new token
/// without touching the lockfile, and the previous one starts failing remote
/// calls with `BAD_CLAIMS` immediately.
pub async fn get_tokens(state: &RiotState, skip_cache: bool) -> Result<Value, String> {
    const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);
    /// Refresh early so a request can't be issued against a token that expires
    /// while it's in flight.
    const MIN_REMAINING_SECS: i64 = 120;

    if !skip_cache {
        let cache = state.tokens_cache.lock().unwrap();
        if let Some((tokens, cached_at)) = cache.as_ref() {
            let fresh_enough = cached_at.elapsed() < CACHE_TTL;
            let still_valid = access_token_ttl(tokens)
                .map(|ttl| ttl > MIN_REMAINING_SECS)
                .unwrap_or(false);
            if fresh_enough && still_valid {
                return Ok(tokens.clone());
            }
        }
    }
    let tokens =
        send_internal_request(state, "/entitlements/v1/token", reqwest::Method::GET, None).await?;
    *state.tokens_cache.lock().unwrap() = Some((tokens.clone(), std::time::Instant::now()));
    Ok(tokens)
}

/// Drop cached tokens so the next call re-reads them from the Riot Client.
pub fn invalidate_tokens(state: &RiotState) {
    *state.tokens_cache.lock().unwrap() = None;
}

pub async fn get_user_info(state: &RiotState) -> Result<Value, String> {
    send_internal_request(
        state,
        "/riot-client-auth/v1/userinfo",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn swagger_spec(state: &RiotState) -> Result<Value, String> {
    send_internal_request(
        state,
        "/swagger/v3/openapi.json",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn get_region_locale(state: &RiotState) -> Result<Value, String> {
    send_internal_request(
        state,
        "/riotclient/region-locale",
        reqwest::Method::GET,
        None,
    )
    .await
}

/// NOTE: the `version` field here is a build hash (e.g. `0127606AA79E4164`), not
/// the `release-13.02-shipping-10-5229475` string Riot's game APIs want in
/// `X-Riot-ClientVersion`. Callers must validate it — see
/// `riot::api::looks_like_client_version`.
pub async fn get_valorant_client_version(state: &RiotState) -> Result<String, String> {
    let sessions = send_internal_request(
        state,
        "/product-session/v1/external-sessions",
        reqwest::Method::GET,
        None,
    )
    .await?;
    let version = sessions
        .as_object()
        .and_then(|obj| {
            obj.values()
                .find(|s| s.get("productId").and_then(|v| v.as_str()) == Some("valorant"))
        })
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
    let data = match send_internal_request(state, "/chat/v4/presences", reqwest::Method::GET, None)
        .await
    {
        Ok(data) => data,
        Err(_) => {
            send_internal_request(state, "/chat/v2/presences", reqwest::Method::GET, None).await?
        }
    };
    Ok(data
        .get("presences")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

pub async fn get_friends(state: &RiotState) -> Result<Vec<Value>, String> {
    let data = send_internal_request(state, "/chat/v4/friends", reqwest::Method::GET, None).await?;
    Ok(data
        .get("friends")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

/// Pending friend invites in both directions. Each entry carries a
/// `subscription` of `pending_in` (they invited us) or `pending_out` (we
/// invited them).
pub async fn get_friend_requests(state: &RiotState) -> Result<Vec<Value>, String> {
    let data =
        send_internal_request(state, "/chat/v4/friendrequests", reqwest::Method::GET, None).await?;
    Ok(data
        .get("requests")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

pub async fn get_chat_messages(
    state: &RiotState,
    conversation_id: Option<&str>,
) -> Result<Value, String> {
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
    send_internal_request(
        state,
        "/chat/v6/conversations/ares-parties",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn get_pre_game_chat_info(state: &RiotState) -> Result<Value, String> {
    send_internal_request(
        state,
        "/chat/v6/conversations/ares-pregame",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn get_current_game_chat_info(state: &RiotState) -> Result<Value, String> {
    send_internal_request(
        state,
        "/chat/v6/conversations/ares-coregame",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn send_chat_message(
    state: &RiotState,
    conversation_id: &str,
    message: &str,
    msg_type: &str,
) -> Result<Value, String> {
    let body = serde_json::json!({ "cid": conversation_id, "message": message, "type": msg_type });
    send_internal_request(
        state,
        "/chat/v6/messages",
        reqwest::Method::POST,
        Some(body),
    )
    .await
}

pub fn urlencoding_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_failure_is_classified_as_login_required() {
        let message = local_client_unavailable_error("/entitlements/v1/token");

        assert!(message.contains("lockfile"));
        assert!(message.contains("Riot Client is not ready"));
        assert!(!message.contains("127.0.0.1"));
    }
}
