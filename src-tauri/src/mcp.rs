//! Local MCP server, so an AI client (Claude Code, or Claude Desktop through
//! `mcp-remote`) can read the signed-in player's Valorant data via ValoUtils.
//!
//! - Opt-in: runs only while the `mcpEnabled` config flag is true.
//! - Loopback only (127.0.0.1), and every request needs `Authorization:
//!   Bearer <mcpToken>`. Requests carrying an `Origin` header are refused, so a
//!   web page cannot reach it from the user's browser.
//! - Streamable HTTP transport with plain JSON replies (no SSE stream, no
//!   sessions). Tools are read-only and live in `commands::mcp`.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::{json, Value};
use std::net::Ipv4Addr;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::store::ConfigStore;

/// First port tried; the chosen port is saved as `mcpPort` so client configs
/// keep working across launches.
pub const PREFERRED_PORT: u16 = 47823;

/// Newest first. An unknown requested version is answered with the newest.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

#[derive(Default)]
struct Server {
    port: Option<u16>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

static SERVER: Mutex<Server> = Mutex::new(Server {
    port: None,
    task: None,
});

pub fn running_port() -> Option<u16> {
    SERVER.lock().unwrap().port
}

/// A fresh 32-byte random token, base64url without padding.
pub fn new_token() -> String {
    use base64::Engine;
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .expect("system random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The saved token, creating and saving one the first time.
pub fn token(config: &ConfigStore) -> String {
    match config.get("mcpToken").and_then(|v| v.as_str().map(str::to_owned)) {
        Some(token) if !token.is_empty() => token,
        _ => {
            let token = new_token();
            config.set("mcpToken", json!(token));
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
        .get("mcpPort")
        .and_then(|v| v.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0);
    let mut listener = None;
    for port in [saved.unwrap_or(PREFERRED_PORT), PREFERRED_PORT, 0] {
        match tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
            Ok(bound) => {
                listener = Some(bound);
                break;
            }
            Err(error) => log::info!("MCP port {port} unavailable: {error}"),
        }
    }
    let listener = listener.ok_or("Could not open a local port for the MCP server.")?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not read the MCP server port: {e}"))?
        .port();
    if saved != Some(port) {
        config.set("mcpPort", json!(port));
    }
    let router = Router::new()
        .route("/mcp", post(handle).get(not_allowed).delete(not_allowed))
        .with_state(app.clone());
    let task = tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            log::error!("MCP server stopped: {error}");
        }
    });
    let mut server = SERVER.lock().unwrap();
    // Another start may have won while this one was binding.
    if let Some(running) = server.port {
        task.abort();
        return Ok(running);
    }
    *server = Server {
        port: Some(port),
        task: Some(task),
    };
    log::info!("MCP server listening on 127.0.0.1:{port}");
    Ok(port)
}

pub fn stop() {
    let mut server = SERVER.lock().unwrap();
    if let Some(task) = server.task.take() {
        task.abort();
        log::info!("MCP server stopped");
    }
    server.port = None;
}

/// Starts the server at launch when the user has turned it on.
pub async fn start_if_enabled(app: AppHandle) {
    if app.state::<ConfigStore>().get("mcpEnabled") != Some(json!(true)) {
        return;
    }
    if let Err(error) = start(&app).await {
        log::warn!("MCP server did not start: {error}");
    }
}

async fn not_allowed() -> StatusCode {
    // No server-initiated stream and no sessions to end.
    StatusCode::METHOD_NOT_ALLOWED
}

/// Byte-wise comparison that doesn't stop at the first difference.
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|given| same_secret(given.trim().as_bytes(), expected.as_bytes()))
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn handle(State(app): State<AppHandle>, headers: HeaderMap, body: Bytes) -> Response {
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let expected = token(&app.state::<ConfigStore>());
    if !authorized(&headers, &expected) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
        )
            .into_response();
    }
    let Ok(request) = serde_json::from_slice::<Value>(&body) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            rpc_error(Value::Null, -32700, "Parse error"),
        );
    };
    match dispatch(&app, &request).await {
        Some(reply) => json_response(StatusCode::OK, reply),
        // Notifications and client responses get no body.
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Answers one JSON-RPC message, or `None` when it needs no reply.
async fn dispatch(app: &AppHandle, request: &Value) -> Option<Value> {
    if !request.is_object() {
        return Some(rpc_error(Value::Null, -32600, "Batches are not supported"));
    }
    let id = request.get("id").cloned()?;
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        // A response to a server request; this server sends none.
        return None;
    };
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(initialize_result(
            params.get("protocolVersion").and_then(Value::as_str),
            &app.package_info().version.to_string(),
        )),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": crate::commands::mcp::tool_list() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            match crate::commands::mcp::call_tool(app, name, &arguments).await {
                Some(result) => Ok(result),
                None => Err((-32602, format!("Unknown tool: {name}"))),
            }
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

fn initialize_result(requested: Option<&str>, version: &str) -> Value {
    let protocol = requested
        .filter(|requested| PROTOCOL_VERSIONS.contains(requested))
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "valoutils", "title": "ValoUtils", "version": version },
        "instructions": "Valorant data for the player signed in to the Riot Client on this PC: rank and recent competitive games, the current agent select or match, the store, the battle pass, and saved and current settings. lookup_player finds any player's rank and matches by Riot ID. open_valorant launches the game; every other tool only reads. Riot Client must be running and signed in for account data. Players in a live match are labelled You / Ally N / Enemy N, never by name.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_token_must_match_exactly() {
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, "secret"));
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert!(authorized(&headers, "secret"));
        assert!(!authorized(&headers, "secret2"));
        headers.insert(header::AUTHORIZATION, "Basic secret".parse().unwrap());
        assert!(!authorized(&headers, "secret"));
    }

    #[test]
    fn initialize_echoes_a_supported_version_or_offers_the_newest() {
        assert_eq!(
            initialize_result(Some("2025-03-26"), "1.0.0")["protocolVersion"],
            "2025-03-26"
        );
        assert_eq!(
            initialize_result(Some("1999-01-01"), "1.0.0")["protocolVersion"],
            PROTOCOL_VERSIONS[0]
        );
        assert_eq!(initialize_result(None, "1.0.0")["serverInfo"]["version"], "1.0.0");
    }

    #[test]
    fn tokens_are_long_and_distinct() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
    }
}
