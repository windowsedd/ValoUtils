use crate::riot::api;
use crate::riot::client::{self as riot_client, RiotState};
use crate::store::ConfigStore;
use crate::translate;
use crate::xmpp;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use tauri::State;

fn arg(args: &[Value], index: usize) -> Option<String> {
    args.get(index).and_then(|v| v.as_str()).map(|s| s.to_string())
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

fn get_send_type(conversation_id: &str) -> &'static str {
    let lower = conversation_id.to_lowercase();
    if lower.contains("@ares-parties.") || lower.contains("@ares-pregame.") || lower.contains("@ares-coregame.") || lower.contains("@ares-") {
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
            let id = pick_string([c.get("cid"), c.get("id"), c.get("conversationId"), c.get("ConversationID")].map(|v| v.and_then(|v| v.as_str())));
            (!id.is_empty()).then_some(id)
        })
        .collect()
}

fn normalize_conversation_map(payload: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for c in conversations_array(payload) {
        let id = pick_string([c.get("cid"), c.get("id"), c.get("conversationId"), c.get("ConversationID")].map(|v| v.and_then(|v| v.as_str())));
        if id.is_empty() {
            continue;
        }
        let label = [c.get("type"), c.get("Type"), c.get("name"), c.get("Name"), c.get("game_name"), c.get("resource"), c.get("channel")]
            .into_iter()
            .filter_map(|v| v.and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
        map.insert(id, label);
    }
    map
}

fn decode_presence_private(value: &str) -> Value {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(json!({}))
}

fn normalize_friends(friends_payload: &[Value], presences_payload: &[Value]) -> Vec<Value> {
    let mut presences: HashMap<String, &Value> = HashMap::new();
    for presence in presences_payload {
        let puuid = pick_string([presence.get("puuid"), presence.get("PUUID"), presence.get("pid"), presence.get("PID")].map(|v| v.and_then(|v| v.as_str())));
        if !puuid.is_empty() {
            presences.insert(id_root(&puuid), presence);
        }
    }

    let mut result: Vec<Value> = friends_payload
        .iter()
        .filter_map(|friend| {
            let puuid = pick_string([friend.get("puuid"), friend.get("PUUID"), friend.get("pid"), friend.get("PID")].map(|v| v.and_then(|v| v.as_str())));
            let empty = json!({});
            let presence = presences.get(&id_root(&puuid)).copied().unwrap_or(&empty);
            let private_str = presence.get("private").and_then(|v| v.as_str());
            let priv_val = private_str.map(decode_presence_private).unwrap_or(json!({}));
            let party = priv_val.get("partyPresenceData").unwrap_or(&priv_val);

            let game_name = pick_string([friend.get("game_name"), friend.get("gameName"), friend.get("GameName"), presence.get("game_name"), presence.get("gameName")].map(|v| v.and_then(|v| v.as_str())));
            let tag_line = pick_string([friend.get("game_tag"), friend.get("gameTag"), friend.get("tagLine"), friend.get("TagLine"), presence.get("game_tag"), presence.get("tagLine")].map(|v| v.and_then(|v| v.as_str())));
            let display_name = if !game_name.is_empty() {
                if tag_line.is_empty() { game_name.clone() } else { format!("{game_name}#{tag_line}") }
            } else {
                pick_string([friend.get("name"), friend.get("displayName")].map(|v| v.and_then(|v| v.as_str())).into_iter().chain([Some(puuid.as_str())]))
            };
            let status = pick_string([presence.get("status"), presence.get("availability"), presence.get("show")].map(|v| v.and_then(|v| v.as_str())));
            let is_online = presence.get("puuid").is_some() && status != "offline";

            if puuid.is_empty() && display_name.is_empty() {
                return None;
            }

            let status_message = pick_string([
                presence.get("statusMessage").and_then(|v| v.as_str()),
                presence.get("status_message").and_then(|v| v.as_str()),
                party.get("sessionLoopState").and_then(|v| v.as_str()),
                party.get("state").and_then(|v| v.as_str()),
            ]);
            let product = pick_string([presence.get("product"), presence.get("Product")].map(|v| v.and_then(|v| v.as_str())));
            let queue_id = pick_string([
                party.get("queueId").and_then(|v| v.as_str()),
                party.get("queueID").and_then(|v| v.as_str()),
                party.get("queue").and_then(|v| v.as_str()),
            ]);
            let party_id = pick_string([party.get("partyId").and_then(|v| v.as_str()), priv_val.get("partyId").and_then(|v| v.as_str())]);
            let party_size = party.get("partySize").cloned().unwrap_or(Value::Null);
            let max_party_size = party.get("maxPartySize").cloned().unwrap_or(Value::Null);
            let status_final = if status.is_empty() { "offline".to_string() } else { status };

            Some(json!({
                "puuid": puuid,
                "gameName": game_name,
                "tagLine": tag_line,
                "displayName": display_name,
                "status": status_final,
                "statusMessage": status_message,
                "product": product,
                "queueId": queue_id,
                "partyId": party_id,
                "partySize": party_size,
                "maxPartySize": max_party_size,
                "isOnline": is_online,
            }))
        })
        .collect();

    result.sort_by(|a, b| {
        let a_online = a.get("isOnline").and_then(|v| v.as_bool()).unwrap_or(false);
        let b_online = b.get("isOnline").and_then(|v| v.as_bool()).unwrap_or(false);
        b_online.cmp(&a_online).then_with(|| {
            let a_name = a.get("displayName").and_then(|v| v.as_str()).unwrap_or_default();
            let b_name = b.get("displayName").and_then(|v| v.as_str()).unwrap_or_default();
            a_name.cmp(b_name)
        })
    });
    result
}

struct RoomScopes {
    party: HashSet<String>,
    matches: HashSet<String>,
    rooms: Map<String, Value>,
}

fn split_match_rooms(ids: &HashSet<String>) -> (String, String, String) {
    let rooms: Vec<&String> = ids.iter().collect();
    let all = rooms.iter().find(|r| r.to_lowercase().contains("-all@ares-coregame")).cloned();
    let team = rooms
        .iter()
        .find(|r| {
            let lower = r.to_lowercase();
            lower.contains("-blue@ares-coregame") || lower.contains("-red@ares-coregame")
        })
        .or_else(|| rooms.iter().find(|r| Some(*r) != all.as_ref()))
        .cloned();
    let team_s = team.cloned().unwrap_or_default();
    let all_s = all.cloned().unwrap_or_default();
    let match_s = if !team_s.is_empty() { team_s.clone() } else { all_s.clone() };
    (match_s, team_s, all_s)
}

fn extract_party_rooms_from_conversations(payload: &Value, party: &mut HashSet<String>, match_rooms: &HashSet<String>) {
    for c in conversations_array(payload) {
        let id = pick_string([c.get("cid"), c.get("id"), c.get("conversationId"), c.get("ConversationID")].map(|v| v.and_then(|v| v.as_str())));
        let ctype = pick_string([c.get("type"), c.get("Type")].map(|v| v.and_then(|v| v.as_str())));
        if !id.is_empty() && ctype == "groupchat" && !match_rooms.contains(&id) && !id.to_lowercase().contains("ares-coregame") && !id.to_lowercase().contains("ares-pregame") {
            party.insert(id);
        }
    }
}

async fn add_party_room_from_active_party(riot: &RiotState, party: &mut HashSet<String>) {
    let Ok(api) = api::create_api(riot).await else { return };
    let Ok(partyplayer) = api.party_get_by_player(&api.puuid).await else { return };
    let party_id = pick_string([partyplayer.get("CurrentPartyID"), partyplayer.get("PartyID")].map(|v| v.and_then(|v| v.as_str())));
    if party_id.is_empty() {
        return;
    }
    if let Ok(token) = api.party_get_chat_token(&party_id).await {
        let room = pick_string([token.get("Room"), token.get("room")].map(|v| v.and_then(|v| v.as_str())));
        if !room.is_empty() {
            party.insert(room);
        }
    }
}

async fn get_chat_room_scopes(riot: &RiotState, conversations_payload: Option<&Value>) -> RoomScopes {
    let party_payload = riot_client::get_party_chat_info(riot).await.ok();
    let pregame_payload = riot_client::get_pre_game_chat_info(riot).await.ok();
    let current_game_payload = riot_client::get_current_game_chat_info(riot).await.ok();

    let pregame = pregame_payload.as_ref().map(collect_conversation_ids).unwrap_or_default();
    let current_game = current_game_payload.as_ref().map(collect_conversation_ids).unwrap_or_default();
    let matches: HashSet<String> = pregame.union(&current_game).cloned().collect();
    let mut party = party_payload.as_ref().map(collect_conversation_ids).unwrap_or_default();
    if let Some(payload) = conversations_payload {
        extract_party_rooms_from_conversations(payload, &mut party, &matches);
    }
    add_party_room_from_active_party(riot, &mut party).await;

    let (match_room, match_team, match_all) = split_match_rooms(&matches);
    let first_party = party.iter().next().cloned().unwrap_or_default();
    let first_current_or_pregame = current_game.iter().next().or_else(|| pregame.iter().next()).cloned().unwrap_or_default();

    let mut rooms = Map::new();
    rooms.insert("party".into(), json!(first_party));
    rooms.insert("matchTeam".into(), json!(match_team));
    rooms.insert("matchAll".into(), json!(match_all));
    rooms.insert("match".into(), json!(if !match_room.is_empty() { match_room } else { first_current_or_pregame }));

    RoomScopes { party, matches, rooms }
}

async fn get_current_match_player_ids(riot: &RiotState) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(api) = api::create_api(riot).await else { return ids };

    if let Ok(core_player) = api.coregame_get_player(&api.puuid).await {
        if let Some(match_id) = core_player.get("MatchID").and_then(|v| v.as_str()) {
            if let Ok(m) = api.coregame_get_match(match_id).await {
                for p in m.get("Players").and_then(|v| v.as_array()).into_iter().flatten() {
                    let subject = pick_string([p.get("Subject"), p.get("PUUID")].map(|v| v.and_then(|v| v.as_str())));
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
                let ally = m.pointer("/AllyTeam/Players").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                let enemy = m.pointer("/EnemyTeam/Players").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                for p in ally.iter().chain(enemy.iter()) {
                    let subject = pick_string([p.get("Subject"), p.get("PUUID")].map(|v| v.and_then(|v| v.as_str())));
                    if !subject.is_empty() {
                        ids.insert(id_root(&subject));
                    }
                }
            }
        }
    }
    ids
}

fn get_message_scope(message: &Value, conversation_id: &str, conversations: &HashMap<String, String>, scopes: &RoomScopes, match_player_ids: &HashSet<String>) -> &'static str {
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
        conversations.get(conversation_id).map(|s| s.as_str()).unwrap_or(""),
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
    payload.get("messages").or_else(|| payload.get("Messages")).or_else(|| payload.get("data")).and_then(|v| v.as_array()).cloned().unwrap_or_default()
}

