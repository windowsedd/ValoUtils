//! Remote chat: a phone page served by ValoUtils on the local network and
//! Tailscale, so the player can read and answer Party/Team/All chat and
//! whispers, and run party/queue actions, while away from the PC.
//!
//! - Opt-in: runs only while the `remoteEnabled` config flag is true.
//! - Listens on every IPv4 interface but only answers peers on loopback,
//!   private LAN ranges, link-local and Tailscale's 100.64.0.0/10 range.
//! - Every API request needs `Authorization: Bearer <remoteToken>`. The page
//!   gets the token from the QR code's URL fragment (never sent to the server
//!   in a request line), keeps it in the phone's localStorage and sends it as
//!   a header, so a cross-site page cannot ride on it.
//! - Chat comes from `chat_get`, cached briefly so several open phones don't
//!   multiply Riot Client requests; sends and party actions reuse the MCP
//!   helpers (same relay path, GLZ client and auth retry).

use axum::body::Bytes;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::riot::client::RiotState;
use crate::store::ConfigStore;

/// First port tried; the chosen port is saved as `remotePort` so a paired
/// phone keeps working across launches.
pub const PREFERRED_PORT: u16 = 47824;

/// How long one `chat_get` result serves every remote poll.
const CHAT_CACHE_TTL: Duration = Duration::from_millis(2500);
const PARTY_CACHE_TTL: Duration = Duration::from_secs(4);
const ROOM_LINES: usize = 100;
const DM_LINES: usize = 50;
const MAX_MESSAGE_CHARS: usize = 1000;
const MAX_BODY_BYTES: usize = 8 * 1024;

const PAGE: &str = include_str!("remote_page.html");

struct Server {
    port: Option<u16>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

static SERVER: Mutex<Server> = Mutex::new(Server {
    port: None,
    task: None,
});

static CHAT_CACHE: tokio::sync::Mutex<Option<(Instant, Value)>> = tokio::sync::Mutex::const_new(None);
static PARTY_CACHE: tokio::sync::Mutex<Option<(Instant, Value)>> = tokio::sync::Mutex::const_new(None);

pub fn running_port() -> Option<u16> {
    SERVER.lock().unwrap().port
}

/// The saved token, creating and saving one the first time.
pub fn token(config: &ConfigStore) -> String {
    match config.get("remoteToken").and_then(|v| v.as_str().map(str::to_owned)) {
        Some(token) if !token.is_empty() => token,
        _ => {
            let token = crate::mcp::new_token();
            config.set("remoteToken", json!(token));
            token
        }
    }
}

/// Starts the server if it isn't running. Returns the port it listens on.
pub async fn start(app: &AppHandle) -> Result<u16, String> {
    if let Some(port) = running_port() {
        return Ok(port);
    }
    let config = app.state::<ConfigStore>();
    token(&config);
    let saved = config
        .get("remotePort")
        .and_then(|v| v.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0);
    let mut listener = None;
    for port in [saved.unwrap_or(PREFERRED_PORT), PREFERRED_PORT, 0] {
        match tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await {
            Ok(bound) => {
                listener = Some(bound);
                break;
            }
            Err(error) => log::info!("Remote chat port {port} unavailable: {error}"),
        }
    }
    let listener = listener.ok_or("Could not open a network port for remote chat.")?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not read the remote chat port: {e}"))?
        .port();
    if saved != Some(port) {
        config.set("remotePort", json!(port));
    }
    let router = Router::new()
        .route("/", get(page))
        .route("/api/state", get(chat_state))
        .route("/api/party", get(party_state).post(party_command))
        .route("/api/send", post(send))
        .with_state(app.clone());
    let task = tauri::async_runtime::spawn(async move {
        let service = router.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(error) = axum::serve(listener, service).await {
            log::error!("Remote chat server stopped: {error}");
        }
    });
    let mut server = SERVER.lock().unwrap();
    if let Some(running) = server.port {
        task.abort();
        return Ok(running);
    }
    *server = Server {
        port: Some(port),
        task: Some(task),
    };
    log::info!("Remote chat listening on port {port}");
    Ok(port)
}

pub fn stop() {
    let mut server = SERVER.lock().unwrap();
    if let Some(task) = server.task.take() {
        task.abort();
        log::info!("Remote chat stopped");
    }
    server.port = None;
}

pub async fn start_if_enabled(app: AppHandle) {
    if app.state::<ConfigStore>().get("remoteEnabled") != Some(json!(true)) {
        return;
    }
    if let Err(error) = start(&app).await {
        log::warn!("Remote chat did not start: {error}");
    }
}

// ---------------------------------------------------------------------------
// Addresses

/// Tailscale (and other CGNAT overlay) addresses: 100.64.0.0/10.
fn is_tailscale(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (b & 0xC0) == 64
}

/// Peers allowed to talk to the server: this PC, the LAN and Tailscale.
pub(crate) fn allowed_peer(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local() || is_tailscale(ip),
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The local address Windows would use to reach `target`. A UDP connect only
/// picks a route; nothing is sent.
fn route_source(target: &str) -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(target).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_loopback() => Some(ip),
        _ => None,
    }
}

