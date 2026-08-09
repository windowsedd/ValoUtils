//! Local stand-in for Riot's client config service.
//!
//! The Riot Client asks whatever `--client-config-url` points at for its
//! configuration, including where the chat servers live. Hosting that locally
//! is the hook every chat-interception tool is built on.
//!
//! Successful JSON responses are forwarded with Riot's chat target rewritten
//! to the in-process XMPP relay. Unrelated fields and unsuccessful responses
//! remain untouched.
//!
//! The client sends its RSO credentials to this server, so it binds to
//! 127.0.0.1 only — never a wildcard address.

use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use base64::Engine;
use reqwest::header::HeaderValue;
use serde_json::{json, Value};
use std::net::Ipv4Addr;
use std::sync::{Mutex, OnceLock};

const UPSTREAM: &str = "https://clientconfig.rpg.riotgames.com";
const PAS_CHAT_URL: &str = "https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat";
pub const LOCAL_CHAT_HOST: &str = "deceive-localhost.molenzwiebel.xyz";
pub const DEFAULT_PORT: u16 = 8000;
pub const HEALTH_PATH: &str = "/__valoutils/health";

/// Hop-by-hop or connection-specific headers that must not be relayed.
/// `accept-encoding` is dropped so reqwest negotiates and decodes the body
/// itself — forwarding it would hand back a compressed body with the header
/// stripped, which the client cannot read.
const SKIP_REQUEST_HEADERS: [&str; 6] = [
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "proxy-connection",
    "transfer-encoding",
];
const SKIP_RESPONSE_HEADERS: [&str; 4] = [
    "connection",
    "content-length",
    "transfer-encoding",
    "content-encoding",
];

fn server() -> &'static Mutex<Option<tauri::async_runtime::JoinHandle<()>>> {
    static SERVER: OnceLock<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    SERVER.get_or_init(|| Mutex::new(None))
}

fn upstream_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .build()
            .expect("failed to build config proxy client")
    })
}

pub fn is_running() -> bool {
    server().lock().unwrap().is_some()
}

fn app() -> Router {
    Router::new()
        .route(HEALTH_PATH, get(|| async { StatusCode::NO_CONTENT }))
        .fallback(proxy)
}

pub async fn verify_ready(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}{HEALTH_PATH}");
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Could not create client-config health check: {e}"))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Local client-config server is not ready at {url}: {e}"))?;
    if response.status() != StatusCode::NO_CONTENT {
        return Err(format!(
            "Local client-config server returned {} at {url}",
            response.status()
        ));
    }
    Ok(())
}

/// Binds 127.0.0.1:`port` and serves until `stop`. Idempotent: a second call
/// while already running is a no-op rather than an error, so the launch button
/// can call it unconditionally.
pub async fn start(port: u16) -> Result<(), String> {
    if is_running() {
        return Ok(());
    }

    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|e| format!("Could not bind 127.0.0.1:{port}: {e}"))?;

    let app = app();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("client config server stopped: {e}");
        }
    });

    *server().lock().unwrap() = Some(handle);
    log::info!("client config server listening on http://127.0.0.1:{port}");
    Ok(())
}

pub fn stop() {
    if let Some(handle) = server().lock().unwrap().take() {
        handle.abort();
    }
}

async fn proxy(request: Request) -> Response {
    match forward(request).await {
        Ok(response) => response,
        Err(error) => {
            log::error!("config proxy error: {error}");
            // 502 rather than a partial body: the client retries, and a
            // truncated config is worse than none.
            Response::builder()
                .status(502)
                .body(Body::from(error))
                .unwrap()
        }
    }
}

