pub mod client;
pub mod presence;
pub mod regions;

use crate::riot::api;
use crate::riot::client::RiotState;
use client::{ChatMessage, XmppHandle};
use presence::{PresenceReducer, PresenceSignal, PresenceSnapshot, PresenceSyncState};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{broadcast, Mutex};

const PARTY_ROOM_MARKER: &str = "ares-parties";
static MESSAGE_EVENTS: std::sync::OnceLock<broadcast::Sender<ChatMessage>> =
    std::sync::OnceLock::new();

pub fn message_publisher() -> broadcast::Sender<ChatMessage> {
    MESSAGE_EVENTS
        .get_or_init(|| broadcast::channel(256).0)
        .clone()
}

pub fn subscribe_messages() -> broadcast::Receiver<ChatMessage> {
    message_publisher().subscribe()
}

struct PresenceRuntime {
    next_generation: AtomicU64,
    settle_token: AtomicU64,
    roster_generation: AtomicU64,
    reducer: StdMutex<PresenceReducer>,
    signal_tx: broadcast::Sender<PresenceSignal>,
    snapshot_tx: broadcast::Sender<PresenceSnapshot>,
}

impl PresenceRuntime {
    fn new() -> Self {
        let (signal_tx, _) = broadcast::channel(2048);
        let (snapshot_tx, _) = broadcast::channel(256);
        Self {
            next_generation: AtomicU64::new(0),
            settle_token: AtomicU64::new(0),
            roster_generation: AtomicU64::new(0),
            reducer: StdMutex::new(PresenceReducer::default()),
            signal_tx,
            snapshot_tx,
        }
    }

    fn begin_generation(&self) -> u64 {
        let generation = self.next_generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.settle_token.fetch_add(1, Ordering::AcqRel);
        self.roster_generation.store(0, Ordering::Release);
        let snapshot = {
            let mut reducer = self.reducer.lock().unwrap();
            reducer.begin_generation(generation);
            reducer.snapshot()
        };
        let _ = self.snapshot_tx.send(snapshot);
        generation
    }

    fn apply_signal(&self, signal: PresenceSignal) -> bool {
        let snapshot = {
            let mut reducer = self.reducer.lock().unwrap();
            if !reducer.apply(signal) {
                return false;
            }
            reducer.snapshot()
        };
        let _ = self.snapshot_tx.send(snapshot);
        true
    }

    fn mark_ready(&self, generation: u64) {
        let snapshot = {
            let mut reducer = self.reducer.lock().unwrap();
            if !reducer.mark_ready(generation) {
                return;
            }
            reducer.snapshot()
        };
        let _ = self.snapshot_tx.send(snapshot);
    }

    fn snapshot(&self) -> PresenceSnapshot {
        self.reducer.lock().unwrap().snapshot()
    }
}

static PRESENCE_RUNTIME: std::sync::OnceLock<PresenceRuntime> = std::sync::OnceLock::new();
static PRESENCE_REDUCER_STARTED: AtomicBool = AtomicBool::new(false);

fn presence_runtime() -> &'static PresenceRuntime {
    PRESENCE_RUNTIME.get_or_init(PresenceRuntime::new)
}

fn signal_generation(signal: &PresenceSignal) -> u64 {
    match signal {
        PresenceSignal::RosterReceived { generation, .. }
        | PresenceSignal::Available { generation, .. }
        | PresenceSignal::Unavailable { generation, .. }
        | PresenceSignal::Disconnected { generation } => *generation,
    }
}

fn schedule_presence_ready(runtime: &'static PresenceRuntime, generation: u64) {
    let token = runtime.settle_token.fetch_add(1, Ordering::AcqRel) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if runtime.settle_token.load(Ordering::Acquire) == token
            && runtime.roster_generation.load(Ordering::Acquire) == generation
        {
            runtime.mark_ready(generation);
        }
    });
}