/// Addresses a phone can open, Tailscale first: `(ip, "tailscale" | "lan")`.
pub fn addresses() -> Vec<(Ipv4Addr, &'static str)> {
    let mut found: Vec<(Ipv4Addr, &'static str)> = Vec::new();
    // Tailscale routes its own service address through the tailnet adapter.
    for target in ["100.100.100.100:53", "1.1.1.1:80", "10.255.255.255:1", "192.168.255.255:1"] {
        let Some(ip) = route_source(target) else { continue };
        let kind = if is_tailscale(ip) {
            "tailscale"
        } else if ip.is_private() || ip.is_link_local() {
            "lan"
        } else {
            continue;
        };
        if !found.iter().any(|(seen, _)| *seen == ip) {
            found.push((ip, kind));
        }
    }
    found.sort_by_key(|(_, kind)| *kind != "tailscale");
    found
}

pub fn page_url(ip: Ipv4Addr, port: u16, token: &str) -> String {
    format!("http://{ip}:{port}/#t={token}")
}

// ---------------------------------------------------------------------------
// HTTP

fn json_response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")],
        body.to_string(),
    )
        .into_response()
}

fn fail(message: impl Into<String>) -> Response {
    json_response(StatusCode::OK, json!({ "success": false, "error": message.into() }))
}

/// A same-origin `Origin` (the page's own POSTs) or none (GETs) is fine; any
/// other site is refused.
pub(crate) fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    !host.is_empty() && origin.to_str().ok() == Some(format!("http://{host}").as_str())
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|given| crate::mcp::same_secret(given.trim().as_bytes(), expected.as_bytes()))
}

/// The refusal for a request that may not use the API, or `None` when it may.
fn guard(app: &AppHandle, peer: SocketAddr, headers: &HeaderMap) -> Option<Response> {
    if !allowed_peer(peer.ip()) || !origin_allowed(headers) {
        return Some(StatusCode::FORBIDDEN.into_response());
    }
    if !authorized(headers, &token(&app.state::<ConfigStore>())) {
        return Some(json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "success": false, "code": "unauthorized", "error": "This link is no longer paired. Scan the QR code in ValoUtils again." }),
        ));
    }
    None
}

fn body_json(body: &Bytes) -> Option<Value> {
    (body.len() <= MAX_BODY_BYTES)
        .then(|| serde_json::from_slice::<Value>(body).ok())
        .flatten()
        .filter(Value::is_object)
}

async fn page(ConnectInfo(peer): ConnectInfo<SocketAddr>) -> Response {
    if !allowed_peer(peer.ip()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_FRAME_OPTIONS, "DENY"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
            ),
        ],
        PAGE,
    )
        .into_response()
}

