use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
struct Archive {
    accounts: BTreeMap<String, BTreeMap<String, SavedMatch>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMatch {
    match_uuid: String,
    updated_at: u64,
    messages: Vec<Value>,
}

fn match_uuid(cid: &str) -> Option<String> {
    let (room, domain) = cid.split_once('@')?;
    if !domain.starts_with("ares-coregame.") {
        return None;
    }
    let uuid = ["-blue", "-red", "-all"]
        .iter()
        .find_map(|suffix| room.strip_suffix(suffix))?;
    if uuid.len() != 36
        || !uuid.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    Some(uuid.to_ascii_lowercase())
}

impl Archive {
    fn capture(&mut self, owner: &str, messages: &[Value]) -> bool {
        if owner.is_empty() {
            return false;
        }
        let mut changed = false;
        for message in messages {
            let Some(uuid) = message
                .get("conversationId")
                .and_then(Value::as_str)
                .and_then(match_uuid)
            else {
                continue;
            };
            let saved = self
                .accounts
                .entry(owner.to_string())
                .or_default()
                .entry(uuid.clone())
                .or_insert_with(|| SavedMatch {
                    match_uuid: uuid,
                    updated_at: 0,
                    messages: Vec::new(),
                });
            let mut message = message.clone();
            if let Some(object) = message.as_object_mut() {
                object.remove("_raw");
            }
            let duplicate = saved.messages.iter_mut().find(|old| {
                old["conversationId"]
                    .as_str()
                    .and_then(|cid| cid.split('@').next())
                    == message["conversationId"]
                        .as_str()
                        .and_then(|cid| cid.split('@').next())
                    && if message["id"].as_str().is_some_and(|id| !id.is_empty()) {
                        old["id"] == message["id"]
                    } else {
                        old["timestamp"] == message["timestamp"]
                            && old["sender"] == message["sender"]
                            && old["body"] == message["body"]
                    }
            });
            if let Some(old) = duplicate {
                if message.get("round").is_some() && old.get("round").is_none() {
                    old["round"] = message["round"].clone();
                    changed = true;
                }
                let name = message["senderName"].as_str().unwrap_or_default();
                let old_name = old["senderName"].as_str().unwrap_or_default();
                if !name.is_empty()
                    && (old_name.is_empty() || old["senderName"] == old["sender"])
                    && name != old_name
                {
                    old["senderName"] = message["senderName"].clone();
                    changed = true;
                }
            } else {
                saved.updated_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                saved.messages.push(message);
                changed = true;
            }
        }
        changed
    }
}

fn read(path: &Path) -> Result<Archive, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Cannot read match chat history JSON.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Archive::default()),
        Err(error) => Err(format!("Cannot read match chat history: {error}")),
    }
}

fn update(
    path: &Path,
    owner: &str,
    messages: &[Value],
    enabled: impl FnOnce() -> bool,
) -> Result<Vec<SavedMatch>, String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut archive = read(path)?;
    // Check under FILE_LOCK, so an in-flight capture cannot undo Clear history.
    if enabled() && archive.capture(owner, messages) {
        let bytes = serde_json::to_vec(&archive).map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, bytes)
            .map_err(|e| format!("Cannot save match chat history: {e}"))?;
        std::fs::rename(&temporary, path)
            .map_err(|e| format!("Cannot save match chat history: {e}"))?;
    }
    let mut matches: Vec<_> = archive
        .accounts
        .get(owner)
        .into_iter()
        .flat_map(|account| account.values().cloned())
        .collect();
    matches.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.match_uuid.cmp(&b.match_uuid))
    });
    Ok(matches)
}

pub fn capture(
    owner: &str,
    messages: &[Value],
    config: &crate::store::ConfigStore,
) -> Result<Vec<SavedMatch>, String> {
    update(
        &crate::store::user_data_dir().join("match-chat-history.json"),
        owner,
        messages,
        || config.get("saveMatchChatHistory") == Some(serde_json::json!(true)),
    )
}

