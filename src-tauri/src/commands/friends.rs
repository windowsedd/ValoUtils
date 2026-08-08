use crate::riot::client::{self as riot_client, RiotState};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;

/// Friends list for the Friends tab.
///
/// Three local Riot Client endpoints feed this:
///   * `/chat/v4/friends`        — the roster (name, tag, region, last seen)
///   * `/chat/v4/friendrequests` — pending invites, `subscription` marks direction
///   * `/chat/v4/presences`      — who is online, plus a base64 `private` blob
///     carrying the VALORANT-specific detail (queue, session state, live score,
///     party, player card, competitive tier).
///
/// Presences only exist for online players, so a friend with no matching
/// presence entry is offline — that is the only reliable offline signal here.

fn first_str<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> String {
    for value in values {
        if let Some(s) = value.and_then(|v| v.as_str()) {
            if !s.trim().is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// Presence ids arrive as `<puuid>@<region>.pvp.net`; the roster uses the bare
/// puuid. Strip the domain and case-fold so the two can be joined.
fn id_root(value: &str) -> String {
    value.split('@').next().unwrap_or(value).to_lowercase()
}

fn decode_blob(value: &str) -> Value {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(json!({}))
}

fn display_name(game_name: &str, tag_line: &str, puuid: &str) -> String {
    if game_name.is_empty() {
        return puuid.to_string();
    }
    if tag_line.is_empty() {
        return game_name.to_string();
    }
    format!("{game_name}#{tag_line}")
}

/// The VALORANT slice of a presence, or `null` for friends who are online in
/// another Riot product (League, the client itself) or not online at all.
fn valorant_presence(presence: &Value) -> Option<Value> {
    // Gate on the product, not just on the blob existing: League presences also
    // carry a `private` field (it decodes to `{}`, but don't rely on that).
    if first_str([presence.get("product")]) != "valorant" {
        return None;
    }
    let private = presence.get("private").and_then(|v| v.as_str())?;
    let blob = decode_blob(private);
    if !blob.is_object() || blob.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return None;
    }

    let match_data = blob.get("matchPresenceData").cloned().unwrap_or(json!({}));
    let player = blob.get("playerPresenceData").cloned().unwrap_or(json!({}));

    // `queueId` / `sessionLoopState` live under matchPresenceData on current
    // clients but sat at the blob root on older ones — check both.
    let queue_id = first_str([match_data.get("queueId"), blob.get("queueId")]);
    let session_loop_state = first_str([match_data.get("sessionLoopState"), blob.get("sessionLoopState")]);
    let provisioning_flow = first_str([match_data.get("provisioningFlow"), blob.get("provisioningFlow")]);

    Some(json!({
        "queueId": queue_id,
        "sessionLoopState": session_loop_state,
        "provisioningFlow": provisioning_flow,
        "matchMap": first_str([match_data.get("matchMap")]),
        "allyScore": blob.get("partyOwnerMatchScoreAllyTeam").and_then(|v| v.as_i64()),
        "enemyScore": blob.get("partyOwnerMatchScoreEnemyTeam").and_then(|v| v.as_i64()),
        "partyId": first_str([blob.get("partyId")]),
        "partySize": blob.get("partySize").and_then(|v| v.as_i64()),
        "maxPartySize": blob.get("maxPartySize").and_then(|v| v.as_i64()),
        "isIdle": blob.get("isIdle").and_then(|v| v.as_bool()).unwrap_or(false),
        "playerCardId": first_str([player.get("playerCardId")]),
        "competitiveTier": player.get("competitiveTier").and_then(|v| v.as_i64()),
        "accountLevel": player.get("accountLevel").and_then(|v| v.as_i64()),
    }))
}

/// How much a presence entry is worth when one player has several. Higher wins.
/// A game presence carries the `private` blob; the `riot_client` launcher entry
/// carries nothing and must never displace it.
fn presence_rank(presence: &Value) -> u8 {
    let product = first_str([presence.get("product")]);
    let has_private = presence
        .get("private")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    match (product.as_str(), has_private) {
        ("valorant", true) => 4,
        (_, true) => 3,        // in another Riot game
        ("riot_client", _) => 1,
        _ => 2,
    }
}

fn normalize_request(request: &Value) -> Option<Value> {
    let puuid = first_str([request.get("puuid"), request.get("pid")]);
    let game_name = first_str([request.get("game_name"), request.get("gameName")]);
    let tag_line = first_str([request.get("game_tag"), request.get("gameTag")]);
    if puuid.is_empty() && game_name.is_empty() {
        return None;
    }
    // "pending_in" = they invited us, "pending_out" = we invited them.
    let subscription = first_str([request.get("subscription")]);
    let direction = if subscription == "pending_out" { "outgoing" } else { "incoming" };

    Some(json!({
        "puuid": id_root(&puuid),
        "gameName": game_name,
        "tagLine": tag_line,
        "displayName": display_name(&game_name, &tag_line, &puuid),
        "region": first_str([request.get("region")]),
        "direction": direction,
        "note": first_str([request.get("note")]),
    }))
}

#[tauri::command]
pub async fn friends_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    let result: Result<Value, String> = async {
        // The roster is the only hard requirement; presences and requests are
        // best-effort so a hiccup in either still renders a usable list.
        let friends_payload = riot_client::get_friends(&riot).await?;
        let presences_payload = riot_client::get_presences(&riot).await.unwrap_or_default();
        let requests_payload = riot_client::get_friend_requests(&riot).await.unwrap_or_default();

        // A player has ONE presence entry per running Riot product, so someone in
        // a VALORANT match shows up twice: once as `valorant` (with the `private`
        // blob) and once as `riot_client` (empty, from the launcher sitting in the
        // background). Keeping whichever arrives last would randomly discard the
        // game presence and drop in-game friends off the list entirely — pick the
        // most informative entry instead.
        let mut presences: HashMap<String, &Value> = HashMap::new();
        for presence in &presences_payload {
            let puuid = first_str([presence.get("puuid"), presence.get("pid")]);
            if puuid.is_empty() {
                continue;
            }
            presences
                .entry(id_root(&puuid))
                .and_modify(|existing| {
                    if presence_rank(presence) > presence_rank(existing) {
                        *existing = presence;
                    }
                })
                .or_insert(presence);
        }

        let empty = json!({});
        let mut friends: Vec<Value> = friends_payload
            .iter()
            .filter_map(|friend| {
                let puuid = first_str([friend.get("puuid"), friend.get("pid")]);
                let game_name = first_str([friend.get("game_name"), friend.get("gameName")]);
                let tag_line = first_str([friend.get("game_tag"), friend.get("gameTag")]);
                if puuid.is_empty() && game_name.is_empty() {
                    return None;
                }

                let presence = presences.get(&id_root(&puuid)).copied().unwrap_or(&empty);
                let has_presence = presence.get("puuid").is_some() || presence.get("pid").is_some();
                let state = first_str([presence.get("state")]);
                let product = first_str([presence.get("product")]);
                let valorant = valorant_presence(presence);

                // `product` alone only says which client is open — 39 friends can
                // report "league_of_legends" while merely sitting in the launcher.
                // A *present* `private` field is what marks someone as actually in
                // the game, and it's how the Riot Client itself decides which
                // friends to list under a game heading. (For non-VALORANT products
                // the field decodes to `{}`, so test the field, not the contents.)
                let playing = presence
                    .get("private")
                    .and_then(|v| v.as_str())
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);

                Some(json!({
                    "puuid": id_root(&puuid),
                    "gameName": game_name,
                    "tagLine": tag_line,
                    "displayName": display_name(&game_name, &tag_line, &puuid),
                    "region": first_str([friend.get("region")]),
                    "note": first_str([friend.get("note")]),
                    "lastOnline": friend.get("last_online_ts").and_then(|v| v.as_i64()),
                    // "chat" = online, "away" = idle, "dnd" = busy (VALORANT sets
                    // this in-match), "mobile" = phone app.
                    "state": state,
                    "product": product,
                    "isOnline": has_presence,
                    "playing": playing,
                    "valorant": valorant,
                }))
            })
            .collect();

        friends.sort_by(|a, b| {
            let name = |v: &Value| v.get("displayName").and_then(|v| v.as_str()).unwrap_or_default().to_lowercase();
            name(a).cmp(&name(b))
        });

        let requests: Vec<Value> = requests_payload.iter().filter_map(normalize_request).collect();

        Ok(json!({
            "success": true,
            "friends": friends,
            "requests": requests,
            "fetchedAt": now_iso(),
        }))
    }
    .await;

    Ok(match result {
        Ok(value) => value.to_string(),
        Err(e) => {
            let code = if e.contains("lockfile") { json!("loginRequired") } else { Value::Null };
            json!({ "success": false, "code": code, "error": e }).to_string()
        }
    })
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d, h, mi, s) = crate::util_time::civil_from_unix_secs(secs);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}