async fn cached_chat(app: &AppHandle) -> Value {
    let mut cache = CHAT_CACHE.lock().await;
    if let Some((at, value)) = cache.as_ref() {
        if at.elapsed() < CHAT_CACHE_TTL {
            return value.clone();
        }
    }
    let reply = crate::commands::chat::chat_get(app.clone(), app.state::<RiotState>())
        .await
        .unwrap_or(Value::Null);
    let view = chat_view(&reply);
    *cache = Some((Instant::now(), view.clone()));
    view
}

async fn forget_chat() {
    *CHAT_CACHE.lock().await = None;
}

async fn forget_party() {
    *PARTY_CACHE.lock().await = None;
}

async fn chat_state(
    State(app): State<AppHandle>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = guard(&app, peer, &headers) {
        return response;
    }
    json_response(StatusCode::OK, cached_chat(&app).await)
}

async fn party_state(
    State(app): State<AppHandle>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = guard(&app, peer, &headers) {
        return response;
    }
    let mut cache = PARTY_CACHE.lock().await;
    if let Some((at, value)) = cache.as_ref() {
        if at.elapsed() < PARTY_CACHE_TTL {
            return json_response(StatusCode::OK, value.clone());
        }
    }
    let value = match crate::commands::mcp::party_snapshot(&app).await {
        Ok(party) => json!({ "success": true, "party": party }),
        Err(error) => json!({ "success": false, "error": crate::commands::mcp::party_failure(&error) }),
    };
    *cache = Some((Instant::now(), value.clone()));
    json_response(StatusCode::OK, value)
}

async fn send(
    State(app): State<AppHandle>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(response) = guard(&app, peer, &headers) {
        return response;
    }
    let Some(request) = body_json(&body) else {
        return fail("Bad request.");
    };
    let text = |key: &str| request.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let (channel, message) = (text("channel"), text("message"));
    if message.is_empty() {
        return fail("The message is empty.");
    }
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return fail(format!("Messages are limited to {MAX_MESSAGE_CHARS} characters."));
    }
    let result = match channel.as_str() {
        "party" | "team" | "all" => crate::commands::mcp::send_chat(&app, &channel, "", &message).await,
        "friend" => whisper(&app, &text("puuid"), &message).await,
        _ => Err("Unknown chat.".to_string()),
    };
    forget_chat().await;
    match result {
        Ok(_) => {
            track(&app, "remote:send", json!({ "channel": channel }));
            json_response(StatusCode::OK, json!({ "success": true }))
        }
        Err(error) => fail(error),
    }
}

/// Whispers a friend by PUUID; only people on the friends list can be messaged.
async fn whisper(app: &AppHandle, puuid: &str, message: &str) -> Result<String, String> {
    let wanted = id_root(puuid);
    if wanted.is_empty() {
        return Err("Pick a friend first.".into());
    }
    let riot = app.state::<RiotState>();
    let friends = crate::riot::client::get_friends(&riot)
        .await
        .map_err(|error| crate::commands::mcp::party_failure(&error))?;
    let pid = friends
        .iter()
        .find(|friend| {
            ["puuid", "pid"]
                .iter()
                .filter_map(|key| friend.get(*key).and_then(Value::as_str))
                .any(|id| id_root(id) == wanted)
        })
        .and_then(|friend| friend.get("pid").and_then(Value::as_str))
        .ok_or("That player isn't on your friends list.")?
        .to_string();
    crate::riot::client::send_chat_message(&riot, &pid, message, "chat")
        .await
        .map_err(|error| crate::commands::mcp::party_failure(&error))?;
    Ok("sent".into())
}

