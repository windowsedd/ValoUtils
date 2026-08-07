use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const APP_KEY: &str = "A-US-3830100076";

static SESSION_ID: OnceLock<String> = OnceLock::new();

fn region_base_url(app_key: &str) -> &'static str {
    if app_key.starts_with("A-EU-") {
        "https://eu.aptabase.com"
    } else if app_key.starts_with("A-DEV-") {
        "http://localhost:3000"
    } else {
        "https://us.aptabase.com"
    }
}

fn iso8601_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d, h, mi, s) = crate::util_time::civil_from_unix_secs(secs);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn session_id() -> &'static str {
    SESSION_ID.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{nanos:x}")
    })
}

/// Fire-and-forget event ingest matching @aptabase/electron's payload shape.
/// Spawned onto its own task; failures are logged, never surfaced to callers.
pub fn track_event(event_name: String, props: Value, app_version: String) {
    tauri::async_runtime::spawn(async move {
        let timestamp = iso8601_now();

        let body = json!({
            "timestamp": timestamp,
            "sessionId": session_id(),
            "eventName": event_name,
            "systemProps": {
                "osName": std::env::consts::OS,
                "appVersion": app_version,
                "sdkVersion": "valoutils-rust-1.0.0",
            },
            "props": props,
        });

        let url = format!("{}/api/v0/event", region_base_url(APP_KEY));
        let client = reqwest::Client::new();
        if let Err(err) = client
            .post(url)
            .header("App-Key", APP_KEY)
            .json(&body)
            .send()
            .await
        {
            log::warn!("aptabase track_event failed: {err}");
        }
    });
}