fn normalize_messages(payload: &Value, conversations: &HashMap<String, String>, scopes: &RoomScopes, match_player_ids: &HashSet<String>, own_puuid: &str) -> Vec<Value> {
    messages_array(payload)
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let body = pick_string([message.get("body"), message.get("Body"), message.get("message"), message.get("Message"), message.get("text")].map(|v| v.and_then(|v| v.as_str())));
            if body.is_empty() {
                return None;
            }
            let sender = pick_string([message.get("sender"), message.get("from"), message.get("From"), message.get("senderId"), message.get("SenderID"), message.get("puuid")].map(|v| v.and_then(|v| v.as_str())));
            let sender_root = id_root(&if !sender.is_empty() { sender.clone() } else { pick_string([message.get("pid"), message.get("PID")].map(|v| v.and_then(|v| v.as_str()))) });
            let is_self = !own_puuid.is_empty() && sender_root == id_root(own_puuid);
            let timestamp = pick_string([message.get("time"), message.get("timestamp"), message.get("Timestamp"), message.get("createdAt"), message.get("receivedTime")].map(|v| v.and_then(|v| v.as_str())));
            let conversation_id = pick_string([message.get("cid"), message.get("conversationId"), message.get("ConversationID"), message.get("room"), message.get("Room")].map(|v| v.and_then(|v| v.as_str())));
            let sender_name = pick_string([message.get("game_name"), message.get("gameName"), message.get("senderName"), message.get("name")].map(|v| v.and_then(|v| v.as_str())));
            let id = pick_string([message.get("id"), message.get("ID"), message.get("messageId"), message.get("MessageID")].map(|v| v.and_then(|v| v.as_str())));
            let id_final = if id.is_empty() {
                let prefix = if timestamp.is_empty() { "message".to_string() } else { timestamp.clone() };
                format!("{prefix}-{index}")
            } else {
                id
            };
            let sender_name_final = if sender_name.is_empty() { sender.clone() } else { sender_name };
            let timestamp_final = if timestamp.is_empty() { Value::Null } else { json!(timestamp) };
            let msg_type = pick_string([message.get("type"), message.get("Type")].map(|v| v.and_then(|v| v.as_str())));
            let msg_type_final = if msg_type.is_empty() { "chat".to_string() } else { msg_type };
            let scope = get_message_scope(message, &conversation_id, conversations, scopes, match_player_ids);

            Some(json!({
                "id": id_final,
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
            let key = format!(
                "{}:{}:{}",
                m.get("conversationId").and_then(|v| v.as_str()).unwrap_or(""),
                m.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                m.get("body").and_then(|v| v.as_str()).unwrap_or("")
            );
            seen.insert(key)
        })
        .collect()
}

#[tauri::command]
pub async fn chat_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    let result: Result<Value, String> = async {
        let base_payload = riot_client::get_chat_messages(&riot, None).await?;
        let conversations_payload = riot_client::get_chat_conversations(&riot).await.ok();
        let friends_payload = riot_client::get_friends(&riot).await.unwrap_or_default();
        let presences_payload = crate::riot::client::get_presences(&riot).await.unwrap_or_default();

        let conversations = conversations_payload.as_ref().map(normalize_conversation_map).unwrap_or_default();
        let friends = normalize_friends(&friends_payload, &presences_payload);
        let mut scopes = get_chat_room_scopes(&riot, conversations_payload.as_ref()).await;
        let match_player_ids = get_current_match_player_ids(&riot).await;
        let tokens = crate::riot::client::get_tokens(&riot, false).await.ok();
        let own_puuid = tokens.as_ref().and_then(|t| t.get("subject")).and_then(|v| v.as_str()).unwrap_or("").to_string();

        if scopes.rooms.get("party").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
            for msg in messages_array(&base_payload) {
                let cid = pick_string([msg.get("cid"), msg.get("conversationId"), msg.get("ConversationID")].map(|v| v.and_then(|v| v.as_str())));
                let msg_type = pick_string([msg.get("type"), msg.get("Type")].map(|v| v.and_then(|v| v.as_str())));
                if !cid.is_empty() && msg_type == "groupchat" && !scopes.matches.contains(&cid) && !cid.to_lowercase().contains("ares-coregame") && !cid.to_lowercase().contains("ares-pregame") {
                    scopes.party.insert(cid.clone());
                    scopes.rooms.insert("party".into(), json!(cid));
                    break;
                }
            }
        }

        let party_room_str = scopes.rooms.get("party").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let party_payload = if !party_room_str.is_empty() { riot_client::get_chat_messages(&riot, Some(&party_room_str)).await.ok() } else { None };

        let needs_xmpp_match_rooms = scopes.rooms.get("matchTeam").and_then(|v| v.as_str()).unwrap_or("").is_empty()
            || scopes.rooms.get("matchAll").and_then(|v| v.as_str()).unwrap_or("").is_empty();
        let xmpp_match_rooms = if needs_xmpp_match_rooms { xmpp::ensure_match_xmpp_chat(&riot).await.unwrap_or_default() } else { (None, None) };
        let (party_room, party_debug) = xmpp::ensure_party_xmpp_chat(&riot).await;

        let xmpp_messages: Vec<Value> = xmpp::get_xmpp_messages().await.into_iter().map(|m| serde_json::to_value(m).unwrap()).collect();

        let mut messages = normalize_messages(&base_payload, &conversations, &scopes, &match_player_ids, &own_puuid);
        if let Some(pp) = &party_payload {
            messages.extend(normalize_messages(pp, &conversations, &scopes, &match_player_ids, &own_puuid));
        }
        messages.extend(xmpp_messages);
        let messages = unique_messages(messages);

        let final_party_room = if !party_room.is_empty() { party_room } else { party_room_str };
        let match_team = scopes.rooms.get("matchTeam").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let match_all = scopes.rooms.get("matchAll").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let base_match = scopes.rooms.get("match").and_then(|v| v.as_str()).unwrap_or("").to_string();

        let match_team_final = xmpp_match_rooms.0.clone().filter(|s| !s.is_empty()).unwrap_or(match_team.clone());
        let match_all_final = xmpp_match_rooms.1.clone().filter(|s| !s.is_empty()).unwrap_or(match_all.clone());
        let match_final = xmpp_match_rooms.0.filter(|s| !s.is_empty()).or_else(|| Some(match_team).filter(|s| !s.is_empty())).or(xmpp_match_rooms.1.filter(|s| !s.is_empty())).unwrap_or(if !match_all.is_empty() { match_all } else { base_match });

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
            "friends": friends,
            "fetchedAt": chrono_iso_now(),
        }))
    }
    .await;

    Ok(match result {
        Ok(v) => v.to_string(),
        Err(e) => {
            let code = if e.contains("lockfile") { json!("loginRequired") } else { Value::Null };
            json!({ "success": false, "code": code, "error": e }).to_string()
        }
    })
}

