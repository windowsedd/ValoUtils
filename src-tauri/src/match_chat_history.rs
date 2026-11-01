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
    /// Filled once from match-details after the match ends; absent until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    details: Option<MatchDetails>,
}

/// What the history picker shows for a saved match, kept in the JSON so the
/// match-details request happens once per match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchDetails {
    map_id: String,
    queue_id: String,
    game_mode: String,
    /// The saved account's agent; empty when it isn't on the scoreboard.
    agent_id: String,
    /// `None` when Riot reported no team result for the account.
    won: Option<bool>,
    rounds_won: u64,
    rounds_lost: u64,
    start_millis: u64,
}

fn is_match_uuid(uuid: &str) -> bool {
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Reduces a match-details document to [`MatchDetails`] for `owner`.
/// `None` when it has no map, which means it isn't a finished match document.
fn summarize(details: &Value, owner: &str) -> Option<MatchDetails> {
    let info = details.get("matchInfo")?;
    let text = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let map_id = text(info, "mapId");
    if map_id.is_empty() {
        return None;
    }
    let me = details
        .get("players")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|player| {
            player
                .get("subject")
                .and_then(Value::as_str)
                .is_some_and(|subject| !owner.is_empty() && subject.eq_ignore_ascii_case(owner))
        });
    let team_id = me.map(|player| text(player, "teamId")).unwrap_or_default();
    let teams: Vec<&Value> = details
        .get("teams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let mine = teams
        .iter()
        .find(|team| !team_id.is_empty() && text(team, "teamId") == team_id);
    let rounds = |team: &Value| team.get("roundsWon").and_then(Value::as_u64).unwrap_or(0);
    Some(MatchDetails {
        map_id,
        queue_id: text(info, "queueID"),
        game_mode: text(info, "gameMode"),
        agent_id: me
            .map(|player| text(player, "characterId").to_ascii_lowercase())
            .unwrap_or_default(),
        won: mine.and_then(|team| team.get("won").and_then(Value::as_bool)),
        rounds_won: mine.map(|team| rounds(team)).unwrap_or(0),
        rounds_lost: if mine.is_some() {
            teams
                .iter()
                .filter(|team| text(team, "teamId") != team_id)
                .map(|team| rounds(team))
                .max()
                .unwrap_or(0)
        } else {
            0
        },
        start_millis: info
            .get("gameStartMillis")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

fn match_uuid(cid: &str) -> Option<String> {
    let (room, domain) = cid.split_once('@')?;
    if !domain.starts_with("ares-coregame.") {
        return None;
    }
    let uuid = ["-blue", "-red", "-all"]
        .iter()
        .find_map(|suffix| room.strip_suffix(suffix))?;
    if !is_match_uuid(uuid) {
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
                    details: None,
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

/// Replaces the file through a temporary copy, so a failed write keeps the old one.
fn write(path: &Path, archive: &Archive) -> Result<(), String> {
    let bytes = serde_json::to_vec(archive).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)
        .map_err(|e| format!("Cannot save match chat history: {e}"))?;
    std::fs::rename(&temporary, path).map_err(|e| format!("Cannot save match chat history: {e}"))
}

#[derive(Debug, PartialEq)]
enum DetailsLookup {
    /// The account has no saved chat for this match.
    NotSaved,
    Saved(MatchDetails),
    Needed,
}

fn lookup_details(path: &Path, owner: &str, uuid: &str) -> Result<DetailsLookup, String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let archive = read(path)?;
    Ok(
        match archive
            .accounts
            .get(owner)
            .and_then(|account| account.get(uuid))
        {
            None => DetailsLookup::NotSaved,
            Some(saved) => match &saved.details {
                Some(details) => DetailsLookup::Saved(details.clone()),
                None => DetailsLookup::Needed,
            },
        },
    )
}

/// Adds details to a match still saved for `owner`. Returns false (and writes
/// nothing) when Clear or another account removed it while the request ran.
fn store_details(
    path: &Path,
    owner: &str,
    uuid: &str,
    details: &MatchDetails,
) -> Result<bool, String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut archive = read(path)?;
    let Some(saved) = archive
        .accounts
        .get_mut(owner)
        .and_then(|account| account.get_mut(uuid))
    else {
        return Ok(false);
    };
    if saved.details.as_ref() == Some(details) {
        return Ok(true);
    }
    saved.details = Some(details.clone());
    write(path, &archive)?;
    Ok(true)
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
        write(path, &archive)?;
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

/// Map, mode, agent and result for a saved match, from the JSON when it is
/// already there, otherwise fetched once from match-details and saved.
/// Only matches the signed-in account has saved can be looked up.
#[tauri::command]
pub async fn chat_saved_match_details(
    args: Vec<Value>,
    riot: tauri::State<'_, crate::riot::client::RiotState>,
) -> Result<Value, ()> {
    let uuid = args
        .first()
        .and_then(Value::as_str)
        .map(|uuid| uuid.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !is_match_uuid(&uuid) {
        return Ok(
            serde_json::json!({"success": false, "matchUuid": uuid, "error": "Invalid match id"}),
        );
    }
    let path = crate::store::user_data_dir().join("match-chat-history.json");
    let result = crate::riot::api::with_api(&riot, |api| {
        let (uuid, path) = (uuid.clone(), path.clone());
        async move {
            match lookup_details(&path, &api.puuid, &uuid)? {
                DetailsLookup::NotSaved => return Ok(None),
                DetailsLookup::Saved(details) => return Ok(Some(details)),
                DetailsLookup::Needed => {}
            }
            let document = api.get_match_details(&uuid).await?;
            let details = summarize(&document, &api.puuid)
                .ok_or_else(|| "Riot has no finished match details yet.".to_string())?;
            Ok(store_details(&path, &api.puuid, &uuid, &details)?.then_some(details))
        }
    })
    .await;
    Ok(match result {
        Ok(Some(details)) => {
            serde_json::json!({"success": true, "matchUuid": uuid, "details": details})
        }
        Ok(None) => serde_json::json!({
            "success": false, "matchUuid": uuid, "error": "This match is not in saved chat history."
        }),
        Err(error) if error.is_login_required() => {
            serde_json::json!({"success": false, "matchUuid": uuid, "code": "loginRequired"})
        }
        Err(error) => match crate::commands::rate_limited_reply(&error.to_string()).await {
            Some(mut reply) => {
                reply["matchUuid"] = serde_json::json!(uuid);
                reply
            }
            None => serde_json::json!({"success": false, "matchUuid": uuid, "error": error}),
        },
    })
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

    fn document(owner_team: &str) -> Value {
        json!({
            "matchInfo": {"mapId": "/Game/Maps/Ascent/Ascent", "queueID": "competitive",
                "gameMode": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C", "gameStartMillis": 1700},
            "players": [
                {"subject": "ME", "teamId": owner_team, "characterId": "ADD6443A-41BD-E414-F6AD-E58D267F4E95"},
                {"subject": "them", "teamId": "Red", "characterId": "x"}
            ],
            "teams": [
                {"teamId": "Blue", "won": true, "roundsWon": 13},
                {"teamId": "Red", "won": false, "roundsWon": 9}
            ]
        })
    }

    #[test]
    fn summarizes_map_mode_agent_and_result_for_the_owner() {
        let details = summarize(&document("Blue"), "me").unwrap();
        assert_eq!(details.map_id, "/Game/Maps/Ascent/Ascent");
        assert_eq!(details.queue_id, "competitive");
        assert_eq!(details.agent_id, "add6443a-41bd-e414-f6ad-e58d267f4e95");
        assert_eq!(
            (details.won, details.rounds_won, details.rounds_lost),
            (Some(true), 13, 9)
        );
        assert_eq!(details.start_millis, 1700);
        let lost = summarize(&document("Red"), "me").unwrap();
        assert_eq!(
            (lost.won, lost.rounds_won, lost.rounds_lost),
            (Some(false), 9, 13)
        );
        let absent = summarize(&document("Blue"), "someone-else").unwrap();
        assert_eq!((absent.agent_id.as_str(), absent.won), ("", None));
        assert!(summarize(&json!({"matchInfo": {"mapId": ""}}), "me").is_none());
    }

    #[test]
    fn details_are_saved_once_per_owned_match_and_survive_reload() {
        let dir =
            std::env::temp_dir().join(format!("valoutils-chat-details-{}", std::process::id()));
        let path = dir.join("history.json");
        update(&path, "me", &[line("blue", "a")], || true).unwrap();
        assert_eq!(
            lookup_details(&path, "me", MATCH).unwrap(),
            DetailsLookup::Needed
        );
        assert_eq!(
            lookup_details(&path, "other", MATCH).unwrap(),
            DetailsLookup::NotSaved
        );
        let details = summarize(&document("Blue"), "me").unwrap();
        assert!(!store_details(&path, "other", MATCH, &details).unwrap());
        assert!(store_details(&path, "me", MATCH, &details).unwrap());
        assert_eq!(
            lookup_details(&path, "me", MATCH).unwrap(),
            DetailsLookup::Saved(details.clone())
        );
        // A later chat capture keeps the details.
        let matches = update(&path, "me", &[line("all", "b")], || true).unwrap();
        assert_eq!(matches[0].details.as_ref(), Some(&details));
        assert_eq!(matches[0].messages.len(), 2);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn older_history_without_details_still_loads() {
        let archive: Archive = serde_json::from_value(json!({"accounts": {"me": {MATCH: {
            "matchUuid": MATCH, "updatedAt": 1, "messages": []
        }}}}))
        .unwrap();
        assert!(archive.accounts["me"][MATCH].details.is_none());
        assert!(!serde_json::to_string(&archive).unwrap().contains("details"));
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
