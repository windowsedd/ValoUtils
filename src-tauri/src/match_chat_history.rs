use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::sync::Mutex;

static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
struct Archive {
    accounts: BTreeMap<String, BTreeMap<String, SavedMatch>>,
    /// Riot IDs by lowercase PUUID, for account owners and speakers, so saved
    /// history stays readable while signed out or on another account.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    names: BTreeMap<String, String>,
    /// Matches the player removed, as `owner:matchUuid`, so capture never saves
    /// them again from Riot's chat backlog while saving stays on.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    removed: BTreeSet<String>,
}

fn removed_key(owner: &str, match_uuid: &str) -> String {
    format!("{}:{}", owner.to_ascii_lowercase(), match_uuid.to_ascii_lowercase())
}

fn looks_like_puuid(value: &str) -> bool {
    is_match_uuid(value)
}

impl Archive {
    /// Deletes one saved match and remembers it so capture skips it. Returns
    /// whether it was saved. An account left with no matches is dropped.
    fn remove_match(&mut self, owner: &str, match_uuid: &str) -> bool {
        let uuid = match_uuid.to_ascii_lowercase();
        let found = match self.accounts.get_mut(owner) {
            Some(matches) => {
                let found = matches.remove(&uuid).is_some();
                if matches.is_empty() {
                    self.accounts.remove(owner);
                }
                found
            }
            None => false,
        };
        self.removed.insert(removed_key(owner, &uuid));
        found
    }

    /// Owners and speakers whose Riot ID isn't known yet.
    fn unnamed(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for (owner, matches) in &self.accounts {
            ids.push(owner.to_ascii_lowercase());
            for saved in matches.values() {
                for message in &saved.messages {
                    if let Some(sender) = message.get("sender").and_then(Value::as_str) {
                        ids.push(sender_root(sender));
                    }
                }
            }
        }
        ids.sort();
        ids.dedup();
        ids.retain(|id| looks_like_puuid(id) && !self.names.contains_key(id));
        ids
    }

    /// Every account with saved chat, most recently saved first.
    fn account_list(&self) -> Vec<Value> {
        let mut accounts: Vec<Value> = self
            .accounts
            .iter()
            .filter(|(_, matches)| !matches.is_empty())
            .map(|(owner, matches)| {
                serde_json::json!({
                    "puuid": owner,
                    "name": self.names.get(&owner.to_ascii_lowercase()),
                    "matchCount": matches.len(),
                    "updatedAt": matches.values().map(|saved| saved.updated_at).max().unwrap_or(0),
                })
            })
            .collect();
        accounts.sort_by_key(|account| std::cmp::Reverse(account["updatedAt"].as_u64().unwrap_or(0)));
        accounts
    }

    /// Names for one account's owner and speakers.
    fn names_for(&self, owner: &str) -> BTreeMap<String, String> {
        let mut wanted = vec![owner.to_ascii_lowercase()];
        for saved in self.accounts.get(owner).into_iter().flat_map(|matches| matches.values()) {
            for message in &saved.messages {
                if let Some(sender) = message.get("sender").and_then(Value::as_str) {
                    wanted.push(sender_root(sender));
                }
            }
        }
        wanted
            .into_iter()
            .filter_map(|id| self.names.get(&id).map(|name| (id, name.clone())))
            .collect()
    }
}

/// `GameName#Tag` entries from a name-service reply, by lowercase PUUID.
fn names_from_reply(reply: &Value) -> BTreeMap<String, String> {
    reply
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let subject = entry.get("Subject")?.as_str()?.to_ascii_lowercase();
            let name = entry.get("GameName")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let tag = entry.get("TagLine").and_then(Value::as_str).unwrap_or_default().trim();
            Some((subject, if tag.is_empty() { name.to_string() } else { format!("{name}#{tag}") }))
        })
        .collect()
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
    /// Riot ID and agent of each speaker, taken from the Live Game roster
    /// when their line was captured, so saved chat names them without a
    /// match-details request (or a signed-in account).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    speakers: Vec<SavedSpeaker>,
}

/// The Live Game roster for one match, as captured lines are matched against it.
#[derive(Clone, Debug, Default)]
pub struct LiveRoster {
    match_uuid: String,
    players: Vec<SavedSpeaker>,
}