async fn party_command(
    State(app): State<AppHandle>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(response) = guard(&app, peer, &headers) {
        return response;
    }
    let Some(request) = body_json(&body) else {
        return fail("Bad request.");
    };
    let text = |key: &str| request.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let action = text("action");
    let failure = |error: crate::riot::error::RiotError| crate::commands::mcp::party_failure(&error);
    let reply = match action.as_str() {
        "start_queue" | "stop_queue" | "leave_party" | "change_queue" => {
            crate::commands::mcp::party_action(&app, &action, &text("queue"))
                .await
                .map(|message| json!({ "success": true, "message": message }))
                .map_err(failure)
        }
        "create_code" => crate::commands::riot_chat::create_party_invite_code(&app)
            .await
            .map(|code| {
                json!({ "success": true, "inviteCode": code, "link": crate::commands::riot_chat::party_link(&code) })
            })
            .map_err(failure),
        "disable_code" => crate::commands::riot_chat::disable_party_invite_code(&app)
            .await
            .map(|()| json!({ "success": true, "message": "Party code turned off." }))
            .map_err(failure),
        "join_code" => crate::commands::riot_chat::join_party_by_code(&app, &text("code"))
            .await
            .map(|code| json!({ "success": true, "message": format!("Joined party {code}.") }))
            .map_err(failure),
        _ => Err("Unknown party action.".to_string()),
    };
    forget_party().await;
    match reply {
        Ok(value) => {
            track(&app, "remote:party", json!({ "action": action }));
            json_response(StatusCode::OK, value)
        }
        Err(error) => fail(error),
    }
}

fn track(app: &AppHandle, event: &str, props: Value) {
    crate::aptabase::track_event(event.to_string(), props, app.package_info().version.to_string());
}

// ---------------------------------------------------------------------------
// Chat view

fn id_root(id: &str) -> String {
    id.split('@').next().unwrap_or_default().trim().to_ascii_lowercase()
}

