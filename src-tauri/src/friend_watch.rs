//! Watched friends: a toast and Windows notification when a starred friend
//! starts a match and when it ends, with the score.
//!
//! The score comes from the friend's chat presence (`partyOwnerMatchScore*`),
//! read from the local Riot Client every few seconds while anyone is watched.
//! That is a local request, so it costs nothing from Riot's online budget.
//! The final score is the last one presence reported, which can trail the
//! real end by a round if the friend leaves the match screen quickly.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::store::ConfigStore;

const POLL: Duration = Duration::from_secs(10);
pub const CONFIG_KEY: &str = "watchedFriends";

/// What a watched friend was last seen doing.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Seen {
    pub name: String,
    pub in_match: bool,
    pub map: String,
    pub queue: String,
    pub ally: Option<i64>,
    pub enemy: Option<i64>,
}

#[derive(Debug, PartialEq)]
pub enum Change {
    Started,
    Ended,
}

/// What changed between two sightings; nothing on the first one, so opening
/// the app mid-match doesn't announce a start.
pub fn change(before: Option<&Seen>, now: &Seen) -> Option<Change> {
    let before = before?;
    match (before.in_match, now.in_match) {
        (false, true) => Some(Change::Started),
        (true, false) => Some(Change::Ended),
        _ => None,
    }
}

/// The notification line for a change, given readable map and mode names.
pub fn message(change: &Change, seen: &Seen, map: &str, mode: &str) -> String {
    let place = match (map.is_empty(), mode.is_empty()) {
        (false, false) => format!(" · {mode} on {map}"),
        (false, true) => format!(" on {map}"),
        (true, false) => format!(" · {mode}"),
        (true, true) => String::new(),
    };
    match change {
        Change::Started => format!("{} started a match{place}", seen.name),
        Change::Ended => match (seen.ally, seen.enemy) {
            (Some(ally), Some(enemy)) if ally + enemy > 0 => {
                let result = match ally.cmp(&enemy) {
                    std::cmp::Ordering::Greater => "won",
                    std::cmp::Ordering::Less => "lost",
                    std::cmp::Ordering::Equal => "drew",
                };
                format!("{} {result} {ally}–{enemy}{place}", seen.name)
            }
            _ => format!("{} finished a match{place}", seen.name),
        },
    }
}

pub fn watched(config: &ConfigStore) -> Vec<String> {
    config
        .get(CONFIG_KEY)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_ascii_lowercase)
        .collect()
}

/// The current sighting of every watched friend in the presence list.
fn sightings(presences: &[Value], watched: &[String]) -> HashMap<String, Seen> {
    let mut seen: HashMap<String, Seen> = HashMap::new();
    for presence in presences {
        let Some(puuid) = crate::commands::friends::presence_puuid(presence) else { continue };
        if !watched.contains(&puuid) {
            continue;
        }
        let text = |key: &str| presence.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let name = match (text("game_name"), text("game_tag")) {
            (name, _) if name.is_empty() => "A friend".to_string(),
            (name, tag) if tag.is_empty() => name,
            (name, tag) => format!("{name}#{tag}"),
        };
        let entry = seen.entry(puuid).or_insert_with(|| Seen { name: name.clone(), ..Seen::default() });
        // One player has a presence per Riot product; the game's one says the most.
        if let Some(game) = crate::commands::friends::valorant_presence_public(presence) {
            let field = |key: &str| game.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
            *entry = Seen {
                name,
                in_match: field("sessionLoopState").eq_ignore_ascii_case("INGAME"),
                map: field("matchMap"),
                queue: field("queueId"),
                ally: game.get("allyScore").and_then(Value::as_i64),
                enemy: game.get("enemyScore").and_then(Value::as_i64),
            };
        }
    }
    seen
}

fn notify(app: &AppHandle, text: &str) {
    let _ = app.emit("alert:info", text);
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app.notification().builder().title("ValoUtils").body(text).show() {
        log::warn!("Could not show a Windows notification: {error}");
    }
}

/// Runs for the life of the app; idles while nobody is watched.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last: HashMap<String, Seen> = HashMap::new();
        loop {
            tokio::time::sleep(POLL).await;
            let list = watched(&app.state::<ConfigStore>());
            if list.is_empty() {
                last.clear();
                continue;
            }
            let riot = app.state::<crate::riot::client::RiotState>();
            let Ok(presences) = crate::riot::client::get_presences(&riot).await else {
                continue;
            };
            let now = sightings(&presences, &list);
            let (_, maps) = crate::commands::bot_template::content_names().await;
            for puuid in &list {
                // Missing from presence means offline: treat as out of a match.
                let current = now.get(puuid).cloned().unwrap_or_else(|| Seen {
                    name: last.get(puuid).map(|seen| seen.name.clone()).unwrap_or_default(),
                    ..Seen::default()
                });
                // An end is reported with the score from the last in-match sighting.
                let shown = if current.in_match { current.clone() } else { last.get(puuid).cloned().unwrap_or_default() };
                if let Some(change) = change(last.get(puuid), &current) {
                    let map_key = shown.map.to_ascii_lowercase();
                    let map = maps
                        .get(&map_key)
                        .or_else(|| map_key.rsplit('/').find(|part| !part.is_empty()).and_then(|key| maps.get(key)))
                        .cloned()
                        .unwrap_or_default();
                    let mode = crate::commands::bot_template::mode_label_public(&shown.queue);
                    let mut named = shown.clone();
                    if named.name.is_empty() {
                        named.name = current.name.clone();
                    }
                    let text = message(&change, &named, &map, &mode);
                    log::info!("Watched friend: {text}");
                    notify(&app, &text);
                    let _ = app.emit("friends:watch", json!({ "puuid": puuid, "text": text }));
                }
                last.insert(puuid.clone(), current);
            }
            last.retain(|puuid, _| list.contains(puuid));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(in_match: bool, ally: Option<i64>, enemy: Option<i64>) -> Seen {
        Seen { name: "Duo#NA1".into(), in_match, ally, enemy, ..Seen::default() }
    }

    #[test]
    fn changes_need_a_previous_sighting() {
        assert_eq!(change(None, &seen(true, None, None)), None);
        assert_eq!(change(Some(&seen(false, None, None)), &seen(true, None, None)), Some(Change::Started));
        assert_eq!(change(Some(&seen(true, Some(3), Some(2))), &seen(false, None, None)), Some(Change::Ended));
        assert_eq!(change(Some(&seen(true, Some(3), Some(2))), &seen(true, Some(4), Some(2))), None);
    }

    #[test]
    fn messages_read_naturally() {
        assert_eq!(message(&Change::Started, &seen(true, None, None), "Ascent", "Competitive"), "Duo#NA1 started a match · Competitive on Ascent");
        assert_eq!(message(&Change::Ended, &seen(true, Some(13), Some(9)), "Ascent", ""), "Duo#NA1 won 13–9 on Ascent");
        assert_eq!(message(&Change::Ended, &seen(true, Some(5), Some(13)), "", ""), "Duo#NA1 lost 5–13");
        assert_eq!(message(&Change::Ended, &seen(true, Some(0), Some(0)), "", "Deathmatch"), "Duo#NA1 finished a match · Deathmatch");
    }
}