/// Players of a pregame or coregame Live Game snapshot. Incognito players keep
/// their agent but not their name, as Riot hides it in game.
fn live_roster(snapshot: &Value) -> Option<LiveRoster> {
    if !matches!(snapshot.get("state").and_then(Value::as_str), Some("pregame" | "coregame")) {
        return None;
    }
    let match_uuid = snapshot.pointer("/match/id")?.as_str()?.to_ascii_lowercase();
    if !is_match_uuid(&match_uuid) {
        return None;
    }
    let text = |player: &Value, key: &str| {
        player.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
    };
    let players = snapshot
        .get("players")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|player| {
            let puuid = text(player, "puuid").to_ascii_lowercase();
            if puuid.is_empty() {
                return None;
            }
            let incognito = player.get("incognito").and_then(Value::as_bool).unwrap_or(false);
            let (game_name, tag) = (text(player, "gameName"), text(player, "tagLine"));
            let name = match (incognito || game_name.is_empty(), tag.is_empty()) {
                (true, _) => String::new(),
                (false, true) => game_name,
                (false, false) => format!("{game_name}#{tag}"),
            };
            let agent_id = text(player, "characterId").to_ascii_lowercase();
            (!name.is_empty() || !agent_id.is_empty()).then_some(SavedSpeaker { puuid, name, agent_id })
        })
        .collect();
    Some(LiveRoster { match_uuid, players })
}

/// The roster Live Game last resolved, while it is recent.
pub fn current_roster(app: &tauri::AppHandle) -> Option<LiveRoster> {
    use tauri::Manager;
    live_roster(&app.state::<crate::commands::live::LiveCache>().recent_snapshot()?)
}

/// Adds or fills in one speaker; known values are never blanked.
fn remember_speaker(speakers: &mut Vec<SavedSpeaker>, player: &SavedSpeaker) -> bool {
    let Some(known) = speakers.iter_mut().find(|known| known.puuid == player.puuid) else {
        speakers.push(player.clone());
        return true;
    };
    let mut changed = false;
    if !player.name.is_empty() && known.name != player.name {
        known.name = player.name.clone();
        changed = true;
    }
    if !player.agent_id.is_empty() && known.agent_id != player.agent_id {
        known.agent_id = player.agent_id.clone();
        changed = true;
    }
    changed
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
    /// Riot ID and agent of each player who wrote a saved line, so the saved
    /// thread can name them. `None` in history saved before this was kept,
    /// which makes the lookup run once more to fill it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    speakers: Option<Vec<SavedSpeaker>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSpeaker {
    /// Lowercase PUUID, matching the part of a line's `sender` before `@`.
    puuid: String,
    /// `GameName#Tag`, or empty when Riot left it out.
    name: String,
    /// Lowercase agent UUID.
    agent_id: String,
}

/// The PUUID part of a chat `sender`, lowercased.
fn sender_root(sender: &str) -> String {
    sender.split('@').next().unwrap_or_default().to_ascii_lowercase()
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
        // Every player for now; `store_details` keeps only those who spoke.
        speakers: Some(
            details
                .get("players")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|player| {
                    let puuid = text(player, "subject").to_ascii_lowercase();
                    if puuid.is_empty() {
                        return None;
                    }
                    let game_name = text(player, "gameName");
                    let tag = text(player, "tagLine");
                    let name = match (game_name.is_empty(), tag.is_empty()) {
                        (true, _) => String::new(),
                        (false, true) => game_name,
                        (false, false) => format!("{game_name}#{tag}"),
                    };
                    Some(SavedSpeaker {
                        puuid,
                        name,
                        agent_id: text(player, "characterId").to_ascii_lowercase(),
                    })
                })
                .collect(),
        ),
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
    fn capture(&mut self, owner: &str, messages: &[Value], roster: Option<&LiveRoster>) -> bool {
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
            if self.removed.contains(&removed_key(owner, &uuid)) {
                continue;
            }
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
                    speakers: Vec::new(),
                });
            let speaker = roster
                .filter(|roster| roster.match_uuid == saved.match_uuid)
                .and_then(|roster| {
                    let sender = message.get("sender").and_then(Value::as_str).map(sender_root)?;
                    roster.players.iter().find(|player| player.puuid == sender)
                });
            if let Some(speaker) = speaker {
                changed |= remember_speaker(&mut saved.speakers, speaker);
                if !speaker.name.is_empty() && !self.names.contains_key(&speaker.puuid) {
                    self.names.insert(speaker.puuid.clone(), speaker.name.clone());
                    changed = true;
                }
            }
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
                Some(details) if details.speakers.is_some() => DetailsLookup::Saved(details.clone()),
                _ => DetailsLookup::Needed,
            },
        },
    )
}

