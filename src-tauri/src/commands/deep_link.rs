//! `valoutils://` links. Registered by the installer (and at runtime in dev
//! builds); a link opened while ValoUtils runs reaches the running window
//! through the single-instance plugin.
//!
//! - `valoutils://crosshair?code=<share code>&name=<label>`: Tools → Crosshair.
//! - `valoutils://player?riotId=<Name#Tag>` or `?puuid=<uuid>`: Tools → Player lookup.
//! - `valoutils://match?id=<match uuid>`: that match's scoreboard.
//!
//! Links are kept as pending until the frontend takes them, so one that
//! launched the app isn't lost before the page loads.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static PENDING: Mutex<Option<Value>> = Mutex::new(None);

const MAX_CODE: usize = 600;
const MAX_NAME: usize = 40;
/// Riot IDs are at most 16 + 1 + 5 characters; leave room for odd spacing.
const MAX_RIOT_ID: usize = 32;

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn query(url: &tauri::Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn crosshair(url: &tauri::Url) -> Option<Value> {
    let code: String = query(url, "code")?
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ';' | '.' | '-'))
        .take(MAX_CODE)
        .collect();
    if code.is_empty() {
        return None;
    }
    let name = query(url, "name")
        .map(|name| name.chars().filter(|c| !c.is_control()).take(MAX_NAME).collect::<String>());
    Some(json!({ "kind": "crosshair", "code": code, "name": name }))
}

fn player(url: &tauri::Url) -> Option<Value> {
    if let Some(puuid) = query(url, "puuid").filter(|id| is_uuid(id)) {
        return Some(json!({ "kind": "player", "query": puuid.to_ascii_lowercase() }));
    }
    let riot_id = query(url, "riotId")?;
    let (name, tag) = riot_id.rsplit_once('#')?;
    let valid = !name.trim().is_empty()
        && !tag.trim().is_empty()
        && riot_id.chars().count() <= MAX_RIOT_ID
        && !riot_id.chars().any(char::is_control);
    valid.then(|| json!({ "kind": "player", "query": riot_id }))
}

fn match_link(url: &tauri::Url) -> Option<Value> {
    let id = query(url, "id").filter(|id| is_uuid(id))?;
    Some(json!({ "kind": "match", "matchId": id.to_ascii_lowercase() }))
}

/// What a `valoutils://` link asks for, or `None` for anything unknown or malformed.
pub fn link_from_url(url: &tauri::Url) -> Option<Value> {
    if url.scheme() != "valoutils" {
        return None;
    }
    match url.host_str()? {
        "crosshair" => crosshair(url),
        "player" => player(url),
        "match" => match_link(url),
        _ => None,
    }
}

/// Handles a link the app was opened with.
pub fn open(app: &AppHandle, url: &tauri::Url) {
    let Some(link) = link_from_url(url) else {
        log::info!("Ignored an unknown valoutils:// link");
        return;
    };
    log::info!("Opened a valoutils:// {} link", link["kind"].as_str().unwrap_or("?"));
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(link.clone());
    let _ = app.emit("deep-link:open", link);
    crate::focus_main_window(app);
}

/// The last link not yet shown, cleared on read (for the page's first load).
#[tauri::command]
pub fn deep_link_take() -> Value {
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Option<Value> {
        link_from_url(&tauri::Url::parse(text).unwrap())
    }

    #[test]
    fn reads_crosshair_links() {
        let link = parse("valoutils://crosshair?code=0%3BP%3Bc%3B5%3Bh%3B0&name=Cyan%20dot").unwrap();
        assert_eq!(link["kind"], "crosshair");
        assert_eq!(link["code"], "0;P;c;5;h;0");
        assert_eq!(link["name"], "Cyan dot");
        let stripped = parse("valoutils://crosshair?code=0%3BP%3Cscript%3E").unwrap();
        assert_eq!(stripped["code"], "0;Pscript");
        assert!(parse("valoutils://crosshair?name=x").is_none());
    }

    #[test]
    fn reads_player_links_by_riot_id_or_puuid() {
        let by_id = parse("valoutils://player?riotId=Some%20Name%23NA1").unwrap();
        assert_eq!(by_id["query"], "Some Name#NA1");
        let by_puuid = parse("valoutils://player?puuid=ABCDEF01-2345-6789-ABCD-EF0123456789").unwrap();
        assert_eq!(by_puuid["query"], "abcdef01-2345-6789-abcd-ef0123456789");
        assert!(parse("valoutils://player?riotId=NoTag").is_none());
        assert!(parse("valoutils://player?puuid=not-a-uuid").is_none());
    }

    #[test]
    fn reads_match_links_and_rejects_everything_else() {
        let link = parse("valoutils://match?id=0b5c3f7e-1111-2222-3333-444455556666").unwrap();
        assert_eq!(link["kind"], "match");
        assert!(parse("valoutils://match?id=12345").is_none());
        assert!(parse("valoutils://party?code=ABC").is_none());
        assert!(parse("https://crosshair?code=0").is_none());
    }
}
