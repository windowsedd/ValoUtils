use crate::riot::{error::RiotError, lockfile};
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

fn insecure_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .no_proxy()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build insecure reqwest client")
    })
}

/// Classify typed errors before converting them to display text at IPC boundaries.
pub fn is_login_required_error(error: &RiotError) -> bool {
    error.is_login_required()
}

pub fn get_riot_client_info(state: &RiotState) -> Result<RiotClientInfo, RiotError> {
    let path = lockfile::path()?;
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(RiotError::from_lockfile_io)?;

    {
        let cache = state.lockfile_cache.lock().unwrap();
        if let Some((info, cached_modified)) = cache.as_ref() {
            if *cached_modified == modified {
                return Ok(info.clone());
            }
        }
    }

    let content = std::fs::read_to_string(&path).map_err(RiotError::from_lockfile_io)?;
    let parsed = lockfile::parse(&content)?;
    let info = RiotClientInfo {
        name: parsed.name.clone(),
        pid: parsed.pid,
        port: parsed.port,
        password: parsed.password().to_string(),
        protocol: parsed.protocol.clone(),
    };

    *state.lockfile_cache.lock().unwrap() = Some((info.clone(), modified));
    Ok(info)
}

pub async fn send_internal_request(
    state: &RiotState,
    path: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<Value, RiotError> {
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
        Err(error) => {
            let error = RiotError::from_transport(error);
            if !error.is_login_required() {
                return Err(error);
            }
            *state.lockfile_cache.lock().unwrap() = None;
            *state.tokens_cache.lock().unwrap() = None;
            return Err(error);
        }
    };
    let status = response.status();
    let text = response.text().await.map_err(RiotError::from_transport)?;
    if !status.is_success() {
        let error = classify_local_http(status.as_u16(), &text);
        if error.is_login_required() {
            *state.lockfile_cache.lock().unwrap() = None;
            *state.tokens_cache.lock().unwrap() = None;
        }
        return Err(error);
    }
    serde_json::from_str(&text).or(Ok(Value::String(text)))
}

