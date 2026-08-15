use crate::riot::api;
use crate::riot::client::{self as riot_client, is_login_required_error, RiotState};
use crate::store::ConfigStore;
use crate::translate;
use crate::xmpp;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, State};

static CHAT_FORWARDER_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn mark_chat_forwarder_started(flag: &std::sync::atomic::AtomicBool) -> bool {
    flag.compare_exchange(
        false,
        true,
        std::sync::atomic::Ordering::AcqRel,
        std::sync::atomic::Ordering::Acquire,
    )
    .is_ok()
}

fn presence_event_payload(
    snapshot: &xmpp::presence::PresenceSnapshot,
) -> Result<String, serde_json::Error> {
    serde_json::to_string(snapshot)
}

fn ensure_chat_forwarders(app: &AppHandle) {
    if !mark_chat_forwarder_started(&CHAT_FORWARDER_STARTED) {
        return;
    }
    let message_app = app.clone();
    let mut receiver = xmpp::subscribe_messages();
    tauri::async_runtime::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(message) => {
                    if let Ok(payload) = serde_json::to_string(&message) {
                        let _ = message_app.emit("chat:message", payload);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("chat message forwarder lagged by {skipped} messages");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let presence_app = app.clone();
    let mut presence_receiver = xmpp::subscribe_presence();
    tauri::async_runtime::spawn(async move {
        loop {
            match presence_receiver.recv().await {
                Ok(snapshot) => {
                    if let Ok(payload) = presence_event_payload(&snapshot) {
                        let _ = presence_app.emit("chat:presence", payload);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("chat presence forwarder lagged by {skipped} snapshots");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn arg(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn pick_string<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> String {
    for v in values {
        if let Some(s) = v {
            if !s.trim().is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

fn id_root(value: &str) -> String {
    value.split('@').next().unwrap_or(value).to_lowercase()
}

fn is_party_cid(value: &str) -> bool {
    value.to_lowercase().contains("@ares-parties.")
}

fn get_send_type(conversation_id: &str) -> &'static str {
    let lower = conversation_id.to_lowercase();
    if lower.contains("@ares-parties.")
        || lower.contains("@ares-pregame.")
        || lower.contains("@ares-coregame.")
        || lower.contains("@ares-")
    {
        "groupchat"
    } else {
        "chat"
    }
}

fn conversations_array(payload: &Value) -> Vec<Value> {
    payload
        .get("conversations")
        .or_else(|| payload.get("Conversations"))
        .or_else(|| payload.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn collect_conversation_ids(payload: &Value) -> HashSet<String> {
    conversations_array(payload)
        .iter()
        .filter_map(|c| {
            let id = pick_string(
                [
                    c.get("cid"),
                    c.get("id"),
                    c.get("conversationId"),
                    c.get("ConversationID"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            (!id.is_empty()).then_some(id)
        })
        .collect()
}

fn normalize_conversation_map(payload: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for c in conversations_array(payload) {
        let id = pick_string(
            [
                c.get("cid"),
                c.get("id"),
                c.get("conversationId"),
                c.get("ConversationID"),
            ]
            .map(|v| v.and_then(|v| v.as_str())),
        );
        if id.is_empty() {
            continue;
        }
        let label = [
            c.get("type"),
            c.get("Type"),
            c.get("name"),
            c.get("Name"),
            c.get("game_name"),
            c.get("resource"),
            c.get("channel"),
        ]
        .into_iter()
        .filter_map(|v| v.and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join(" ");
        map.insert(id, label);
    }
    map
}

fn channel_for_cid(cid: &str) -> &'static str {
    let value = cid.to_lowercase();
    if value.contains("@ares-parties.") {
        "party"
    } else if value.contains("-blue@ares-coregame.")
        || value.contains("-red@ares-coregame.")
        || value.contains("-blue@ares-pregame.")
        || value.contains("-red@ares-pregame.")
    {
        "team"
    } else if value.contains("-all@ares-coregame.") {
        "all"
    } else {
        "friends"
    }
}

fn normalize_conversations(payload: &Value) -> Vec<Value> {
    conversations_array(payload)
        .into_iter()
        .filter_map(|item| {
            let cid = pick_string(
                [
                    item.get("cid"),
                    item.get("id"),
                    item.get("conversationId"),
                    item.get("ConversationID"),
                ]
                .map(|value| value.and_then(|value| value.as_str())),
            );
            if cid.is_empty() {
                return None;
            }
            let channel = channel_for_cid(&cid);
            let default_type = if channel == "friends" {
                "chat"
            } else {
                "groupchat"
            };
            let conversation_type = pick_string(
                [item.get("type"), item.get("Type")]
                    .map(|value| value.and_then(|value| value.as_str())),
            );
            let title = pick_string(
                [
                    item.get("name"),
                    item.get("Name"),
                    item.get("game_name"),
                    item.get("displayName"),
                ]
                .map(|value| value.and_then(|value| value.as_str())),
            );
            let unread_count = item
                .get("unread_count")
                .or_else(|| item.get("unreadCount"))
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let message_history = item
                .get("message_history")
                .or_else(|| item.get("messageHistory"))
                .cloned()
                .unwrap_or(Value::Null);
            let muted = item
                .get("muted")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);

            Some(json!({
                "cid": cid,
                "channel": channel,
                "type": if conversation_type.is_empty() { default_type } else { &conversation_type },
                "title": title,
                "participantPuuid": if channel == "friends" { id_root(&cid) } else { String::new() },
                "unreadCount": unread_count,
                "messageHistory": message_history,
                "muted": muted,
                // Party/match MUCs 404 `/chat/v6/messages?cid=`. Direct chats
                // still have a REST store; rooms are filled from XMPP + the
                // unfiltered poll instead.
                "supportsHistory": channel == "friends",
            }))
        })
        .collect()
}

fn merge_normalized_conversations(groups: impl IntoIterator<Item = Vec<Value>>) -> Vec<Value> {
    let mut by_cid = HashMap::<String, Value>::new();
    for conversation in groups.into_iter().flatten() {
        let cid = conversation
            .get("cid")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        if cid.is_empty() {
            continue;
        }
        match by_cid.get_mut(&cid) {
            Some(existing) => {
                let Some(existing_object) = existing.as_object_mut() else {
                    continue;
                };
                let Some(incoming_object) = conversation.as_object() else {
                    continue;
                };
                for (key, value) in incoming_object {
                    let should_replace = match existing_object.get(key) {
                        None | Some(Value::Null) => true,
                        Some(Value::String(current)) => {
                            current.is_empty() && !value.as_str().unwrap_or_default().is_empty()
                        }
                        Some(Value::Number(current)) => {
                            current.as_u64().unwrap_or(0) == 0 && value.as_u64().unwrap_or(0) > 0
                        }
                        _ => false,
                    };
                    if should_replace {
                        existing_object.insert(key.clone(), value.clone());
                    }
                }
            }
            None => {
                by_cid.insert(cid, conversation);
            }
        }
    }
    let mut result: Vec<Value> = by_cid.into_values().collect();
    result.sort_by(|a, b| {
        a.get("cid")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .cmp(
                b.get("cid")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default(),
            )
    });
    result
}

fn room_conversation(cid: &str, channel: &str) -> Option<Value> {
    if cid.is_empty() {
        return None;
    }
    Some(json!({
        "cid": cid,
        "channel": channel,
        "type": "groupchat",
        "title": "",
        "participantPuuid": "",
        "unreadCount": 0,
        "messageHistory": Value::Null,
        "muted": false,
        "supportsHistory": false,
    }))
}

fn same_room_cid(left: &str, right: &str) -> bool {
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left.eq_ignore_ascii_case(right) {
        return true;
    }
    let channel = channel_for_cid(left);
    channel != "friends" && channel == channel_for_cid(right) && id_root(left) == id_root(right)
}

fn canonical_room_cid(wanted: &str, metadata: &[Value]) -> String {
    if wanted.is_empty() {
        return String::new();
    }
    metadata
        .iter()
        .find_map(|item| {
            let cid = item.get("cid").and_then(Value::as_str).unwrap_or("");
            same_room_cid(cid, wanted).then(|| cid.to_string())
        })
        .unwrap_or_else(|| wanted.to_string())
}

fn attach_messages_to_rooms(
    messages: Vec<Value>,
    party_cid: &str,
    team_cid: &str,
    all_cid: &str,
) -> Vec<Value> {
    messages
        .into_iter()
        .map(|mut message| {
            let Some(cid) = message
                .get("conversationId")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                return message;
            };
            let rewritten = if same_room_cid(&cid, party_cid) {
                party_cid
            } else if same_room_cid(&cid, team_cid) {
                team_cid
            } else if same_room_cid(&cid, all_cid) {
                all_cid
            } else {
                return message;
            };
            if let Some(object) = message.as_object_mut() {
                object.insert("conversationId".into(), json!(rewritten));
            }
            message
        })
        .collect()
}

fn merge_room_conversations(
    metadata: Vec<Value>,
    party_cid: &str,
    team_cid: &str,
    all_cid: &str,
) -> Vec<Value> {
    let party_cid = canonical_room_cid(party_cid, &metadata);
    let team_cid = canonical_room_cid(team_cid, &metadata);
    let all_cid = canonical_room_cid(all_cid, &metadata);
    let rooms = [
        room_conversation(&party_cid, "party"),
        room_conversation(&team_cid, "team"),
        room_conversation(&all_cid, "all"),
    ]
    .into_iter()
    .flatten()
    .collect();
    merge_normalized_conversations([metadata, rooms])
}

fn confirmed_party_room(joined_room: &str) -> String {
    joined_room.to_string()
}

fn is_missing_conversation_history(error: &str) -> bool {
    // Party/match MUCs are live in XMPP but often have no Riot Client REST
    // store. That comes back as RPC 404 `not_found`, which is "empty", not
    // "history failed". The stale-lockfile 404 (`RESOURCE_NOT_FOUND` /
    // Invalid URI) is a different condition and must stay a real error.
    let lower = error.to_ascii_lowercase();
    if lower.contains("resource_not_found") || lower.contains("invalid uri") {
        return false;
    }
    (lower.contains("404") || lower.contains("not found")) && lower.contains("not_found")
}

fn history_from_fetch_error(request_id: &str, cid: &str, error: &str) -> Value {
    if is_missing_conversation_history(error) {
        json!({
            "success": true,
            "requestId": request_id,
            "cid": cid,
            "messages": [],
        })
    } else {
        let code = if is_login_required_error(error) {
            "loginRequired"
        } else {
            ""
        };
        history_error(request_id, cid, code, error)
    }
}

fn history_error(request_id: &str, cid: &str, code: &str, error: &str) -> Value {
    let code = if code.is_empty() {
        Value::Null
    } else {
        json!(code)
    };
    json!({ "success": false, "requestId": request_id, "cid": cid, "code": code, "error": error })
}

fn send_success(request_id: &str, cid: &str, message_type: &str, transport: &str) -> Value {
    json!({
        "success": true,
        "requestId": request_id,
        "cid": cid,
        "type": message_type,
        "transport": transport,
    })
}

fn send_error(request_id: &str, cid: &str, error: &str) -> Value {
    json!({ "success": false, "requestId": request_id, "cid": cid, "error": error })
}

fn decode_presence_private(value: &str) -> Value {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(json!({}))
}

fn product_priority(product: &str) -> u8 {
    match product.to_ascii_lowercase().as_str() {
        "valorant" => 3,
        "league_of_legends" => 2,
        "riot_client" | "keystone" => 1,
        _ => 0,
    }
}

fn normalize_friends(
    friends_payload: &[Value],
    presences_payload: &[Value],
    live: &xmpp::presence::PresenceSnapshot,
) -> Vec<Value> {
    let mut result: Vec<Value> = friends_payload
        .iter()
        .filter_map(|friend| {
            let puuid = pick_string(
                [
                    friend.get("puuid"),
                    friend.get("PUUID"),
                    friend.get("pid"),
                    friend.get("PID"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            let puuid_root = id_root(&puuid);
            let live_resources = live
                .friends
                .get(&puuid_root)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let live_resource = live_resources
                .iter()
                .max_by_key(|resource| product_priority(&resource.product));
            let empty = json!({});
            let presence = live_resource
                .and_then(|resource| {
                    presences_payload.iter().find(|presence| {
                        let presence_puuid = pick_string(
                            [
                                presence.get("puuid"),
                                presence.get("PUUID"),
                                presence.get("pid"),
                                presence.get("PID"),
                            ]
                            .map(|value| value.and_then(|value| value.as_str())),
                        );
                        let product = pick_string(
                            [presence.get("product"), presence.get("Product")]
                                .map(|value| value.and_then(|value| value.as_str())),
                        );
                        id_root(&presence_puuid) == puuid_root
                            && product.eq_ignore_ascii_case(&resource.product)
                    })
                })
                .unwrap_or(&empty);
            let private_str = presence.get("private").and_then(|v| v.as_str());
            let rest_private = private_str
                .map(decode_presence_private)
                .unwrap_or_else(|| json!({}));
            let priv_val = live_resource
                .map(|resource| resource.private.clone())
                .filter(|value| value.as_object().is_some_and(|object| !object.is_empty()))
                .unwrap_or(rest_private);
            let party = priv_val.get("partyPresenceData").unwrap_or(&priv_val);
            let match_data = priv_val.get("matchPresenceData").unwrap_or(&priv_val);
            let session_loop_state = pick_string([
                live_resource.map(|resource| resource.session_loop_state.as_str()),
                match_data
                    .get("sessionLoopState")
                    .and_then(|value| value.as_str()),
                priv_val
                    .get("sessionLoopState")
                    .and_then(|value| value.as_str()),
            ]);

            let game_name = pick_string(
                [
                    friend.get("game_name"),
                    friend.get("gameName"),
                    friend.get("GameName"),
                    presence.get("game_name"),
                    presence.get("gameName"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            let tag_line = pick_string(
                [
                    friend.get("game_tag"),
                    friend.get("gameTag"),
                    friend.get("tagLine"),
                    friend.get("TagLine"),
                    presence.get("game_tag"),
                    presence.get("tagLine"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            let display_name = if !game_name.is_empty() {
                if tag_line.is_empty() {
                    game_name.clone()
                } else {
                    format!("{game_name}#{tag_line}")
                }
            } else {
                pick_string(
                    [friend.get("name"), friend.get("displayName")]
                        .map(|v| v.and_then(|v| v.as_str()))
                        .into_iter()
                        .chain([Some(puuid.as_str())]),
                )
            };
            let note = pick_string(
                [friend.get("note"), friend.get("Note")]
                    .map(|value| value.and_then(|value| value.as_str())),
            );
            let status = pick_string([
                live_resource.map(|resource| resource.status.as_str()),
                presence.get("status").and_then(|value| value.as_str()),
                presence
                    .get("availability")
                    .and_then(|value| value.as_str()),
                presence.get("show").and_then(|value| value.as_str()),
                presence.get("state").and_then(|value| value.as_str()),
            ]);
            let is_online = live.state == xmpp::presence::PresenceSyncState::Ready
                && !live_resources.is_empty();

            if puuid.is_empty() && display_name.is_empty() {
                return None;
            }

            let status_message = pick_string([
                live_resource.map(|resource| resource.status_message.as_str()),
                presence.get("statusMessage").and_then(|v| v.as_str()),
                presence.get("status_message").and_then(|v| v.as_str()),
                party.get("sessionLoopState").and_then(|v| v.as_str()),
                party.get("state").and_then(|v| v.as_str()),
            ]);
            let product = pick_string([
                live_resource.map(|resource| resource.product.as_str()),
                presence.get("product").and_then(|value| value.as_str()),
                presence.get("Product").and_then(|value| value.as_str()),
            ]);
            let queue_id = pick_string([
                party.get("queueId").and_then(|v| v.as_str()),
                party.get("queueID").and_then(|v| v.as_str()),
                party.get("queue").and_then(|v| v.as_str()),
            ]);
            let party_id = pick_string([
                party.get("partyId").and_then(|v| v.as_str()),
                priv_val.get("partyId").and_then(|v| v.as_str()),
            ]);
            let party_size = party.get("partySize").cloned().unwrap_or(Value::Null);
            let max_party_size = party.get("maxPartySize").cloned().unwrap_or(Value::Null);
            let status_final = if status.is_empty() {
                "offline".to_string()
            } else {
                status
            };

            Some(json!({
                "puuid": puuid,
                "gameName": game_name,
                "tagLine": tag_line,
                "displayName": display_name,
                "note": note,
                "status": status_final,
                "statusMessage": status_message,
                "sessionLoopState": session_loop_state,
                "product": product,
                "queueId": queue_id,
                "partyId": party_id,
                "partySize": party_size,
                "maxPartySize": max_party_size,
                "isOnline": is_online,
                "presenceState": live.state,
            }))
        })
        .collect();

    result.sort_by(|a, b| {
        let a_online = a.get("isOnline").and_then(|v| v.as_bool()).unwrap_or(false);
        let b_online = b.get("isOnline").and_then(|v| v.as_bool()).unwrap_or(false);
        b_online.cmp(&a_online).then_with(|| {
            let a_name = a
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let b_name = b
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            a_name.cmp(b_name)
        })
    });
    result
}

#[derive(Default)]
struct RoomScopes {
    party: HashSet<String>,
    matches: HashSet<String>,
    rooms: Map<String, Value>,
    conversations: Vec<Value>,
}

fn split_match_rooms(ids: &HashSet<String>) -> (String, String, String) {
    let rooms: Vec<&String> = ids.iter().collect();
    let all = rooms
        .iter()
        .find(|r| r.to_lowercase().contains("-all@ares-coregame"))
        .cloned();
    let team = rooms
        .iter()
        .find(|r| {
            let lower = r.to_lowercase();
            lower.contains("-blue@ares-coregame")
                || lower.contains("-red@ares-coregame")
                || lower.contains("-blue@ares-pregame")
                || lower.contains("-red@ares-pregame")
        })
        .cloned();
    let team_s = team.cloned().unwrap_or_default();
    let all_s = all.cloned().unwrap_or_default();
    let match_s = if !team_s.is_empty() {
        team_s.clone()
    } else {
        all_s.clone()
    };
    (match_s, team_s, all_s)
}

fn extract_party_rooms_from_conversations(
    payload: &Value,
    party: &mut HashSet<String>,
    match_rooms: &HashSet<String>,
) {
    for c in conversations_array(payload) {
        let id = pick_string(
            [
                c.get("cid"),
                c.get("id"),
                c.get("conversationId"),
                c.get("ConversationID"),
            ]
            .map(|v| v.and_then(|v| v.as_str())),
        );
        let ctype = pick_string([c.get("type"), c.get("Type")].map(|v| v.and_then(|v| v.as_str())));
        if !id.is_empty() && ctype == "groupchat" && is_party_cid(&id) && !match_rooms.contains(&id)
        {
            party.insert(id);
        }
    }
}

async fn add_party_room_from_active_party(riot: &RiotState, party: &mut HashSet<String>) {
    let Ok(api) = api::create_api(riot).await else {
        return;
    };
    let Ok(partyplayer) = api.party_get_by_player(&api.puuid).await else {
        return;
    };
    let party_id = pick_string(
        [
            partyplayer.get("CurrentPartyID"),
            partyplayer.get("PartyID"),
        ]
        .map(|v| v.and_then(|v| v.as_str())),
    );
    if party_id.is_empty() {
        return;
    }
    if let Ok(details) = api.party_get(&party_id).await {
        if let Some(room) = api::party_muc_name(&details) {
            party.insert(room.to_string());
        }
    }
}

async fn get_chat_room_scopes(
    riot: &RiotState,
    conversations_payload: Option<&Value>,
) -> RoomScopes {
    let party_payload = riot_client::get_party_chat_info(riot).await.ok();
    let pregame_payload = riot_client::get_pre_game_chat_info(riot).await.ok();
    let current_game_payload = riot_client::get_current_game_chat_info(riot).await.ok();
    let conversations = merge_normalized_conversations(
        [
            party_payload.as_ref(),
            pregame_payload.as_ref(),
            current_game_payload.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(normalize_conversations),
    );

    let pregame = pregame_payload
        .as_ref()
        .map(collect_conversation_ids)
        .unwrap_or_default();
    let current_game = current_game_payload
        .as_ref()
        .map(collect_conversation_ids)
        .unwrap_or_default();
    let matches: HashSet<String> = pregame.union(&current_game).cloned().collect();
    let mut party = party_payload
        .as_ref()
        .map(collect_conversation_ids)
        .unwrap_or_default();
    if let Some(payload) = conversations_payload {
        extract_party_rooms_from_conversations(payload, &mut party, &matches);
    }
    add_party_room_from_active_party(riot, &mut party).await;

    let (match_room, match_team, match_all) = split_match_rooms(&matches);
    let first_party = party.iter().next().cloned().unwrap_or_default();
    let first_current_or_pregame = current_game
        .iter()
        .next()
        .or_else(|| pregame.iter().next())
        .cloned()
        .unwrap_or_default();

    let mut rooms = Map::new();
    rooms.insert("party".into(), json!(first_party));
    rooms.insert("matchTeam".into(), json!(match_team));
    rooms.insert("matchAll".into(), json!(match_all));
    rooms.insert(
        "match".into(),
        json!(if !match_room.is_empty() {
            match_room
        } else {
            first_current_or_pregame
        }),
    );

    RoomScopes {
        party,
        matches,
        rooms,
        conversations,
    }
}

async fn get_current_match_player_ids(riot: &RiotState) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(api) = api::create_api(riot).await else {
        return ids;
    };

    if let Ok(core_player) = api.coregame_get_player(&api.puuid).await {
        if let Some(match_id) = core_player.get("MatchID").and_then(|v| v.as_str()) {
            if let Ok(m) = api.coregame_get_match(match_id).await {
                for p in m
                    .get("Players")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                {
                    let subject = pick_string(
                        [p.get("Subject"), p.get("PUUID")].map(|v| v.and_then(|v| v.as_str())),
                    );
                    if !subject.is_empty() {
                        ids.insert(id_root(&subject));
                    }
                }
            }
        }
    }
    if let Ok(pre_player) = api.pregame_get_player(&api.puuid).await {
        if let Some(match_id) = pre_player.get("MatchID").and_then(|v| v.as_str()) {
            if let Ok(m) = api.pregame_get_match(match_id).await {
                let ally = m
                    .pointer("/AllyTeam/Players")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let enemy = m
                    .pointer("/EnemyTeam/Players")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for p in ally.iter().chain(enemy.iter()) {
                    let subject = pick_string(
                        [p.get("Subject"), p.get("PUUID")].map(|v| v.and_then(|v| v.as_str())),
                    );
                    if !subject.is_empty() {
                        ids.insert(id_root(&subject));
                    }
                }
            }
        }
    }
    ids
}

fn get_message_scope(
    message: &Value,
    conversation_id: &str,
    conversations: &HashMap<String, String>,
    scopes: &RoomScopes,
    match_player_ids: &HashSet<String>,
) -> &'static str {
    if scopes.party.contains(conversation_id) {
        return "party";
    }
    if scopes.matches.contains(conversation_id) {
        return "match";
    }
    let root = id_root(conversation_id);
    if !root.is_empty() && match_player_ids.contains(&root) {
        return "match";
    }
    let haystack = [
        conversation_id,
        conversations
            .get(conversation_id)
            .map(|s| s.as_str())
            .unwrap_or(""),
        message.get("type").and_then(|v| v.as_str()).unwrap_or(""),
        message.get("Type").and_then(|v| v.as_str()).unwrap_or(""),
        message.get("room").and_then(|v| v.as_str()).unwrap_or(""),
        message.get("Room").and_then(|v| v.as_str()).unwrap_or(""),
    ]
    .join(" ")
    .to_lowercase();
    if haystack.contains("ares-parties") {
        "party"
    } else if haystack.contains("ares-coregame") || haystack.contains("ares-pregame") {
        "match"
    } else {
        "friends"
    }
}

fn messages_array(payload: &Value) -> Vec<Value> {
    payload
        .get("messages")
        .or_else(|| payload.get("Messages"))
        .or_else(|| payload.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// PUUID root -> display name, for filling in the names Riot sends as ids.
///
/// Covers the local player as well as the friends list. The local player is
/// the case that matters most: they are never in their own friends list, so
/// their own party lines had nothing to resolve against at all.
async fn display_names(
    riot: &RiotState,
    friends: &[Value],
    own_puuid: &str,
) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for friend in friends {
        let puuid = friend.get("puuid").and_then(Value::as_str).unwrap_or("");
        let name = friend
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !puuid.is_empty() && !name.is_empty() {
            names.insert(id_root(puuid), name.to_string());
        }
    }

    if !own_puuid.is_empty() {
        if let Ok(info) = riot_client::get_user_info(riot).await {
            let game_name = info
                .get("game_name")
                .or_else(|| info.get("gameName"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let tag_line = info
                .get("tag_line")
                .or_else(|| info.get("tagLine"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !game_name.is_empty() {
                let display = if tag_line.is_empty() {
                    game_name.to_string()
                } else {
                    format!("{game_name}#{tag_line}")
                };
                names.insert(id_root(own_puuid), display);
            }
        }
    }
    names
}

/// Whether a name slot is really just a PUUID.
///
/// Riot fills the sender name with the PUUID in party and match rooms, so the
/// value has to be inspected rather than trusted. Matched by shape - 8-4-4-4-12
/// hex - because a Riot ID may legitimately contain hyphens.
fn looks_like_puuid(value: &str) -> bool {
    let groups: Vec<&str> = value.trim().split('-').collect();
    if groups.len() != 5 {
        return false;
    }
    let widths = [8, 4, 4, 4, 12];
    groups
        .iter()
        .zip(widths)
        .all(|(group, width)| group.len() == width && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `names` maps a PUUID root to a display name and covers the local player as
/// well as friends - a self-sent party line has no friend entry to resolve
/// against, which is exactly the case that used to render as a raw uuid.
fn normalize_messages(
    payload: &Value,
    conversations: &HashMap<String, String>,
    scopes: &RoomScopes,
    match_player_ids: &HashSet<String>,
    own_puuid: &str,
    names: &HashMap<String, String>,
) -> Vec<Value> {
    messages_array(payload)
        .iter()
        .filter_map(|message| {
            let body = pick_string(
                [
                    message.get("body"),
                    message.get("Body"),
                    message.get("message"),
                    message.get("Message"),
                    message.get("text"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            if body.is_empty() {
                return None;
            }
            let sender = pick_string(
                [
                    message.get("sender"),
                    message.get("from"),
                    message.get("From"),
                    message.get("senderId"),
                    message.get("SenderID"),
                    message.get("puuid"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            let sender_root = id_root(&if !sender.is_empty() {
                sender.clone()
            } else {
                pick_string(
                    [message.get("pid"), message.get("PID")].map(|v| v.and_then(|v| v.as_str())),
                )
            });
            let is_self = !own_puuid.is_empty() && sender_root == id_root(own_puuid);
            let timestamp = pick_string(
                [
                    message.get("time"),
                    message.get("timestamp"),
                    message.get("Timestamp"),
                    message.get("createdAt"),
                    message.get("receivedTime"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            let conversation_id = pick_string(
                [
                    message.get("cid"),
                    message.get("conversationId"),
                    message.get("ConversationID"),
                    message.get("room"),
                    message.get("Room"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            let sender_name = pick_string(
                [
                    message.get("game_name"),
                    message.get("gameName"),
                    message.get("senderName"),
                    message.get("name"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            let id = pick_string(
                [
                    message.get("id"),
                    message.get("ID"),
                    message.get("messageId"),
                    message.get("MessageID"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            // A name Riot actually supplied wins. Only a blank or a bare PUUID
            // goes to the lookup, so a live name is never replaced by a cached
            // one.
            let sender_name_final = if !sender_name.is_empty() && !looks_like_puuid(&sender_name) {
                sender_name
            } else {
                names.get(&sender_root).cloned().unwrap_or_else(|| {
                    if sender_name.is_empty() {
                        sender.clone()
                    } else {
                        sender_name
                    }
                })
            };
            let timestamp_final = if timestamp.is_empty() {
                Value::Null
            } else {
                json!(timestamp)
            };
            let msg_type = pick_string(
                [message.get("type"), message.get("Type")].map(|v| v.and_then(|v| v.as_str())),
            );
            let msg_type_final = if msg_type.is_empty() {
                "chat".to_string()
            } else {
                msg_type
            };
            let scope = get_message_scope(
                message,
                &conversation_id,
                conversations,
                scopes,
                match_player_ids,
            );

            Some(json!({
                "id": id,
                "conversationId": conversation_id,
                "sender": sender,
                "senderName": sender_name_final,
                "body": body,
                "timestamp": timestamp_final,
                "type": msg_type_final,
                "scope": scope,
                "isSelf": is_self,
            }))
        })
        .collect()
}

fn unique_messages(messages: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    messages
        .into_iter()
        .filter(|m| {
            let cid = m
                .get("conversationId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let key = if id.is_empty() {
                format!(
                    "{cid}:{}:{}:{}",
                    m.get("timestamp").and_then(|v| v.as_str()).unwrap_or(""),
                    m.get("sender").and_then(|v| v.as_str()).unwrap_or(""),
                    m.get("body").and_then(|v| v.as_str()).unwrap_or("")
                )
            } else {
                format!("{cid}:{id}")
            };
            seen.insert(key)
        })
        .collect()
}

#[tauri::command]
pub async fn chat_get(app: AppHandle, riot: State<'_, RiotState>) -> Result<String, ()> {
    ensure_chat_forwarders(&app);
    let result: Result<Value, String> = async {
        xmpp::ensure_connected(&riot).await?;
        let live_presence = xmpp::presence_snapshot();
        let base_payload = riot_client::get_chat_messages(&riot, None).await?;
        let conversations_payload = riot_client::get_chat_conversations(&riot).await.ok();
        let friends_payload = riot_client::get_friends(&riot).await.unwrap_or_default();
        let presences_payload = crate::riot::client::get_presences(&riot)
            .await
            .unwrap_or_default();

        let conversations = conversations_payload
            .as_ref()
            .map(normalize_conversation_map)
            .unwrap_or_default();
        let friends = normalize_friends(&friends_payload, &presences_payload, &live_presence);
        let mut scopes = get_chat_room_scopes(&riot, conversations_payload.as_ref()).await;
        let conversation_metadata = merge_normalized_conversations([
            conversations_payload
                .as_ref()
                .map(normalize_conversations)
                .unwrap_or_default(),
            scopes.conversations.clone(),
        ]);
        let match_player_ids = get_current_match_player_ids(&riot).await;
        let tokens = crate::riot::client::get_tokens(&riot, false).await.ok();
        let own_puuid = tokens
            .as_ref()
            .and_then(|t| t.get("subject"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if scopes
            .rooms
            .get("party")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            for msg in messages_array(&base_payload) {
                let cid = pick_string(
                    [
                        msg.get("cid"),
                        msg.get("conversationId"),
                        msg.get("ConversationID"),
                    ]
                    .map(|v| v.and_then(|v| v.as_str())),
                );
                let msg_type = pick_string(
                    [msg.get("type"), msg.get("Type")].map(|v| v.and_then(|v| v.as_str())),
                );
                if !cid.is_empty()
                    && msg_type == "groupchat"
                    && is_party_cid(&cid)
                    && !scopes.matches.contains(&cid)
                {
                    scopes.party.insert(cid.clone());
                    scopes.rooms.insert("party".into(), json!(cid));
                    break;
                }
            }
        }

        let needs_xmpp_match_rooms = scopes
            .rooms
            .get("matchTeam")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
            || scopes
                .rooms
                .get("matchAll")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .is_empty();
        let xmpp_match_rooms = if needs_xmpp_match_rooms {
            xmpp::ensure_match_xmpp_chat(&riot)
                .await
                .unwrap_or_default()
        } else {
            (None, None)
        };
        let (party_room, party_debug) = xmpp::ensure_party_xmpp_chat(&riot).await;

        let xmpp_messages: Vec<Value> = xmpp::get_xmpp_messages()
            .await
            .into_iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect();

        let names = display_names(&riot, &friends, &own_puuid).await;
        let mut messages = normalize_messages(
            &base_payload,
            &conversations,
            &scopes,
            &match_player_ids,
            &own_puuid,
            &names,
        );
        messages.extend(xmpp_messages);

        let final_party_room =
            canonical_room_cid(&confirmed_party_room(&party_room), &conversation_metadata);
        let match_team = scopes
            .rooms
            .get("matchTeam")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let match_all = scopes
            .rooms
            .get("matchAll")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let base_match = scopes
            .rooms
            .get("match")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let match_team_final = canonical_room_cid(
            &xmpp_match_rooms
                .0
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or(match_team.clone()),
            &conversation_metadata,
        );
        let match_all_final = canonical_room_cid(
            &xmpp_match_rooms
                .1
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or(match_all.clone()),
            &conversation_metadata,
        );
        let match_final = canonical_room_cid(
            &xmpp_match_rooms
                .0
                .filter(|s| !s.is_empty())
                .or_else(|| Some(match_team).filter(|s| !s.is_empty()))
                .or(xmpp_match_rooms.1.filter(|s| !s.is_empty()))
                .unwrap_or(if !match_all.is_empty() {
                    match_all
                } else {
                    base_match
                }),
            &conversation_metadata,
        );
        let messages = unique_messages(attach_messages_to_rooms(
            messages,
            &final_party_room,
            &match_team_final,
            &match_all_final,
        ));

        let conversation_metadata = merge_room_conversations(
            conversation_metadata,
            &final_party_room,
            &match_team_final,
            &match_all_final,
        );

        Ok(json!({
            "success": true,
            "messages": messages,
            "rooms": {
                "party": final_party_room,
                "match": match_final,
                "matchTeam": match_team_final,
                "matchAll": match_all_final,
                "_partyXmppDebug": party_debug,
            },
            "conversations": conversation_metadata,
            "friends": friends,
            "fetchedAt": chrono_iso_now(),
        }))
    }
    .await;

    Ok(match result {
        Ok(v) => v.to_string(),
        Err(e) => {
            let code = if is_login_required_error(&e) {
                json!("loginRequired")
            } else {
                Value::Null
            };
            json!({ "success": false, "code": code, "error": e }).to_string()
        }
    })
}

#[tauri::command]
pub async fn chat_history(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let request_id = arg(&args, 0).unwrap_or_default();
    let cid = arg(&args, 1).unwrap_or_default().trim().to_string();
    if cid.is_empty() {
        return Ok(
            history_error(&request_id, &cid, "unavailable", "No chat room selected.").to_string(),
        );
    }

    let result: Result<Value, String> = async {
        let payload = riot_client::get_chat_messages(&riot, Some(&cid)).await?;
        let conversations_payload = riot_client::get_chat_conversations(&riot).await.ok();
        let conversations = conversations_payload
            .as_ref()
            .map(normalize_conversation_map)
            .unwrap_or_default();
        let scopes = get_chat_room_scopes(&riot, conversations_payload.as_ref()).await;
        let match_player_ids = get_current_match_player_ids(&riot).await;
        let tokens = riot_client::get_tokens(&riot, false).await?;
        let own_puuid = tokens
            .get("subject")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        // History is fetched per room, so the friends list is not already in
        // hand here — the local player's own name is the one that matters, and
        // it is the one the friends list could never have supplied anyway.
        let names = display_names(&riot, &[], own_puuid).await;
        let messages = normalize_messages(
            &payload,
            &conversations,
            &scopes,
            &match_player_ids,
            own_puuid,
            &names,
        );
        Ok(json!({
            "success": true,
            "requestId": request_id,
            "cid": cid,
            "messages": unique_messages(messages),
        }))
    }
    .await;

    Ok(match result {
        Ok(value) => value.to_string(),
        Err(error) => history_from_fetch_error(&request_id, &cid, &error).to_string(),
    })
}

#[tauri::command]
pub async fn chat_translate(
    args: Vec<Value>,
    config: State<'_, ConfigStore>,
) -> Result<String, ()> {
    let Some(text) = arg(&args, 0) else {
        return Ok(json!({ "success": false, "error": "no text" }).to_string());
    };
    let target_language_arg = arg(&args, 1);

    let provider = config
        .get("translatorProvider")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "google".into());
    let source_language = config
        .get("translatorSourceLanguage")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "auto".into());
    let default_target = config
        .get("translatorTargetLanguage")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "en".into());
    let deepl_key = config
        .get("deeplApiKey")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let target_language = target_language_arg
        .filter(|s| !s.is_empty())
        .unwrap_or(default_target);

    Ok(
        match translate::translate_text(
            &text,
            &provider,
            &source_language,
            &target_language,
            &deepl_key,
        )
        .await
        {
            Ok(result) => json!({
                "success": true,
                "translatedText": result.text,
                "provider": provider,
                "sourceLanguage": result.source_language,
                "targetLanguage": result.target_language,
            })
            .to_string(),
            Err(e) => json!({ "success": false, "error": e }).to_string(),
        },
    )
}

#[tauri::command]
pub async fn chat_send(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let request_id = arg(&args, 0).unwrap_or_default();
    let Some(conversation_id) = arg(&args, 1).filter(|s| !s.trim().is_empty()) else {
        return Ok(send_error(&request_id, "", "No chat room selected.").to_string());
    };
    let cid = conversation_id.trim().to_string();
    let Some(message) = arg(&args, 2).filter(|s| !s.trim().is_empty()) else {
        return Ok(send_error(&request_id, &cid, "Message is empty.").to_string());
    };
    let body = message.trim().to_string();
    let msg_type = get_send_type(&cid);

    // Riot Local API is authoritative; group rooms retain the existing XMPP fallback.
    let mut transport = "rest";
    let rest_result = riot_client::send_chat_message(&riot, &cid, &body, msg_type).await;
    if let Err(rest_err) = rest_result {
        if cid.contains("@ares-parties.") {
            transport = "xmpp";
            if let Err(e) = xmpp::send_party_xmpp_message(&riot, &cid, &body).await {
                return Ok(send_error(&request_id, &cid, &e).to_string());
            }
        } else if cid.contains("@ares-coregame.") {
            transport = "xmpp";
            if let Err(e) = xmpp::send_match_xmpp_message(&riot, &cid, &body).await {
                return Ok(send_error(&request_id, &cid, &e).to_string());
            }
        } else {
            return Ok(send_error(&request_id, &cid, &rest_err).to_string());
        }
    }

    Ok(send_success(&request_id, &cid, msg_type, transport).to_string())
}

#[tauri::command]
pub async fn chat_friend_action(
    args: Vec<Value>,
    riot: State<'_, RiotState>,
) -> Result<String, ()> {
    let action = arg(&args, 0).unwrap_or_default();
    let friend = args.get(1).cloned().unwrap_or(json!({}));

    let result: Result<(), String> = async {
        let api = api::create_api(&riot).await?;
        if action == "invite" {
            let game_name = friend
                .get("gameName")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let tag_line = friend
                .get("tagLine")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if game_name.is_empty() || tag_line.is_empty() {
                return Err("Friend Riot ID is unavailable.".into());
            }
            let party_player = api.party_get_by_player(&api.puuid).await?;
            let party_id = pick_string(
                [
                    party_player.get("CurrentPartyID"),
                    party_player.get("PartyID"),
                ]
                .map(|v| v.and_then(|v| v.as_str())),
            );
            if party_id.is_empty() {
                return Err("You are not in a party.".into());
            }
            api.party_invite(&party_id, game_name, tag_line).await?;
        } else {
            let party_id = friend
                .get("partyId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if party_id.is_empty() {
                return Err("This friend has no visible party to join.".into());
            }
            api.party_request(party_id).await?;
        }
        Ok(())
    }
    .await;

    Ok(match result {
        Ok(_) => json!({ "success": true, "action": action }).to_string(),
        Err(e) => json!({ "success": false, "error": e }).to_string(),
    })
}

#[tauri::command]
pub async fn chat_disconnect() -> Result<(), ()> {
    xmpp::disconnect_match_xmpp_chat().await;
    Ok(())
}

fn chrono_iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d, h, mi, s) = crate::util_time::civil_from_unix_secs(secs);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat_presence_snapshot(
        state: xmpp::presence::PresenceSyncState,
        resources: Vec<xmpp::presence::FriendPresenceResource>,
    ) -> xmpp::presence::PresenceSnapshot {
        let mut friends: HashMap<String, Vec<xmpp::presence::FriendPresenceResource>> =
            HashMap::new();
        for resource in resources {
            friends
                .entry(resource.puuid.clone())
                .or_default()
                .push(resource);
        }
        xmpp::presence::PresenceSnapshot {
            state,
            generation: 7,
            friends,
        }
    }

    fn live_resource(
        puuid: &str,
        product: &str,
        session_loop_state: &str,
    ) -> xmpp::presence::FriendPresenceResource {
        xmpp::presence::FriendPresenceResource {
            puuid: puuid.into(),
            resource: "RC-1".into(),
            product: product.into(),
            status: "chat".into(),
            status_message: String::new(),
            session_loop_state: session_loop_state.into(),
            private: json!({}),
        }
    }

    #[test]
    fn classifies_party_team_all_without_substitution() {
        assert!(is_party_cid("party@ares-parties.ap"));
        assert!(!is_party_cid("unknown@conference.example"));
        assert_eq!(channel_for_cid("party@ares-parties.ap"), "party");
        assert_eq!(channel_for_cid("game-blue@ares-coregame.ap"), "team");
        assert_eq!(channel_for_cid("game-red@ares-pregame.ap"), "team");
        assert_eq!(channel_for_cid("game-all@ares-coregame.ap"), "all");
        assert_eq!(channel_for_cid("friend-cid"), "friends");
        let unknown = HashSet::from(["unknown@ares-coregame.ap".to_string()]);
        let (_, team, all) = split_match_rooms(&unknown);
        assert!(team.is_empty());
        assert!(all.is_empty());

        let mut party = HashSet::new();
        extract_party_rooms_from_conversations(
            &json!({
                "conversations": [
                    { "cid": "unknown@conference.example", "type": "groupchat" },
                    { "cid": "party@ares-parties.ap", "type": "groupchat" }
                ]
            }),
            &mut party,
            &HashSet::new(),
        );
        assert_eq!(party, HashSet::from(["party@ares-parties.ap".to_string()]));
    }

    #[test]
    fn preserves_history_and_unread_metadata() {
        let payload = json!({"conversations": [{
            "cid": "friend@jp1.pvp.net",
            "type": "chat",
            "message_history": true,
            "unread_count": 3,
            "muted": false
        }]});
        let result = normalize_conversations(&payload);
        assert_eq!(result[0]["channel"], "friends");
        assert_eq!(result[0]["unreadCount"], 3);
        assert_eq!(result[0]["messageHistory"], true);
        assert_eq!(result[0]["supportsHistory"], true);
    }

    #[test]
    fn history_error_keeps_request_identity() {
        let value = history_error("request-7", "room-7", "unavailable", "No room");
        assert_eq!(value["requestId"], "request-7");
        assert_eq!(value["cid"], "room-7");
        assert_eq!(value["code"], "unavailable");
    }

    #[test]
    fn a_party_muc_without_rest_history_is_empty_not_an_error() {
        // The Riot Client 404s `/chat/v6/messages?cid=` for live party rooms.
        // That is "this MUC has no REST store", not a failed load — the thread
        // still has XMPP + the unfiltered poll. Surfacing the RPC string hid
        // the `sb` line behind a red banner.
        let error = "Riot Client request failed (404 Not Found) for \
            /chat/v6/messages?cid=27ccdf36-57e7-4eee-b111-96a9b0deb638%40ares-parties.jp1.pvp.net: \
            {\"errorCode\":\"RPC_ERROR\",\"httpStatus\":404,\"implementationDetails\":{},\"message\":\"not_found\"}";
        assert!(is_missing_conversation_history(error));
        let value = history_from_fetch_error(
            "hist-1",
            "27ccdf36-57e7-4eee-b111-96a9b0deb638@ares-parties.jp1.pvp.net",
            error,
        );
        assert_eq!(value["success"], true);
        assert_eq!(value["messages"], json!([]));
        assert_eq!(
            value["cid"],
            "27ccdf36-57e7-4eee-b111-96a9b0deb638@ares-parties.jp1.pvp.net"
        );
        assert!(!is_missing_conversation_history(
            "Riot Client request failed (404 Not Found) for /chat/v4/friends: \
             {\"errorCode\":\"RESOURCE_NOT_FOUND\"}"
        ));
        assert!(!is_missing_conversation_history(
            "Riot Client request failed (503 Service Unavailable) for /chat/v6/messages: \
             {\"message\":\"not connected to chat, service unavailable\"}"
        ));
    }

    #[test]
    fn forwarder_guard_only_starts_once() {
        let started = std::sync::atomic::AtomicBool::new(false);
        assert!(mark_chat_forwarder_started(&started));
        assert!(!mark_chat_forwarder_started(&started));
    }

    #[test]
    fn presence_event_payload_keeps_complete_snapshot() {
        let snapshot = chat_presence_snapshot(
            xmpp::presence::PresenceSyncState::Ready,
            vec![live_resource("friend", "valorant", "INGAME")],
        );

        let payload = presence_event_payload(&snapshot).unwrap();
        let value: Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(value["state"], "ready");
        assert_eq!(value["generation"], 7);
        assert_eq!(value["friends"]["friend"][0]["product"], "valorant");
    }

    #[test]
    fn send_payloads_keep_request_identity_and_transport() {
        let success = send_success("send-7", "party@ares-parties.ap", "groupchat", "xmpp");
        assert_eq!(success["requestId"], "send-7");
        assert_eq!(success["cid"], "party@ares-parties.ap");
        assert_eq!(success["type"], "groupchat");
        assert_eq!(success["transport"], "xmpp");

        let failure = send_error("send-8", "friend-cid", "offline");
        assert_eq!(failure["requestId"], "send-8");
        assert_eq!(failure["cid"], "friend-cid");
        assert_eq!(failure["error"], "offline");
    }

    #[test]
    fn derives_supported_send_type_from_riot_cid() {
        assert_eq!(get_send_type("friend-cid"), "chat");
        assert_eq!(get_send_type("party@ares-parties.ap"), "groupchat");
        assert_eq!(get_send_type("game-blue@ares-coregame.ap"), "groupchat");
    }

    #[test]
    fn adds_xmpp_only_rooms_to_conversation_metadata() {
        let result = merge_room_conversations(
            Vec::new(),
            "party@ares-parties.ap",
            "game-blue@ares-coregame.ap",
            "game-all@ares-coregame.ap",
        );
        assert_eq!(result.len(), 3);
        assert!(result.iter().any(|item| item["channel"] == "party"));
        assert!(result.iter().any(|item| item["channel"] == "team"));
        assert!(result.iter().any(|item| item["channel"] == "all"));
        assert!(result.iter().all(|item| item["title"] == ""));
        // Party/match MUCs 404 `/chat/v6/messages?cid=`. Asking anyway painted
        // the raw RPC string over the thread. Rooms are filled from XMPP.
        assert!(result.iter().all(|item| item["supportsHistory"] == false));
    }

    #[test]
    fn only_direct_conversations_ask_riot_for_rest_history() {
        let payload = json!({"conversations": [
            { "cid": "party@ares-parties.ap", "type": "groupchat" },
            { "cid": "game-blue@ares-coregame.ap", "type": "groupchat" },
            { "cid": "game-all@ares-coregame.ap", "type": "groupchat" },
            { "cid": "friend@ap1.pvp.net", "type": "chat" }
        ]});
        let result = normalize_conversations(&payload);
        assert_eq!(result.len(), 4);
        assert_eq!(
            result
                .iter()
                .map(|item| (
                    item["channel"].as_str().unwrap(),
                    item["supportsHistory"].as_bool().unwrap()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("party", false),
                ("team", false),
                ("all", false),
                ("friends", true),
            ]
        );
    }

    #[test]
    fn exposes_party_room_only_after_xmpp_join() {
        assert_eq!(
            confirmed_party_room("joined@ares-parties.ap"),
            "joined@ares-parties.ap"
        );
        assert_eq!(confirmed_party_room(""), "");
    }

    #[test]
    fn prefers_the_riot_client_party_cid_over_an_xmpp_alias() {
        // Party details give `id@ares-parties.ap`. The conversation the local
        // client actually stores messages under is `id@ares-parties.ap1.pvp.net`.
        // Keeping both made the UI select the empty XMPP name while `sb` sat
        // on the REST cid.
        let rest = "p-1@ares-parties.ap1.pvp.net";
        let xmpp = "p-1@ares-parties.ap";
        let metadata = vec![json!({
            "cid": rest,
            "channel": "party",
            "type": "groupchat",
            "title": "",
            "participantPuuid": "",
            "unreadCount": 0,
            "messageHistory": Value::Null,
            "muted": false,
            "supportsHistory": true,
        })];
        let merged = merge_room_conversations(metadata, xmpp, "", "");
        let party_rooms: Vec<&str> = merged
            .iter()
            .filter(|item| item["channel"] == "party")
            .filter_map(|item| item["cid"].as_str())
            .collect();
        assert_eq!(party_rooms, vec![rest]);
        assert_eq!(canonical_room_cid(xmpp, &merged), rest);
    }

    #[test]
    fn rewrites_alias_party_messages_onto_the_selected_room() {
        let rest = "p-1@ares-parties.ap1.pvp.net";
        let messages = vec![json!({
            "id": "m-1",
            "conversationId": "p-1@ares-parties.ap",
            "body": "sb",
        })];
        let rewritten = attach_messages_to_rooms(messages, rest, "", "");
        assert_eq!(rewritten[0]["conversationId"], rest);
        assert_eq!(rewritten[0]["body"], "sb");
    }

    #[test]
    fn classifies_stopped_riot_client_as_login_required() {
        assert!(is_login_required_error(
			"error sending request for url (https://127.0.0.1:61867/entitlements/v1/token): connection refused"
		));
        assert!(is_login_required_error("Riot lockfile was not found"));
        assert!(!is_login_required_error(
            "message history payload was malformed"
        ));
    }

    /// A signed-out player has a *running* Riot Client, so none of the
    /// "client is down" signals fire — the chat routes just 503. Without this
    /// case the frontend printed the raw RPC error instead of asking them to
    /// sign in.
    #[test]
    fn classifies_disconnected_chat_service_as_login_required() {
        assert!(is_login_required_error(
			"Riot Client request failed (503 Service Unavailable) for /chat/v4/friends: {\"errorCode\":\"RPC_ERROR\",\"httpStatus\":503,\"implementationDetails\":{},\"message\":\"not connected to chat, service unavailable\"}"
		));
        assert!(is_login_required_error(
            "Riot Client request failed (503 Service Unavailable) for /chat/v6/messages: \
             {\"message\":\"not connected to chat, service unavailable\"}"
        ));
        // A 503 that isn't about the chat socket is a real outage, not a login.
        assert!(!is_login_required_error(
            "Riot Client request failed (503 Service Unavailable) for /chat/v4/friends: \
             {\"message\":\"backend timeout\"}"
        ));
    }

    #[test]
    fn missing_message_ids_use_content_identity_instead_of_response_index() {
        let payload = json!({"messages": [{
            "cid": "friend-cid",
            "sender": "friend",
            "message": "hello",
            "timestamp": "2000"
        }]});
        let messages = normalize_messages(
            &payload,
            &HashMap::new(),
            &RoomScopes::default(),
            &HashSet::new(),
            "self",
            &HashMap::new(),
        );
        assert_eq!(messages[0]["id"], "");
        assert_eq!(
            unique_messages(vec![messages[0].clone(), messages[0].clone()]).len(),
            1
        );
    }

    /// Riot labels party messages with the sender's PUUID rather than a name,
    /// so anything the app cannot look up renders as a raw uuid in the thread.
    #[test]
    fn a_puuid_sender_name_is_replaced_by_the_known_display_name() {
        let own = "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1";
        let mate = "0f8b1a2c-1111-2222-3333-444455556666";
        let payload = json!({"messages": [
            {
                "cid": "party@ares-parties.ap",
                "sender": own,
                // Riot echoes the puuid in the name slot for party rooms.
                "name": own,
                "message": "e",
                "timestamp": "2000"
            },
            {
                "cid": "party@ares-parties.ap",
                "sender": mate,
                "name": mate,
                "message": "queue?",
                "timestamp": "2100"
            }
        ]});
        let names = HashMap::from([
            (own.to_string(), "習慣被依賴づ#JP1".to_string()),
            (mate.to_string(), "ALEKSANDAR#4830".to_string()),
        ]);

        let messages = normalize_messages(
            &payload,
            &HashMap::new(),
            &RoomScopes::default(),
            &HashSet::new(),
            own,
            &names,
        );

        // Our own line is the one that had nothing to resolve against before:
        // the local player is never in their own friends list.
        assert_eq!(messages[0]["senderName"], "習慣被依賴づ#JP1");
        assert_eq!(messages[0]["isSelf"], true);
        assert_eq!(messages[1]["senderName"], "ALEKSANDAR#4830");
    }

    #[test]
    fn a_real_display_name_is_never_overwritten_by_the_lookup() {
        let sender = "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1";
        let payload = json!({"messages": [{
            "cid": "friend-cid",
            "sender": sender,
            "name": "Riot Provided Name",
            "message": "hello",
            "timestamp": "2000"
        }]});
        let names = HashMap::from([(sender.to_string(), "Stale Cached Name".to_string())]);

        let messages = normalize_messages(
            &payload,
            &HashMap::new(),
            &RoomScopes::default(),
            &HashSet::new(),
            "self",
            &names,
        );

        assert_eq!(messages[0]["senderName"], "Riot Provided Name");
    }

    #[test]
    fn an_unknown_puuid_still_falls_back_to_the_id_rather_than_going_blank() {
        let sender = "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1";
        let payload = json!({"messages": [{
            "cid": "party@ares-parties.ap",
            "sender": sender,
            "name": sender,
            "message": "e",
            "timestamp": "2000"
        }]});

        let messages = normalize_messages(
            &payload,
            &HashMap::new(),
            &RoomScopes::default(),
            &HashSet::new(),
            "self",
            &HashMap::new(),
        );

        assert_eq!(messages[0]["senderName"], sender);
    }

    #[test]
    fn puuid_shaped_names_are_told_apart_from_real_ones() {
        assert!(looks_like_puuid("869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1"));
        assert!(looks_like_puuid("869D5298-DB1D-54CC-BCAF-6C2A8BB1B6A1"));
        // A Riot ID with hyphens in it must not be mistaken for an id.
        assert!(!looks_like_puuid("習慣被依賴づ#JP1"));
        assert!(!looks_like_puuid("Some-Player#NA1"));
        assert!(!looks_like_puuid(""));
    }

    #[test]
    fn treats_mobile_only_presence_as_offline() {
        let friends = vec![json!({
            "puuid": "friend-puuid",
            "game_name": "BoBoGam3r",
            "game_tag": "trAsh"
        })];
        let presences = vec![json!({
            "puuid": "friend-puuid",
            "product": "league_of_legends",
            "state": "mobile"
        })];

        let live = chat_presence_snapshot(xmpp::presence::PresenceSyncState::Ready, Vec::new());
        let result = normalize_friends(&friends, &presences, &live);

        assert_eq!(result[0]["isOnline"], false);
    }

    #[test]
    fn ready_xmpp_snapshot_overrides_stale_rest_online() {
        let friends = [json!({ "puuid": "friend", "game_name": "Friend" })];
        let stale = [json!({
            "puuid": "friend",
            "product": "riot_client",
            "state": "chat"
        })];
        let live = chat_presence_snapshot(xmpp::presence::PresenceSyncState::Ready, Vec::new());

        let result = normalize_friends(&friends, &stale, &live);

        assert_eq!(result[0]["presenceState"], "ready");
        assert_eq!(result[0]["isOnline"], false);
    }

    #[test]
    fn live_xmpp_resource_supplies_current_game_state() {
        let friends = [json!({ "puuid": "friend", "game_name": "Friend" })];
        let live = chat_presence_snapshot(
            xmpp::presence::PresenceSyncState::Ready,
            vec![live_resource("friend", "valorant", "INGAME")],
        );

        let result = normalize_friends(&friends, &[], &live);

        assert_eq!(result[0]["isOnline"], true);
        assert_eq!(result[0]["product"], "valorant");
        assert_eq!(result[0]["sessionLoopState"], "INGAME");
    }

    #[test]
    fn syncing_snapshot_never_confirms_stale_online() {
        let friends = [json!({ "puuid": "friend", "game_name": "Friend" })];
        let stale = [json!({
            "puuid": "friend",
            "product": "riot_client",
            "state": "chat"
        })];
        let live = chat_presence_snapshot(xmpp::presence::PresenceSyncState::Syncing, Vec::new());

        let result = normalize_friends(&friends, &stale, &live);

        assert_eq!(result[0]["presenceState"], "syncing");
        assert_eq!(result[0]["isOnline"], false);
    }

    #[test]
    fn prefers_active_valorant_presence_over_mobile_presence() {
        let friends = vec![json!({
            "puuid": "friend-puuid",
            "game_name": "Friend",
            "game_tag": "1234"
        })];
        let presences = vec![
            json!({
                "puuid": "friend-puuid",
                "product": "valorant",
                "state": "dnd"
            }),
            json!({
                "puuid": "friend-puuid",
                "product": "league_of_legends",
                "state": "mobile"
            }),
        ];

        let mut valorant = live_resource("friend-puuid", "valorant", "");
        valorant.status = "dnd".into();
        let live = chat_presence_snapshot(xmpp::presence::PresenceSyncState::Ready, vec![valorant]);
        let result = normalize_friends(&friends, &presences, &live);

        assert_eq!(result[0]["isOnline"], true);
        assert_eq!(result[0]["product"], "valorant");
        assert_eq!(result[0]["status"], "dnd");
    }

    #[test]
    fn extracts_chat_friend_session_loop_state_from_match_presence() {
        let private = base64::engine::general_purpose::STANDARD
            .encode(json!({ "matchPresenceData": { "sessionLoopState": "INGAME" } }).to_string());
        let result = normalize_friends(
            &[json!({ "puuid": "friend", "game_name": "Friend" })],
            &[json!({
                "puuid": "friend",
                "product": "valorant",
                "state": "dnd",
                "private": private
            })],
            &chat_presence_snapshot(
                xmpp::presence::PresenceSyncState::Ready,
                vec![live_resource("friend", "valorant", "")],
            ),
        );

        assert_eq!(result[0]["sessionLoopState"], "INGAME");
    }

    #[test]
    fn falls_back_to_legacy_root_session_loop_state() {
        let private = base64::engine::general_purpose::STANDARD
            .encode(json!({ "sessionLoopState": "MENUS" }).to_string());
        let result = normalize_friends(
            &[json!({ "puuid": "friend", "game_name": "Friend" })],
            &[json!({
                "puuid": "friend",
                "product": "valorant",
                "state": "chat",
                "private": private
            })],
            &chat_presence_snapshot(
                xmpp::presence::PresenceSyncState::Ready,
                vec![live_resource("friend", "valorant", "")],
            ),
        );

        assert_eq!(result[0]["sessionLoopState"], "MENUS");
    }
}