#[tauri::command]
pub fn chat_saved_history_clear(config: tauri::State<'_, crate::store::ConfigStore>) -> Value {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Stop saving first, so the poller cannot immediately restore its backlog.
    if let Err(error) = config.try_set("saveMatchChatHistory", serde_json::json!(false)) {
        return serde_json::json!({"success": false, "error": error});
    }
    match std::fs::remove_file(crate::store::user_data_dir().join("match-chat-history.json")) {
        Ok(()) => serde_json::json!({"success": true}),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({"success": true}),
        Err(e) => {
            serde_json::json!({"success": false, "error": format!("Cannot clear match chat history: {e}")})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MATCH: &str = "11111111-2222-3333-4444-555555555555";
    fn line(side: &str, id: &str) -> Value {
        json!({"id": id, "conversationId": format!("{MATCH}-{side}@ares-coregame.ap.pvp.net"),
            "body": id, "sender": "player", "timestamp": "1", "scope": "match"})
    }

    #[test]
    fn groups_team_and_all_by_match_uuid_without_duplicates() {
        let mut archive = Archive::default();
        archive.capture("me", &[line("blue", "a"), line("all", "b")]);
        archive.capture("me", &[line("blue", "a")]);
        assert_eq!(archive.accounts["me"].len(), 1);
        assert_eq!(archive.accounts["me"][MATCH].messages.len(), 2);
        assert_eq!(archive.accounts["me"][MATCH].match_uuid, MATCH);
        assert!(archive.accounts.get("other").is_none());
    }

    #[test]
    fn ignores_private_party_pregame_and_invalid_rooms() {
        let mut archive = Archive::default();
        for cid in [
            "friend@pvp.net",
            "party@ares-parties.ap",
            "invalid-blue@ares-coregame.ap",
            "11111111-2222-3333-4444-555555555555-blue@ares-pregame.ap",
        ] {
            archive.capture("me", &[json!({"id": "a", "conversationId": cid})]);
        }
        assert!(archive.accounts.is_empty());
        archive.capture("", &[line("blue", "a")]);
        assert!(archive.accounts.is_empty());
    }

    #[test]
    fn saved_json_survives_reload_and_keeps_accounts_separate() {
        let mut archive = Archive::default();
        archive.capture("me", &[line("blue", "a")]);
        archive.capture("other", &[line("red", "b")]);
        let restored: Archive =
            serde_json::from_str(&serde_json::to_string(&archive).unwrap()).unwrap();
        assert_eq!(restored.accounts["me"][MATCH].messages[0]["body"], "a");
        assert_eq!(restored.accounts["other"][MATCH].messages[0]["body"], "b");
    }

    #[test]
    fn aliases_do_not_duplicate_lines_and_later_names_enrich_history() {
        let mut archive = Archive::default();
        let mut first = line("blue", "a");
        first["senderName"] = json!("");
        archive.capture("me", &[first]);
        let mut alias = line("blue", "a");
        alias["conversationId"] = json!(format!("{MATCH}-blue@ares-coregame.ap"));
        alias["senderName"] = json!("Name#TAG");
        archive.capture("me", &[alias]);
        assert_eq!(archive.accounts["me"][MATCH].messages.len(), 1);
        assert_eq!(
            archive.accounts["me"][MATCH].messages[0]["senderName"],
            "Name#TAG"
        );
    }

    #[test]
    fn opt_in_disk_storage_survives_restart_and_disabling_preserves_it() {
        let dir =
            std::env::temp_dir().join(format!("valoutils-chat-history-{}", std::process::id()));
        let path = dir.join("history.json");
        assert!(update(&path, "me", &[line("blue", "a")], || false)
            .unwrap()
            .is_empty());
        assert!(!path.exists());
        update(&path, "me", &[line("blue", "a")], || true).unwrap();
        assert_eq!(
            update(&path, "me", &[line("all", "b")], || false).unwrap()[0]
                .messages
                .len(),
            1
        );
        assert!(update(&path, "other", &[], || false).unwrap().is_empty());
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::write(&path, "broken JSON").unwrap();
        assert!(update(&path, "me", &[line("blue", "a")], || true).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken JSON");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn capture_rechecks_opt_in_under_the_clear_lock() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let path = std::env::temp_dir().join(format!(
            "valoutils-history-disabled-{}.json",
            std::process::id()
        ));
        let enabled = AtomicBool::new(true);
        let current_setting = || {
            assert!(
                FILE_LOCK.try_lock().is_err(),
                "Opt-in must be checked under the same lock as Clear"
            );
            enabled.load(Ordering::SeqCst)
        };
        // A capture was queued while enabled, but Clear disabled it before its write.
        enabled.store(false, Ordering::SeqCst);
        assert!(update(&path, "me", &[line("blue", "a")], current_setting)
            .unwrap()
            .is_empty());
        assert!(!path.exists());
    }
}