fn classify_local_http(status: u16, text: &str) -> RiotError {
    let payload: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let code = payload
        .get("errorCode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let message = payload.get("message").and_then(Value::as_str).unwrap_or("");
    match status {
        401 | 403 => RiotError::LoginRequired,
        404 if code == "RESOURCE_NOT_FOUND" => RiotError::RiotClientNotRunning,
        503 if message.starts_with("not connected to chat") => RiotError::LoginRequired,
        404 if code == "RPC_ERROR" && message == "not_found" => RiotError::ConversationNotFound,
        _ => RiotError::LocalHttp { status },
    }
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
pub async fn get_tokens(state: &RiotState, skip_cache: bool) -> Result<Value, RiotError> {
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

pub async fn get_user_info(state: &RiotState) -> Result<Value, RiotError> {
    send_internal_request(
        state,
        "/riot-client-auth/v1/userinfo",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn swagger_spec(state: &RiotState) -> Result<Value, RiotError> {
    send_internal_request(
        state,
        "/swagger/v3/openapi.json",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn get_region_locale(state: &RiotState) -> Result<Value, RiotError> {
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
pub async fn get_valorant_client_version(state: &RiotState) -> Result<String, RiotError> {
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
pub async fn get_presences(state: &RiotState) -> Result<Vec<Value>, RiotError> {
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

pub async fn get_friends(state: &RiotState) -> Result<Vec<Value>, RiotError> {
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
pub async fn get_friend_requests(state: &RiotState) -> Result<Vec<Value>, RiotError> {
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
) -> Result<Value, RiotError> {
    match conversation_id {
        None => send_internal_request(state, "/chat/v6/messages", reqwest::Method::GET, None).await,
        Some(cid) => specific_history_or_fallback(state, cid).await,
    }
}

fn channel_hint(cid: &str) -> crate::riot::models::ChatChannel {
    crate::riot::models::ChatChannel::EVERY
        .into_iter()
        .find(|channel| channel.matches_cid(cid))
        .unwrap_or(crate::riot::models::ChatChannel::Party)
}

fn conversation_entries(payload: &Value) -> Vec<Value> {
    payload
        .get("conversations")
        .or_else(|| payload.get("Conversations"))
        .or_else(|| payload.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

async fn find_listed_conversation(
    state: &RiotState,
    cid: &str,
) -> Result<Option<Value>, RiotError> {
    let mut payloads = vec![get_chat_conversations(state).await?];
    if cid.contains("@ares-parties") {
        payloads.push(get_party_chat_info(state).await.unwrap_or(Value::Null));
    } else if cid.contains("@ares-pregame") {
        payloads.push(get_pre_game_chat_info(state).await.unwrap_or(Value::Null));
    } else if cid.contains("@ares-coregame") {
        payloads.push(
            get_current_game_chat_info(state)
                .await
                .unwrap_or(Value::Null),
        );
    }
    for payload in payloads {
        for item in conversation_entries(&payload) {
            if item.get("cid").and_then(Value::as_str) == Some(cid) {
                return Ok(Some(item));
            }
        }
    }
    Ok(None)
}

async fn all_history_filtered(state: &RiotState, cid: &str) -> Result<Value, RiotError> {
    let payload =
        send_internal_request(state, "/chat/v6/messages", reqwest::Method::GET, None).await?;
    let messages = payload
        .get("messages")
        .or_else(|| payload.get("Messages"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let filtered: Vec<Value> = messages
        .into_iter()
        .filter(|message| message.get("cid").and_then(Value::as_str) == Some(cid))
        .collect();
    Ok(serde_json::json!({ "messages": filtered }))
}

fn is_rpc_not_found(error: &RiotError) -> bool {
    matches!(error, RiotError::ConversationNotFound)
}

async fn specific_history_or_fallback(
    state: &RiotState,
    raw_cid: &str,
) -> Result<Value, RiotError> {
    let cid = crate::riot::models::validate_riot_cid(raw_cid)?;
    let listed = match find_listed_conversation(state, cid).await? {
        Some(item) => item,
        None => {
            tokio::time::sleep(if cfg!(test) {
                std::time::Duration::ZERO
            } else {
                std::time::Duration::from_millis(1500)
            })
            .await;
            find_listed_conversation(state, cid).await?.ok_or_else(|| {
                crate::riot::error::RiotError::StaleConversation {
                    channel: channel_hint(cid),
                }
            })?
        }
    };
    let history_enabled = listed
        .get("message_history")
        .or_else(|| listed.get("messageHistory"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !history_enabled {
        log::info!(
            "GET /chat/v6/messages channel={} cid={} fallback=true reason=message_history_false",
            channel_hint(cid).as_str(),
            crate::riot::models::sanitize_cid_for_log(cid)
        );
        return all_history_filtered(state, cid).await;
    }

    let path = crate::riot::models::messages_path_for_cid(cid)?;
    match send_internal_request(state, &path, reqwest::Method::GET, None).await {
        Ok(payload) => Ok(payload),
        Err(error) if is_rpc_not_found(&error) => {
            if find_listed_conversation(state, cid).await?.is_none() {
                return Err(crate::riot::error::RiotError::StaleConversation {
                    channel: channel_hint(cid),
                });
            }
            log::info!(
                "GET /chat/v6/messages status=404 channel={} cid={} fallback=true",
                channel_hint(cid).as_str(),
                crate::riot::models::sanitize_cid_for_log(cid)
            );
            all_history_filtered(state, cid).await
        }
        Err(error) => Err(error),
    }
}

pub async fn get_chat_conversations(state: &RiotState) -> Result<Value, RiotError> {
    send_internal_request(state, "/chat/v6/conversations", reqwest::Method::GET, None).await
}

pub async fn get_party_chat_info(state: &RiotState) -> Result<Value, RiotError> {
    send_internal_request(
        state,
        "/chat/v6/conversations/ares-parties",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn get_pre_game_chat_info(state: &RiotState) -> Result<Value, RiotError> {
    send_internal_request(
        state,
        "/chat/v6/conversations/ares-pregame",
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn get_current_game_chat_info(state: &RiotState) -> Result<Value, RiotError> {
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
) -> Result<Value, RiotError> {
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
    fn local_http_classification_uses_status_and_payload_fields() {
        assert!(is_login_required_error(&classify_local_http(401, "")));
        assert!(is_login_required_error(&classify_local_http(
            404,
            r#"{"errorCode":"RESOURCE_NOT_FOUND"}"#
        )));
        assert!(is_login_required_error(&classify_local_http(
            503,
            r#"{"message":"not connected to chat, service unavailable"}"#
        )));
        assert!(!is_login_required_error(&classify_local_http(
            503,
            r#"{"message":"backend timeout"}"#
        )));
        assert!(!is_login_required_error(&classify_local_http(
            500,
            r#"{"message":"lockfile authentication failed"}"#
        )));
        assert!(is_rpc_not_found(&classify_local_http(
            404,
            r#"{"errorCode":"RPC_ERROR","message":"not_found"}"#
        )));
        assert!(!is_rpc_not_found(&classify_local_http(
            404,
            r#"{"errorCode":"RESOURCE_NOT_FOUND"}"#
        )));
    }
}