/// Reduces a `chat_get` reply to what the phone page shows: the three rooms
/// with their recent lines, and friends with any whisper lines.
pub(crate) fn chat_view(reply: &Value) -> Value {
    if reply.get("success") != Some(&json!(true)) {
        return json!({
            "success": false,
            "code": reply.get("code"),
            "error": reply.get("error").and_then(Value::as_str).unwrap_or("Chat isn't available right now."),
        });
    }
    let messages: Vec<&Value> = reply.get("messages").and_then(Value::as_array).into_iter().flatten().collect();
    let conversations: Vec<&Value> =
        reply.get("conversations").and_then(Value::as_array).into_iter().flatten().collect();
    let line = |message: &Value| {
        json!({
            "id": message.get("id"),
            "from": message.get("senderName"),
            "you": message.get("isSelf").and_then(Value::as_bool).unwrap_or(false),
            "text": message.get("body"),
            "time": message.get("timestamp"),
        })
    };
    let lines_for = |root: &str, limit: usize| -> Vec<Value> {
        let all: Vec<Value> = messages
            .iter()
            .filter(|m| m.get("conversationId").and_then(Value::as_str).is_some_and(|cid| id_root(cid) == root))
            .map(|m| line(m))
            .collect();
        let start = all.len().saturating_sub(limit);
        all[start..].to_vec()
    };
    let room_cid = |key: &str| {
        reply
            .pointer(&format!("/rooms/{key}"))
            .and_then(Value::as_str)
            .filter(|cid| !cid.is_empty())
    };
    let room = |cid: Option<&str>| match cid {
        None => Value::Null,
        Some(cid) => {
            let root = id_root(cid);
            let ended = conversations.iter().any(|c| {
                c.get("cid").and_then(Value::as_str).is_some_and(|other| id_root(other) == root)
                    && c.get("ended").and_then(Value::as_bool) == Some(true)
            });
            json!({ "ended": ended, "messages": lines_for(&root, ROOM_LINES) })
        }
    };
    let friends: Vec<Value> = reply
        .get("friends")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|friend| {
            let root = id_root(friend.get("puuid").and_then(Value::as_str)?);
            if root.is_empty() {
                return None;
            }
            let unread = conversations
                .iter()
                .find(|c| {
                    c.get("type").and_then(Value::as_str) == Some("chat")
                        && c.get("cid").and_then(Value::as_str).is_some_and(|cid| id_root(cid) == root)
                })
                .and_then(|c| c.get("unreadCount"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            Some(json!({
                "puuid": root,
                "name": friend.get("displayName"),
                "online": friend.get("isOnline").and_then(Value::as_bool).unwrap_or(false),
                "status": friend.get("status"),
                "unread": unread,
                "messages": lines_for(&root, DM_LINES),
            }))
        })
        .collect();
    json!({
        "success": true,
        "rooms": {
            "party": room(room_cid("party")),
            "team": room(room_cid("matchTeam").or_else(|| room_cid("match"))),
            "all": room(room_cid("matchAll")),
        },
        "friends": friends,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_lan_and_tailscale_peers_are_allowed() {
        for ip in ["127.0.0.1", "192.168.1.20", "10.0.0.5", "172.20.1.1", "169.254.3.4", "100.101.102.103", "::1", "fd7a:115c:a1e0::1", "::ffff:192.168.1.2"] {
            assert!(allowed_peer(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "100.128.0.1", "100.63.255.255", "2001:4860::8888", "::ffff:8.8.8.8"] {
            assert!(!allowed_peer(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn foreign_origins_are_refused() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "192.168.1.5:47824".parse().unwrap());
        assert!(origin_allowed(&headers));
        headers.insert(header::ORIGIN, "http://192.168.1.5:47824".parse().unwrap());
        assert!(origin_allowed(&headers));
        headers.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(!origin_allowed(&headers));
    }

    #[test]
    fn bearer_token_is_required() {
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, "secret"));
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert!(authorized(&headers, "secret"));
        assert!(!authorized(&headers, "other"));
    }

    #[test]
    fn chat_view_groups_rooms_and_whispers() {
        let reply = json!({
            "success": true,
            "rooms": { "party": "p1@ares-parties.na1", "match": "", "matchTeam": "m1-blue@ares-coregame.na1", "matchAll": "" },
            "conversations": [
                { "cid": "m1-blue@ares-coregame.na1", "type": "groupchat", "ended": true },
                { "cid": "friend@na1.pvp.net", "type": "chat", "unreadCount": 2 }
            ],
            "messages": [
                { "id": "1", "conversationId": "p1@ares-parties.na1", "senderName": "Me", "isSelf": true, "body": "hi", "timestamp": "1" },
                { "id": "2", "conversationId": "m1-blue@ares-coregame.na1", "senderName": "Ally", "body": "gg", "timestamp": "2" },
                { "id": "3", "conversationId": "friend@na1.pvp.net", "senderName": "Duo#NA1", "body": "on?", "timestamp": "3" }
            ],
            "friends": [{ "puuid": "FRIEND", "displayName": "Duo#NA1", "isOnline": true, "status": "chat" }]
        });
        let view = chat_view(&reply);
        assert_eq!(view["rooms"]["party"]["messages"][0]["text"], "hi");
        assert_eq!(view["rooms"]["party"]["messages"][0]["you"], true);
        assert_eq!(view["rooms"]["team"]["ended"], true);
        assert_eq!(view["rooms"]["team"]["messages"][0]["from"], "Ally");
        assert!(view["rooms"]["all"].is_null());
        assert_eq!(view["friends"][0]["unread"], 2);
        assert_eq!(view["friends"][0]["messages"][0]["text"], "on?");
        assert_eq!(view["friends"][0]["puuid"], "friend");
    }

    #[test]
    fn chat_view_passes_failures_through() {
        let view = chat_view(&json!({ "success": false, "code": "loginRequired", "error": "Sign in" }));
        assert_eq!(view["success"], false);
        assert_eq!(view["code"], "loginRequired");
    }

    #[test]
    fn tailscale_range_is_cgnat() {
        assert!(is_tailscale(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_tailscale(Ipv4Addr::new(100, 127, 255, 254)));
        assert!(!is_tailscale(Ipv4Addr::new(100, 128, 0, 1)));
    }
}