fn ensure_presence_reducer() {
    if PRESENCE_REDUCER_STARTED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let runtime = presence_runtime();
    let mut receiver = runtime.signal_tx.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(signal) => {
                    let generation = signal_generation(&signal);
                    let is_roster = matches!(signal, PresenceSignal::RosterReceived { .. });
                    let is_disconnect = matches!(signal, PresenceSignal::Disconnected { .. });
                    if !runtime.apply_signal(signal) {
                        continue;
                    }
                    if is_disconnect {
                        runtime.settle_token.fetch_add(1, Ordering::AcqRel);
                        runtime.roster_generation.store(0, Ordering::Release);
                        continue;
                    }
                    if is_roster {
                        runtime
                            .roster_generation
                            .store(generation, Ordering::Release);
                    }
                    let snapshot = runtime.snapshot();
                    if snapshot.state == PresenceSyncState::Syncing
                        && runtime.roster_generation.load(Ordering::Acquire) == generation
                    {
                        schedule_presence_ready(runtime, generation);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("XMPP presence reducer lagged by {skipped} events");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn presence_signal_publisher() -> broadcast::Sender<PresenceSignal> {
    ensure_presence_reducer();
    presence_runtime().signal_tx.clone()
}

pub fn subscribe_presence() -> broadcast::Receiver<PresenceSnapshot> {
    presence_runtime().snapshot_tx.subscribe()
}

pub fn presence_snapshot() -> PresenceSnapshot {
    presence_runtime().snapshot()
}

#[derive(Default)]
struct Inner {
    handle: Option<Arc<XmppHandle>>,
    joined_rooms: HashSet<String>,
    party_rooms: HashSet<String>,
    match_team_room: String,
    match_all_room: String,
    party_room: String,
    match_id: String,
    party_id: String,
    own_puuid: String,
    own_display_name: String,
}

/// Module-level singleton mirroring electron/util/riot/xmpp-chat.ts's
/// module-level `state` object.
#[derive(Default)]
struct ChatXmppState {
    inner: Mutex<Inner>,
}

async fn login_xmpp(riot: &RiotState, inner: &mut Inner) -> Result<Arc<XmppHandle>, String> {
    if let Some(handle) = &inner.handle {
        if handle.is_alive() {
            return Ok(handle.clone());
        }
    }

    let tokens = crate::riot::client::get_tokens(riot, false).await?;
    let access_token = tokens
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let entitlement_token = tokens
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let puuid = tokens
        .get("subject")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    inner.own_puuid = puuid.to_string();

    let generation = presence_runtime().begin_generation();
    let result = match client::login(
        access_token,
        entitlement_token,
        puuid,
        message_publisher(),
        generation,
        presence_signal_publisher(),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let _ = presence_signal_publisher().send(PresenceSignal::Disconnected { generation });
            return Err(error);
        }
    };
    if let Some((name, tagline)) = &result.display_name {
        inner.own_display_name = if tagline.is_empty() {
            name.clone()
        } else {
            format!("{name}#{tagline}")
        };
    }
    inner.handle = Some(result.handle.clone());
    Ok(result.handle)
}

pub async fn ensure_connected(riot: &RiotState) -> Result<(), String> {
    let mut inner = STATE.get_or_init(Default::default).inner.lock().await;
    login_xmpp(riot, &mut inner).await.map(|_| ())
}

pub async fn disconnect_match_xmpp_chat() {
    let state = STATE.get_or_init(Default::default);
    let mut inner = state.inner.lock().await;
    if let Some(handle) = inner.handle.take() {
        for room in inner.joined_rooms.iter() {
            let _ = handle.leave_match_muc(room).await;
        }
        handle.end().await;
    }
    *inner = Inner::default();
}

/// Ensures the client is in the current match's team/all MUC rooms. Returns
/// (teamRoom, allRoom). Mirrors ensureMatchXmppChat in xmpp-chat.ts.
pub async fn ensure_match_xmpp_chat(
    riot: &RiotState,
) -> Result<(Option<String>, Option<String>), String> {
    let api = api::create_api(riot).await?;
    let mut state_guard = STATE.get_or_init(Default::default).inner.lock().await;

    let core_player = api.coregame_get_player(&api.puuid).await.ok();
    let match_id = core_player
        .as_ref()
        .and_then(|p| p.get("MatchID"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let Some(match_id) = match_id else {
        // Left the match — leave match rooms but keep party connection alive.
        if let Some(handle) = state_guard.handle.clone() {
            let to_leave: Vec<String> = state_guard
                .joined_rooms
                .difference(&state_guard.party_rooms)
                .cloned()
                .collect();
            for room in to_leave {
                let _ = handle.leave_match_muc(&room).await;
                state_guard.joined_rooms.remove(&room);
            }
        }
        state_guard.match_team_room.clear();
        state_guard.match_all_room.clear();
        state_guard.match_id.clear();
        return Ok((None, None));
    };

    if !state_guard.match_id.is_empty() && state_guard.match_id != match_id {
        if let Some(handle) = state_guard.handle.clone() {
            let to_leave: Vec<String> = state_guard
                .joined_rooms
                .difference(&state_guard.party_rooms)
                .cloned()
                .collect();
            for room in to_leave {
                let _ = handle.leave_match_muc(&room).await;
                state_guard.joined_rooms.remove(&room);
            }
        }
        state_guard.match_team_room.clear();
        state_guard.match_all_room.clear();
    }

    let match_data = api.coregame_get_match(&match_id).await?;
    let team_room = match_data
        .get("TeamMUCName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let all_room = match_data
        .get("AllMUCName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let token = match_data.get("TeamMatchToken").and_then(|v| v.as_str());

    state_guard.match_id = match_id;
    state_guard.match_team_room = team_room.clone().unwrap_or_default();
    state_guard.match_all_room = all_room.clone().unwrap_or_default();

    let handle = login_xmpp(riot, &mut state_guard).await?;
    for room in [&team_room, &all_room].into_iter().flatten() {
        if !state_guard.joined_rooms.contains(room) {
            handle.join_match_muc(room, token).await?;
            state_guard.joined_rooms.insert(room.clone());
        }
    }

    Ok((team_room, all_room))
}

/// Ensures the client is in the current party's MUC room. Returns
/// (room, debugInfo). Mirrors ensurePartyXmppChat in xmpp-chat.ts.
pub async fn ensure_party_xmpp_chat(riot: &RiotState) -> (String, Value) {
    let mut debug = serde_json::Map::new();

    let api = match api::create_api(riot).await {
        Ok(api) => api,
        Err(e) => {
            debug.insert("error".into(), json!(e));
            return (String::new(), Value::Object(debug));
        }
    };
    debug.insert("puuid".into(), json!(api.puuid));
    debug.insert("region".into(), json!(api.region));

    let mut state_guard = STATE.get_or_init(Default::default).inner.lock().await;

    let party_player = api.party_get_by_player(&api.puuid).await.ok();
    let party_id = party_player
        .as_ref()
        .and_then(|p| p.get("CurrentPartyID").or_else(|| p.get("PartyID")))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    debug.insert("partyId".into(), json!(party_id));

    if party_id.is_empty() {
        state_guard.party_room.clear();
        state_guard.party_id.clear();
        return (String::new(), Value::Object(debug));
    }

    if state_guard.party_id == party_id
        && !state_guard.party_room.is_empty()
        && state_guard.joined_rooms.contains(&state_guard.party_room)
    {
        debug.insert("cached".into(), json!(true));
        return (state_guard.party_room.clone(), Value::Object(debug));
    }

    let chat_token = api.party_get_chat_token(&party_id).await.ok();
    let room = chat_token
        .as_ref()
        .and_then(|c| c.get("Room").or_else(|| c.get("room")))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let token = chat_token
        .as_ref()
        .and_then(|c| c.get("Token").or_else(|| c.get("token")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if room.is_empty() {
        state_guard.party_id = party_id;
        return (String::new(), Value::Object(debug));
    }

    state_guard.party_id = party_id;
    state_guard.party_room = room.clone();
    state_guard.party_rooms.insert(room.clone());

    let handle = match login_xmpp(riot, &mut state_guard).await {
        Ok(handle) => handle,
        Err(e) => {
            debug.insert("error".into(), json!(e));
            return (String::new(), Value::Object(debug));
        }
    };
    if !state_guard.joined_rooms.contains(&room) {
        if let Err(e) = handle.join_match_muc(&room, token.as_deref()).await {
            debug.insert("error".into(), json!(e));
            return (String::new(), Value::Object(debug));
        }
        state_guard.joined_rooms.insert(room.clone());
        debug.insert("joined".into(), json!(true));
    } else {
        debug.insert("alreadyJoined".into(), json!(true));
    }

    (room, Value::Object(debug))
}

/// Currently buffered XMPP messages with `isSelf` resolved against the
/// logged-in puuid (the background reader doesn't know it).
pub async fn get_xmpp_messages() -> Vec<ChatMessage> {
    let state_guard = STATE.get_or_init(Default::default).inner.lock().await;
    let Some(handle) = &state_guard.handle else {
        return Vec::new();
    };
    let own_puuid = state_guard.own_puuid.clone();
    let own_display_name = state_guard.own_display_name.clone();
    let mut messages = handle.messages.lock().unwrap().clone();
    for m in messages.iter_mut() {
        m.is_self = m.sender == own_puuid;
        if m.is_self {
            m.sender_name = if own_display_name.is_empty() {
                m.sender.clone()
            } else {
                own_display_name.clone()
            };
        }
    }
    messages.into()
}

async fn push_own_message(state_guard: &mut Inner, room: &str, message: &str, scope: &str) {
    let handle = &state_guard.handle;
    if let Some(handle) = handle {
        let mut buf = handle.messages.lock().unwrap();
        buf.push_back(ChatMessage {
            id: format!("{room}:{}:{}", state_guard.own_puuid, chrono_millis()),
            conversation_id: room.to_string(),
            sender: state_guard.own_puuid.clone(),
            sender_name: if state_guard.own_display_name.is_empty() {
                state_guard.own_puuid.clone()
            } else {
                state_guard.own_display_name.clone()
            },
            body: message.to_string(),
            timestamp: chrono_iso_now(),
            msg_type: "groupchat".into(),
            scope: scope.into(),
            is_self: true,
        });
    }
}

pub async fn send_match_xmpp_message(
    riot: &RiotState,
    room: &str,
    message: &str,
) -> Result<(), String> {
    let mut state_guard = STATE.get_or_init(Default::default).inner.lock().await;
    let handle = login_xmpp(riot, &mut state_guard).await?;
    if !state_guard.joined_rooms.contains(room) {
        drop(state_guard);
        ensure_match_xmpp_chat(riot).await?;
        state_guard = STATE.get_or_init(Default::default).inner.lock().await;
    }
    handle.send_muc_message(room, message).await?;
    push_own_message(
        &mut state_guard,
        room,
        message,
        if room.to_lowercase().contains(PARTY_ROOM_MARKER) {
            "party"
        } else {
            "match"
        },
    )
    .await;
    Ok(())
}

pub async fn send_party_xmpp_message(
    riot: &RiotState,
    room: &str,
    message: &str,
) -> Result<(), String> {
    let mut state_guard = STATE.get_or_init(Default::default).inner.lock().await;
    let handle = login_xmpp(riot, &mut state_guard).await?;
    if !state_guard.joined_rooms.contains(room) {
        drop(state_guard);
        ensure_party_xmpp_chat(riot).await;
        state_guard = STATE.get_or_init(Default::default).inner.lock().await;
    }
    handle.send_muc_message(room, message).await?;
    push_own_message(&mut state_guard, room, message, "party").await;
    Ok(())
}

fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn chrono_iso_now() -> String {
    let (y, m, d, h, mi, s) = crate::util_time::civil_from_unix_secs(chrono_millis() / 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

// Module-level singleton (rather than Tauri-managed state) so the free
// functions above (ensure_match_xmpp_chat, etc.) don't all need a State<>
// parameter threaded through — mirrors the original file's module-level
// `state` object closely.
static STATE: std::sync::OnceLock<ChatXmppState> = std::sync::OnceLock::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_connection_generation_starts_with_empty_syncing_snapshot() {
        let runtime = PresenceRuntime::new();
        let first = runtime.begin_generation();
        runtime.apply_signal(presence::PresenceSignal::Available {
            generation: first,
            resource: presence::FriendPresenceResource {
                puuid: "friend".into(),
                resource: "RC-1".into(),
                product: "riot_client".into(),
                status: "chat".into(),
                status_message: String::new(),
                session_loop_state: String::new(),
                private: json!({}),
            },
            replace_resource: false,
        });

        let second = runtime.begin_generation();
        let snapshot = runtime.snapshot();
        assert!(second > first);
        assert_eq!(snapshot.generation, second);
        assert_eq!(snapshot.state, presence::PresenceSyncState::Syncing);
        assert!(snapshot.friends.is_empty());
    }

    #[test]
    fn signal_channel_holds_a_full_multi_product_roster_burst() {
        let runtime = PresenceRuntime::new();
        let mut receiver = runtime.signal_tx.subscribe();
        for index in 0..600 {
            runtime
                .signal_tx
                .send(presence::PresenceSignal::Disconnected { generation: index })
                .unwrap();
        }

        assert!(matches!(
            receiver.try_recv(),
            Ok(presence::PresenceSignal::Disconnected { generation: 0 })
        ));
    }
}