#[tauri::command]
pub async fn chat_translate(args: Vec<Value>, config: State<'_, ConfigStore>) -> Result<String, ()> {
    let Some(text) = arg(&args, 0) else { return Ok(json!({ "success": false, "error": "no text" }).to_string()) };
    let target_language_arg = arg(&args, 1);

    let provider = config.get("translatorProvider").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_else(|| "google".into());
    let default_target = config.get("translatorTargetLanguage").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_else(|| "en".into());
    let deepl_key = config.get("deeplApiKey").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default();
    let target_language = target_language_arg.filter(|s| !s.is_empty()).unwrap_or(default_target);

    Ok(match translate::translate_text(&text, &provider, &target_language, &deepl_key).await {
        Ok(translated_text) => json!({ "success": true, "translatedText": translated_text, "provider": provider, "targetLanguage": target_language }).to_string(),
        Err(e) => json!({ "success": false, "error": e }).to_string(),
    })
}

#[tauri::command]
pub async fn chat_send(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let Some(conversation_id) = arg(&args, 0).filter(|s| !s.trim().is_empty()) else {
        return Ok(json!({ "success": false, "error": "No chat room selected." }).to_string());
    };
    let Some(message) = arg(&args, 1).filter(|s| !s.trim().is_empty()) else {
        return Ok(json!({ "success": false, "error": "Message is empty." }).to_string());
    };
    let cid = conversation_id.trim().to_string();
    let body = message.trim().to_string();
    let msg_type = get_send_type(&cid);

    let mut transport = "local";
    let rest_result = riot_client::send_chat_message(&riot, &cid, &body, msg_type).await;
    if let Err(rest_err) = rest_result {
        if cid.contains("@ares-parties.") {
            transport = "xmpp";
            if let Err(e) = xmpp::send_party_xmpp_message(&riot, &cid, &body).await {
                return Ok(json!({ "success": false, "error": e }).to_string());
            }
        } else if cid.contains("@ares-coregame.") {
            transport = "xmpp";
            if let Err(e) = xmpp::send_match_xmpp_message(&riot, &cid, &body).await {
                return Ok(json!({ "success": false, "error": e }).to_string());
            }
        } else {
            return Ok(json!({ "success": false, "error": rest_err }).to_string());
        }
    }

    Ok(json!({ "success": true, "cid": cid, "type": msg_type, "transport": transport }).to_string())
}

#[tauri::command]
pub async fn chat_friend_action(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let action = arg(&args, 0).unwrap_or_default();
    let friend = args.get(1).cloned().unwrap_or(json!({}));

    let result: Result<(), String> = async {
        let api = api::create_api(&riot).await?;
        if action == "invite" {
            let game_name = friend.get("gameName").and_then(|v| v.as_str()).unwrap_or_default();
            let tag_line = friend.get("tagLine").and_then(|v| v.as_str()).unwrap_or_default();
            if game_name.is_empty() || tag_line.is_empty() {
                return Err("Friend Riot ID is unavailable.".into());
            }
            let party_player = api.party_get_by_player(&api.puuid).await?;
            let party_id = pick_string([party_player.get("CurrentPartyID"), party_player.get("PartyID")].map(|v| v.and_then(|v| v.as_str())));
            if party_id.is_empty() {
                return Err("You are not in a party.".into());
            }
            api.party_invite(&party_id, game_name, tag_line).await?;
        } else {
            let party_id = friend.get("partyId").and_then(|v| v.as_str()).unwrap_or_default();
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
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (y, m, d, h, mi, s) = crate::util_time::civil_from_unix_secs(secs);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}