/// Adds details to a match still saved for `owner`, keeping only the speakers
/// who wrote a saved line, and returns what was stored. `None` (and nothing
/// written) when Clear or another account removed it while the request ran.
fn store_details(
    path: &Path,
    owner: &str,
    uuid: &str,
    details: &MatchDetails,
) -> Result<Option<MatchDetails>, String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut archive = read(path)?;
    let Some(saved) = archive
        .accounts
        .get_mut(owner)
        .and_then(|account| account.get_mut(uuid))
    else {
        return Ok(None);
    };
    let senders: HashSet<String> = saved
        .messages
        .iter()
        .filter_map(|message| message.get("sender").and_then(Value::as_str))
        .map(sender_root)
        .collect();
    let mut details = details.clone();
    if let Some(speakers) = details.speakers.as_mut() {
        speakers.retain(|speaker| senders.contains(&speaker.puuid));
    }
    if saved.details.as_ref() != Some(&details) {
        saved.details = Some(details.clone());
        write(path, &archive)?;
    }
    Ok(Some(details))
}

fn update(
    path: &Path,
    owner: &str,
    messages: &[Value],
    roster: Option<&LiveRoster>,
    enabled: impl FnOnce() -> bool,
) -> Result<Vec<SavedMatch>, String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut archive = read(path)?;
    // Check under FILE_LOCK, so an in-flight capture cannot undo Clear history.
    if enabled() && archive.capture(owner, messages, roster) {
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

/// Saves captured Team/All lines, naming their speakers from `roster`
/// ([`current_roster`]) when it belongs to the same match.
pub fn capture(
    owner: &str,
    messages: &[Value],
    roster: Option<&LiveRoster>,
    config: &crate::store::ConfigStore,
) -> Result<Vec<SavedMatch>, String> {
    update(
        &crate::store::user_data_dir().join("match-chat-history.json"),
        owner,
        messages,
        roster,
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
            store_details(&path, &api.puuid, &uuid, &details)
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

const NAME_BATCH: usize = 100;

fn history_path() -> std::path::PathBuf {
    crate::store::user_data_dir().join("match-chat-history.json")
}

/// Every account with saved match chat on this PC, with its Riot ID. While
/// signed in, missing owner and speaker names are looked up in batches through
/// the name service and saved, so later reads need no request.
#[tauri::command]
pub async fn chat_saved_history_accounts(
    riot: tauri::State<'_, crate::riot::client::RiotState>,
) -> Result<Value, ()> {
    let path = history_path();
    let unnamed = {
        let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        match read(&path) {
            Ok(archive) => archive.unnamed(),
            Err(error) => return Ok(serde_json::json!({ "success": false, "error": error })),
        }
    };
    if !unnamed.is_empty() {
        let looked_up = crate::riot::api::with_api(&riot, |api| {
            let unnamed = unnamed.clone();
            async move {
                let mut names = BTreeMap::new();
                for batch in unnamed.chunks(NAME_BATCH) {
                    let reply = api
                        .get_names(batch)
                        .await
                        .map_err(crate::riot::error::RiotError::Other)?;
                    names.extend(names_from_reply(&reply));
                }
                Ok(names)
            }
        })
        .await;
        match looked_up {
            Ok(names) if !names.is_empty() => {
                let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                if let Ok(mut archive) = read(&path) {
                    archive.names.extend(names);
                    if let Err(error) = write(&path, &archive) {
                        log::warn!("Could not save chat history names: {error}");
                    }
                }
            }
            Ok(_) => {}
            // Signed out or rate limited: list the accounts with the names already known.
            Err(error) => log::info!("Chat history names not looked up: {error}"),
        }
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(match read(&path) {
        Ok(archive) => serde_json::json!({ "success": true, "accounts": archive.account_list() }),
        Err(error) => serde_json::json!({ "success": false, "error": error }),
    })
}

/// One account's saved matches and the known names of its owner and speakers.
/// Local only, so it works signed out and for accounts other than the current one.
#[tauri::command]
pub fn chat_saved_history_get(args: Vec<Value>) -> Value {
    let owner = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
    if owner.is_empty() {
        return serde_json::json!({ "success": false, "error": "No account given." });
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match read(&history_path()) {
        Ok(archive) => {
            let mut matches: Vec<SavedMatch> = archive
                .accounts
                .get(&owner)
                .into_iter()
                .flat_map(|account| account.values().cloned())
                .collect();
            matches.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.match_uuid.cmp(&b.match_uuid)));
            serde_json::json!({
                "success": true,
                "owner": owner,
                "matches": matches,
                "names": archive.names_for(&owner),
            })
        }
        Err(error) => serde_json::json!({ "success": false, "error": error }),
    }
}

/// `args: [owner, matchUuid]`: deletes one saved match chat on this PC. It is
/// not saved again later, even while saving stays on.
#[tauri::command]
pub fn chat_saved_history_remove(args: Vec<Value>) -> Value {
    let text = |index: usize| args.get(index).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let (owner, uuid) = (text(0), text(1).to_ascii_lowercase());
    if owner.is_empty() || !is_match_uuid(&uuid) {
        return serde_json::json!({ "success": false, "error": "No saved match given." });
    }
    match remove_saved(&history_path(), &owner, &uuid) {
        Ok(removed) => serde_json::json!({ "success": true, "removed": removed }),
        Err(error) => serde_json::json!({ "success": false, "error": error }),
    }
}

fn remove_saved(path: &Path, owner: &str, uuid: &str) -> Result<bool, String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut archive = read(path)?;
    let removed = archive.remove_match(owner, uuid);
    write(path, &archive)?;
    Ok(removed)
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

    const SPEAKER: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    fn snapshot(state: &str, match_id: &str, players: Value) -> Value {
        json!({"success": true, "state": state, "match": {"id": match_id}, "players": players})
    }
    fn spoken_by(id: &str, sender: &str) -> Value {
        let mut message = line("all", id);
        message["sender"] = json!(format!("{sender}@ap1.pvp.net"));
        message
    }

    #[test]
    fn live_roster_keeps_names_and_agents_but_hides_incognito_names() {
        let roster = live_roster(&snapshot("coregame", &MATCH.to_uppercase(), json!([
            {"puuid": SPEAKER.to_uppercase(), "gameName": "Duo", "tagLine": "NA1", "characterId": "AGENT-1"},
            {"puuid": "p2", "gameName": "Hidden", "tagLine": "X", "incognito": true, "characterId": "agent-2"},
            {"puuid": "p3", "gameName": "", "characterId": null},
        ])))
        .unwrap();
        assert_eq!(roster.match_uuid, MATCH);
        assert_eq!(roster.players, vec![
            SavedSpeaker { puuid: SPEAKER.into(), name: "Duo#NA1".into(), agent_id: "agent-1".into() },
            SavedSpeaker { puuid: "p2".into(), name: String::new(), agent_id: "agent-2".into() },
        ]);
        assert!(live_roster(&snapshot("party", MATCH, json!([]))).is_none());
        assert!(live_roster(&snapshot("coregame", "not-a-match", json!([]))).is_none());
    }

    #[test]
    fn capture_saves_speaker_names_and_agents_from_the_same_match_only() {
        let roster = live_roster(&snapshot("coregame", MATCH, json!([
            {"puuid": SPEAKER, "gameName": "Duo", "tagLine": "NA1", "characterId": ""},
            {"puuid": "silent", "gameName": "Quiet", "tagLine": "1", "characterId": "agent-9"},
        ])))
        .unwrap();
        let mut archive = Archive::default();
        assert!(archive.capture("me", &[spoken_by("a", SPEAKER)], Some(&roster)));
        let saved = &archive.accounts["me"][MATCH];
        assert_eq!(saved.speakers, vec![SavedSpeaker { puuid: SPEAKER.into(), name: "Duo#NA1".into(), agent_id: String::new() }]);
        assert_eq!(archive.names[SPEAKER], "Duo#NA1");

        // A later roster fills the agent in on a line already saved, without blanking the name.
        let mut later = roster.clone();
        later.players[0] = SavedSpeaker { puuid: SPEAKER.into(), name: String::new(), agent_id: "agent-1".into() };
        assert!(archive.capture("me", &[spoken_by("a", SPEAKER)], Some(&later)));
        assert_eq!(archive.accounts["me"][MATCH].speakers[0].name, "Duo#NA1");
        assert_eq!(archive.accounts["me"][MATCH].speakers[0].agent_id, "agent-1");
        assert!(!archive.capture("me", &[spoken_by("a", SPEAKER)], Some(&later)));

        // Another match's roster is never applied.
        let mut other = roster.clone();
        other.match_uuid = "99999999-2222-3333-4444-555555555555".into();
        let mut fresh = Archive::default();
        fresh.capture("me", &[spoken_by("a", SPEAKER)], Some(&other));
        assert!(fresh.accounts["me"][MATCH].speakers.is_empty());
        assert!(fresh.names.is_empty());
    }

    #[test]
    fn groups_team_and_all_by_match_uuid_without_duplicates() {
        let mut archive = Archive::default();
        archive.capture("me", &[line("blue", "a"), line("all", "b")], None);
        archive.capture("me", &[line("blue", "a")], None);
        assert_eq!(archive.accounts["me"].len(), 1);
        assert_eq!(archive.accounts["me"][MATCH].messages.len(), 2);
        assert_eq!(archive.accounts["me"][MATCH].match_uuid, MATCH);
        assert!(!archive.accounts.contains_key("other"));
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
            archive.capture("me", &[json!({"id": "a", "conversationId": cid})], None);
        }
        assert!(archive.accounts.is_empty());
        archive.capture("", &[line("blue", "a")], None);
        assert!(archive.accounts.is_empty());
    }

    #[test]
    fn saved_json_survives_reload_and_keeps_accounts_separate() {
        let mut archive = Archive::default();
        archive.capture("me", &[line("blue", "a")], None);
        archive.capture("other", &[line("red", "b")], None);
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
        archive.capture("me", &[first], None);
        let mut alias = line("blue", "a");
        alias["conversationId"] = json!(format!("{MATCH}-blue@ares-coregame.ap"));
        alias["senderName"] = json!("Name#TAG");
        archive.capture("me", &[alias], None);
        assert_eq!(archive.accounts["me"][MATCH].messages.len(), 1);
        assert_eq!(
            archive.accounts["me"][MATCH].messages[0]["senderName"],
            "Name#TAG"
        );
    }

    #[test]
    fn removing_a_match_keeps_the_others() {
        let mut archive = Archive::default();
        let other = "99999999-2222-3333-4444-555555555555";
        let mut elsewhere = line("all", "x");
        elsewhere["conversationId"] = json!(format!("{other}-all@ares-coregame.ap.pvp.net"));
        archive.capture("me", &[line("blue", "a"), elsewhere], None);
        assert!(archive.remove_match("me", &MATCH.to_ascii_uppercase()));
        assert!(!archive.accounts["me"].contains_key(MATCH));
        assert!(archive.accounts["me"].contains_key(other));
    }

    #[test]
    fn a_removed_match_is_not_saved_again() {
        let mut archive = Archive::default();
        archive.capture("me", &[line("blue", "a")], None);
        archive.remove_match("me", MATCH);
        assert!(!archive.capture("me", &[line("blue", "a"), line("all", "b")], None));
        assert!(!archive.accounts.contains_key("me"));
    }

    #[test]
    fn removal_only_applies_to_its_own_account() {
        let mut archive = Archive::default();
        archive.remove_match("me", MATCH);
        archive.capture("other", &[line("blue", "a")], None);
        assert!(archive.accounts["other"].contains_key(MATCH));
    }

    #[test]
    fn removal_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("valoutils-chat-remove-{}", std::process::id()));
        let path = dir.join("history.json");
        update(&path, "me", &[line("blue", "a")], None, || true).unwrap();
        assert!(remove_saved(&path, "me", MATCH).unwrap());
        assert!(update(&path, "me", &[line("blue", "a")], None, || true).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn opt_in_disk_storage_survives_restart_and_disabling_preserves_it() {
        let dir =
            std::env::temp_dir().join(format!("valoutils-chat-history-{}", std::process::id()));
        let path = dir.join("history.json");
        assert!(update(&path, "me", &[line("blue", "a")], None, || false)
            .unwrap()
            .is_empty());
        assert!(!path.exists());
        update(&path, "me", &[line("blue", "a")], None, || true).unwrap();
        assert_eq!(
            update(&path, "me", &[line("all", "b")], None, || false).unwrap()[0]
                .messages
                .len(),
            1
        );
        assert!(update(&path, "other", &[], None, || false).unwrap().is_empty());
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::write(&path, "broken JSON").unwrap();
        assert!(update(&path, "me", &[line("blue", "a")], None, || true).is_err());
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
        update(&path, "me", &[line("blue", "a")], None, || true).unwrap();
        assert_eq!(
            lookup_details(&path, "me", MATCH).unwrap(),
            DetailsLookup::Needed
        );
        assert_eq!(
            lookup_details(&path, "other", MATCH).unwrap(),
            DetailsLookup::NotSaved
        );
        let details = summarize(&document("Blue"), "me").unwrap();
        assert!(store_details(&path, "other", MATCH, &details).unwrap().is_none());
        let details = store_details(&path, "me", MATCH, &details).unwrap().unwrap();
        assert_eq!(
            lookup_details(&path, "me", MATCH).unwrap(),
            DetailsLookup::Saved(details.clone())
        );
        // A later chat capture keeps the details.
        let matches = update(&path, "me", &[line("all", "b")], None, || true).unwrap();
        assert_eq!(matches[0].details.as_ref(), Some(&details));
        assert_eq!(matches[0].messages.len(), 2);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn only_players_who_spoke_are_saved_and_older_details_are_looked_up_again() {
        let dir =
            std::env::temp_dir().join(format!("valoutils-chat-speakers-{}", std::process::id()));
        let path = dir.join("history.json");
        let mut spoken = line("blue", "a");
        spoken["sender"] = json!("THEM@ap.pvp.net");
        update(&path, "me", &[spoken], None, || true).unwrap();
        let mut document = document("Blue");
        document["players"][1]["gameName"] = json!("Enemy");
        document["players"][1]["tagLine"] = json!("NA1");
        let mut details = summarize(&document, "me").unwrap();
        assert_eq!(details.speakers.as_ref().unwrap().len(), 2);
        let stored = store_details(&path, "me", MATCH, &details).unwrap().unwrap();
        assert_eq!(
            stored.speakers,
            Some(vec![SavedSpeaker {
                puuid: "them".into(),
                name: "Enemy#NA1".into(),
                agent_id: "x".into(),
            }])
        );
        // Details saved before speakers were kept count as missing.
        details.speakers = None;
        let mut archive = read(&path).unwrap();
        archive.accounts.get_mut("me").unwrap().get_mut(MATCH).unwrap().details = Some(details);
        write(&path, &archive).unwrap();
        assert_eq!(lookup_details(&path, "me", MATCH).unwrap(), DetailsLookup::Needed);
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
        assert!(update(&path, "me", &[line("blue", "a")], None, current_setting)
            .unwrap()
            .is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn accounts_list_names_and_unnamed_speakers() {
        const OWNER: &str = "11111111-1111-1111-1111-111111111111";
        const SPEAKER: &str = "22222222-2222-2222-2222-222222222222";
        let mut archive = Archive::default();
        let mut spoken = line("blue", "a");
        spoken["sender"] = json!(format!("{SPEAKER}@ap1.pvp.net"));
        archive.capture(OWNER, &[spoken], None);
        assert_eq!(archive.unnamed(), [OWNER, SPEAKER]);
        archive.names.extend(names_from_reply(&json!([
            { "Subject": OWNER.to_uppercase(), "GameName": "Me", "TagLine": "NA1" },
            { "Subject": SPEAKER, "GameName": "", "TagLine": "x" },
        ])));
        assert_eq!(archive.unnamed(), [SPEAKER]);
        let accounts = archive.account_list();
        assert_eq!(accounts[0]["name"], "Me#NA1");
        assert_eq!(accounts[0]["matchCount"], 1);
        assert_eq!(archive.names_for(OWNER).get(OWNER).map(String::as_str), Some("Me#NA1"));
        // Names survive a save and reload; older files without them still load.
        let saved: Archive = serde_json::from_str(&serde_json::to_string(&archive).unwrap()).unwrap();
        assert_eq!(saved.names.len(), 1);
    }
}
