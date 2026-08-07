//! Localhost HTTP host for the Riot Client's OpenAPI document.
//!
//! Replaces the previous "write a temp `.html` file and open `file:///…`"
//! approach: the spec is served as a real endpoint instead of being baked
//! into a page. Two routes, on an ephemeral port bound to `127.0.0.1` only:
//!
//!   - `GET /openapi.json` — the live spec, re-fetched from the running Riot
//!     Client on every request (so a client restart/update is picked up by a
//!     browser refresh, not an app restart).
//!   - `GET /` — a Scalar API reference pointing at `/openapi.json`.
//!
//! The `/` route is markup by necessity — no browser renders an OpenAPI
//! document without a viewer — but it is a served response, not a file on
//! disk, and it carries no spec data itself; it only references the endpoint.
//! Anything that wants the raw document (curl, Postman, another viewer) can
//! hit `/openapi.json` directly.
//!
//! Written directly on `tokio::net` rather than pulling in a web framework:
//! the crate already depends on tokio (`net`/`io-util`), the surface is two
//! GET routes, and adding axum/warp for that would be a much larger
//! dependency change than the feature warrants.

use std::sync::OnceLock;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::riot::client::{self, RiotState};

/// Port the docs server is listening on, once started. The server outlives
/// the command that spawned it, so repeated "open" clicks reuse it rather
/// than binding a new port each time.
static PORT: OnceLock<u16> = OnceLock::new();

/// Start the server if it isn't running yet and return its base URL.
pub async fn ensure_running(app: &AppHandle) -> Result<String, String> {
    if let Some(port) = PORT.get() {
        return Ok(format!("http://127.0.0.1:{port}"));
    }

    // Bind to port 0 — the OS picks a free ephemeral port. Loopback only, so
    // the spec is never exposed off-machine.
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // Lost race (another call bound first): drop this listener and use theirs.
    if let Err(existing) = PORT.set(port) {
        drop(listener);
        return Ok(format!("http://127.0.0.1:{existing}"));
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle_connection(stream, &app).await;
            });
        }
    });

    Ok(format!("http://127.0.0.1:{port}"))
}

async fn handle_connection(mut stream: TcpStream, app: &AppHandle) -> std::io::Result<()> {
    let path = match read_request_path(&mut stream).await? {
        Some(path) => path,
        None => return write_response(&mut stream, 400, "text/plain; charset=utf-8", b"Bad Request").await,
    };

    // Ignore the query string / fragment when routing.
    let route = path.split(['?', '#']).next().unwrap_or("/");

    match route {
        "/openapi.json" => {
            let state = app.state::<RiotState>();
            match client::swagger_spec(&state).await {
                Ok(spec) => {
                    let body = spec.to_string();
                    write_response(&mut stream, 200, "application/json; charset=utf-8", body.as_bytes()).await
                }
                Err(e) => {
                    let body = serde_json::json!({ "error": e }).to_string();
                    write_response(&mut stream, 502, "application/json; charset=utf-8", body.as_bytes()).await
                }
            }
        }
        "/" => write_response(&mut stream, 200, "text/html; charset=utf-8", REFERENCE_PAGE.as_bytes()).await,
        _ => write_response(&mut stream, 404, "text/plain; charset=utf-8", b"Not Found").await,
    }
}

/// Read the request head and return the request target from its start line.
/// Only the path is needed — headers are consumed and discarded, and the body
/// is irrelevant for the two GET routes.
async fn read_request_path(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..read]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        // Guard against an unbounded head from a malformed client.
        if buf.len() > 16 * 1024 {
            return Ok(None);
        }
    }

    let head = String::from_utf8_lossy(&buf);
    let Some(start_line) = head.lines().next() else {
        return Ok(None);
    };
    let mut parts = start_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if method != "GET" || target.is_empty() {
        return Ok(None);
    }
    Ok(Some(target.to_string()))
}

async fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Bad Gateway",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

#[cfg(test)]
mod tests {
    //! Covers the hand-rolled HTTP framing/parsing. The route table itself is
    //! exercised against a live Riot Client, which tests can't assume.

    use super::{read_request_path, write_response};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// Drive one request/response exchange over a real loopback socket.
    async fn round_trip(request: &str) -> (Option<String>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let request = request.to_string();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            response
        });

        let (mut server, _) = listener.accept().await.unwrap();
        let path = read_request_path(&mut server).await.unwrap();
        write_response(&mut server, 200, "application/json; charset=utf-8", b"{\"ok\":true}")
            .await
            .unwrap();
        drop(server);

        (path, client.await.unwrap())
    }

    #[tokio::test]
    async fn parses_the_target_and_frames_the_response() {
        let (path, response) =
            round_trip("GET /openapi.json?v=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: */*\r\n\r\n").await;

        assert_eq!(path.as_deref(), Some("/openapi.json?v=1"));
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
        assert!(response.contains("Content-Length: 11\r\n"), "{response}");
        assert!(response.ends_with("\r\n\r\n{\"ok\":true}"), "{response}");
    }

    #[tokio::test]
    async fn rejects_non_get_methods() {
        let (path, _) = round_trip("POST /openapi.json HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(path.is_none());
    }
}

/// Scalar viewer, pointed at the `/openapi.json` route by relative URL — the
/// page holds no spec content of its own.
const REFERENCE_PAGE: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Riot Client API</title>
  <style>body{margin:0}</style>
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#app', {
      url: '/openapi.json',
      forceDarkModeState: 'dark',
      hideDarkModeToggle: true,
      hideClientButton: true,
      hideTestRequestButton: true,
    })
  </script>
</body>
</html>"#;