async fn forward(request: Request) -> Result<Response, String> {
    let method = request.method().clone();
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_string();
    let headers = request.headers().clone();

    let body = axum::body::to_bytes(request.into_body(), usize::MAX)
        .await
        .map_err(|e| format!("reading request body: {e}"))?;

    let url = format!("{UPSTREAM}{path_and_query}");
    let mut outbound = upstream_client().request(method, &url);
    for (name, value) in headers.iter() {
        if !SKIP_REQUEST_HEADERS.contains(&name.as_str()) {
            outbound = outbound.header(name, value);
        }
    }
    if !body.is_empty() {
        outbound = outbound.body(body.to_vec());
    }

    let upstream = outbound
        .send()
        .await
        .map_err(|e| format!("upstream request failed: {e}"))?;
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let bytes = upstream
        .bytes()
        .await
        .map_err(|e| format!("reading upstream body: {e}"))?;

    let bytes = if status.is_success() {
        patch_response(
            &path_and_query,
            bytes.to_vec(),
            headers.get("authorization"),
        )
        .await
    } else {
        bytes.to_vec()
    };

    let mut builder = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        if !SKIP_RESPONSE_HEADERS.contains(&name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(Body::from(bytes))
        .map_err(|e| format!("building response: {e}"))
}

struct PatchedConfig {
    json: Value,
    upstream: Option<crate::presence_proxy::UpstreamTarget>,
}

fn patch_config_json(
    body: &[u8],
    relay_port: u16,
    affinity: Option<&str>,
) -> Result<PatchedConfig, String> {
    let mut json: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let port = json
        .get("chat.port")
        .and_then(Value::as_u64)
        .unwrap_or(5223) as u16;
    let fallback = json
        .get("chat.host")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let affinity_host = affinity.and_then(|key| {
        json.get("chat.affinities")?
            .get(key)?
            .as_str()
            .map(str::to_owned)
    });
    let upstream = affinity_host
        .or(fallback)
        .map(|host| crate::presence_proxy::UpstreamTarget {
            host,
            port,
            affinity: affinity.map(str::to_owned),
        });

    json["chat.host"] = json!(LOCAL_CHAT_HOST);
    json["chat.port"] = json!(relay_port);
    if let Some(values) = json
        .get_mut("chat.affinities")
        .and_then(Value::as_object_mut)
    {
        for value in values.values_mut() {
            *value = json!(LOCAL_CHAT_HOST);
        }
    }

    Ok(PatchedConfig { json, upstream })
}

fn decode_pas_affinity(token: &str) -> Result<String, String> {
    let payload = token.split('.').nth(1).ok_or("PAS response is not a JWT")?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(payload))
        .map_err(|e| format!("PAS JWT payload decode failed: {e}"))?;
    let claims: Value = serde_json::from_slice(&decoded)
        .map_err(|e| format!("PAS JWT payload is not JSON: {e}"))?;
    claims
        .get("affinity")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "PAS JWT has no affinity claim".into())
}

async fn resolve_affinity(authorization: &HeaderValue) -> Result<String, String> {
    let response = upstream_client()
        .get(PAS_CHAT_URL)
        .header("authorization", authorization.clone())
        .send()
        .await
        .map_err(|e| format!("PAS affinity request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "PAS affinity request failed with {}",
            response.status()
        ));
    }
    let token = response
        .text()
        .await
        .map_err(|e| format!("PAS affinity response failed: {e}"))?;
    decode_pas_affinity(&token)
}

async fn patch_response(
    _path: &str,
    body: Vec<u8>,
    authorization: Option<&HeaderValue>,
) -> Vec<u8> {
    let Some(relay_port) = crate::presence_proxy::controller().relay_port() else {
        return body;
    };
    let affinity = match authorization {
        Some(value) => match resolve_affinity(value).await {
            Ok(affinity) => Some(affinity),
            Err(error) => {
                crate::presence_proxy::controller().set_warning(Some(error));
                None
            }
        },
        None => None,
    };
    let Ok(patched) = patch_config_json(&body, relay_port, affinity.as_deref()) else {
        return body;
    };
    if let Some(upstream) = patched.upstream {
        crate::presence_proxy::controller().set_upstream(upstream);
    }
    serde_json::to_vec(&patched.json).unwrap_or(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_endpoint_reports_ready() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(listener, app()).await.unwrap();
        });

        verify_ready(port).await.unwrap();
        server.abort();
    }

    #[test]
    fn patches_chat_config_and_selects_affinity() {
        let input = br#"{
            "chat.host":"fallback.chat.si.riotgames.com",
            "chat.port":5223,
            "chat.affinities":{"na1":"na2.chat.si.riotgames.com"},
            "unrelated":"kept"
        }"#;
        let result = patch_config_json(input, 43123, Some("na1")).unwrap();

        assert_eq!(
            result.json["chat.host"],
            "deceive-localhost.molenzwiebel.xyz"
        );
        assert_eq!(result.json["chat.port"], 43123);
        assert_eq!(
            result.json["chat.affinities"]["na1"],
            "deceive-localhost.molenzwiebel.xyz"
        );
        assert!(result.json.get("chat.allow_bad_cert.enabled").is_none());
        assert_eq!(result.json["unrelated"], "kept");
        assert_eq!(
            result.upstream,
            Some(crate::presence_proxy::UpstreamTarget {
                host: "na2.chat.si.riotgames.com".into(),
                port: 5223,
                affinity: Some("na1".into()),
            })
        );
    }

    #[test]
    fn malformed_body_is_not_patched() {
        assert!(patch_config_json(b"temporary upstream error", 43123, None).is_err());
    }

    #[test]
    fn decodes_affinity_from_pas_jwt() {
        assert_eq!(
            decode_pas_affinity("header.eyJhZmZpbml0eSI6Im5hMSJ9.signature").unwrap(),
            "na1"
        );
    }
}
