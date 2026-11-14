//! Tools for the local MCP server (`crate::mcp`) and the Settings commands
//! that control it. Each tool reuses an existing command, so it shares that
//! command's PD client, rate budget and auth retry. All are read-only except
//! `open_riot_client` and `open_valorant`, which start the Riot Client (and
//! the game) like the app's launch buttons.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use super::bot_template::{fetch_public_json, rank_label};
use crate::riot::client::RiotState;
use crate::store::{CacheStore, ConfigStore, ProfilesStore};

/// Item names come from the public valorant-api.com catalog; a slow catalog
/// leaves names out rather than holding the reply.
const NAME_LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);

/// Each match beyond the list costs one match-details request (cached after).
const MATCH_HISTORY_MAX: u64 = 10;

const LOGIN_MESSAGE: &str =
    "Riot Client isn't running or isn't signed in. Open it and sign in, then try again.";

fn tool(name: &str, title: &str, description: &str) -> Value {
    let input = json!({ "type": "object", "properties": {}, "additionalProperties": false });
    tool_with_input(name, title, description, input)
}

fn tool_with_input(name: &str, title: &str, description: &str, input: Value) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input,
        "annotations": { "readOnlyHint": true, "openWorldHint": false },
    })
}

/// One string property, optionally required.
fn string_input(property: &str, description: &str, required: bool) -> Value {
    let mut input = json!({
        "type": "object",
        "properties": { property: { "type": "string", "description": description } },
        "additionalProperties": false,
    });
    if required {
        input["required"] = json!([property]);
    }
    input
}

pub fn tool_list() -> Vec<Value> {
    vec![
        tool(
            "get_player_overview",
            "Player overview",
            "Your account overview: Riot ID, PUUID, region, account level, current rank and RR, rank shields, this act's wins, games, win rate and leaderboard position, peak rank (with its act), rank per act, and recent competitive games with the RR gained or lost plus a net RR summary.",
        ),
        tool(
            "get_live_match",
            "Live match",
            "The current agent select or match: map, mode, phase, and for each player their agent, rank, RR, peak rank, level and recent form. Players are labelled You / Ally N / Enemy N.",
        ),
        tool(
            "get_store",
            "Store",
            "Today's store offers with skin names and prices, every featured bundle (often two at once) with name, price and time left, the Night Market when it's open, accessory offers, and wallet balances (VP, Radianite, Kingdom Credits).",
        ),
        tool(
            "get_battle_pass",
            "Battle pass",
            "Your active act battle pass and event passes: name, tier reached out of total, XP toward the next tier, whole-pass XP and percent, premium owned, days left, and the next rewards by name with the tier and XP needed for each. Also the active agent recruitment event, if any.",
        ),
        tool(
            "list_settings_profiles",
            "Settings profiles",
            "Names and dates of the Valorant settings profiles saved in ValoUtils.",
        ),
        tool_with_input(
            "get_settings_profile",
            "Settings profile",
            "The decoded Valorant settings (sensitivity, keybinds, video, audio and so on) and crosshair profiles of a saved ValoUtils profile, or of the signed-in account when no name is given.",
            string_input(
                "name",
                "Saved profile name from list_settings_profiles. Leave out for the account's current settings.",
                false,
            ),
        ),
        tool_with_input(
            "lookup_player",
            "Look up a player",
            "Any player's Riot ID, current and peak competitive rank, RR, rank per act and recent matches, by Riot ID (Name#Tag) or PUUID. Same lookup as the ValoUtils Tools page.",
            string_input("player", "Riot ID like Name#Tag, or a player PUUID.", true),
        ),
        tool_with_input(
            "get_match_history",
            "Match history",
            "Your most recent matches in any mode: map, mode, agent, result and score, K/D/A, ACS, ADR, headshot % and first bloods. Use a matchId with get_match_details for the full scoreboard.",
            json!({
                "type": "object",
                "properties": { "count": {
                    "type": "integer", "minimum": 1, "maximum": MATCH_HISTORY_MAX,
                    "description": "How many recent matches, newest first. Default 5."
                } },
                "additionalProperties": false,
            }),
        ),
        tool_with_input(
            "get_match_details",
            "Match scoreboard",
            "The full scoreboard of one finished match: map, mode, length, result and rounds, and every player's agent, rank, K/D/A, ACS, ADR, headshot % and first bloods. Players are labelled You / Ally N / Enemy N, never by name.",
            string_input("matchId", "Match ID from get_match_history or get_player_overview.", true),
        ),
        tool(
            "get_friends",
            "Friends",
            "Your Riot friends: who is online, who is in Valorant and what they are doing (queue, map, score, party size), plus their rank and level when Riot shares them, and pending friend requests.",
        ),
        tool(
            "get_account_status",
            "Account status",
            "Penalties on your account (type, reason, expiry, games remaining) and behaviour interventions Riot reports.",
        ),
        tool(
            "get_agent_progression",
            "Agent progression",
            "Your progression level and points per agent (Riot's agent mastery system).",
        ),
        {
            let mut client = tool(
                "open_riot_client",
                "Open Riot Client",
                "Opens the Riot Client through ValoUtils' XMPP relay without launching a game, so ValoUtils chat, presence and bot commands work out of game. Fails if the Riot Client is already running; close it completely first.",
            );
            client["annotations"] = json!({
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            });
            client
        },
        {
            let mut launch = tool_with_input(
                "open_valorant",
                "Open Valorant",
                "Launches Valorant through the Riot Client, like the app's launch buttons. The default \"relay\" mode is Launch with XMPP relay, which ValoUtils chat, presence and bot commands need; \"normal\" is a plain startup. Fails if the Riot Client is already running; close it completely first.",
                json!({
                    "type": "object",
                    "properties": { "mode": {
                        "type": "string",
                        "enum": ["relay", "normal"],
                        "description": "relay (default): Launch with XMPP relay. normal: Normal startup without the relay."
                    } },
                    "additionalProperties": false,
                }),
            );
            launch["annotations"] = json!({
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            });
            launch
        },
    ]
}

fn text_result(value: &Value, is_error: bool) -> Value {
    let text = match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// Turns a command's `{ success: false, ... }` reply into a readable error.
fn failure_message(reply: &Value) -> Option<String> {
    if reply.get("success") != Some(&json!(false)) && reply.get("error").is_none() {
        return None;
    }
    Some(match reply.get("code").and_then(Value::as_str) {
        Some("loginRequired") => LOGIN_MESSAGE.into(),
        Some("rateLimited") => match reply.get("retryInSeconds").and_then(Value::as_u64) {
            Some(seconds) => format!("Riot is rate limiting requests. Try again in {seconds} s."),
            None => "Riot is rate limiting requests. Try again shortly.".into(),
        },
        _ => reply
            .get("error")
            .map(|error| match error {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "The request failed.".into()),
    })
}

fn command_result(reply: Value, shape: impl FnOnce(Value) -> Value) -> Value {
    match failure_message(&reply) {
        Some(message) => text_result(&json!(message), true),
        None => text_result(&shape(reply), false),
    }
}

/// `None` for a tool name this server doesn't have.
pub async fn call_tool(app: &AppHandle, name: &str, arguments: &Value) -> Option<Value> {
    let riot = || app.state::<RiotState>();
    Some(match name {
        "get_player_overview" => {
            let reply = super::career::career_get(riot()).await.unwrap_or(Value::Null);
            // Tokens are cached by now, so this is local only.
            let region = crate::riot::api::create_api(&riot()).await.ok().map(|api| api.region);
            command_result(reply, |career| player_overview(career, region.as_deref()))
        }
        "get_live_match" => match super::bot_template::ask_game_context(app).await {
            Some(context) => text_result(&json!(context), false),
            None => text_result(
                &json!("Not in agent select or a match right now (or Riot Client isn't signed in)."),
                false,
            ),
        },
        "get_store" => {
            let reply = super::store::store_get(riot(), app.state::<CacheStore>())
                .await
                .unwrap_or(Value::Null);
            match failure_message(&reply) {
                Some(message) => text_result(&json!(message), true),
                None => text_result(&with_item_names(reply).await, false),
            }
        }
        "get_battle_pass" => {
            let reply = super::battlepass::battlepass_get(riot()).await.unwrap_or(Value::Null);
            match failure_message(&reply) {
                Some(message) => text_result(&json!(message), true),
                None => text_result(&battle_pass_summary(&reply).await, false),
            }
        }
        "list_settings_profiles" => {
            let profiles = app.state::<ProfilesStore>().get("profiles");
            text_result(&profile_summaries(profiles.as_ref()), false)
        }
        "get_settings_profile" => {
            let name = arguments
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            let reply = match name {
                Some(name) => super::profiles::settings_profile_view(
                    vec![json!(name)],
                    app.state::<ProfilesStore>(),
                ),
                None => super::profiles::settings_current_view(riot())
                    .await
                    .unwrap_or(Value::Null),
            };
            command_result(reply, |mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.remove("success");
                    object.insert(
                        "profile".into(),
                        json!(name.unwrap_or("current account settings")),
                    );
                }
                value
            })
        }
        "lookup_player" => {
            let query = arguments.get("player").and_then(Value::as_str).unwrap_or_default();
            lookup_player(app, query).await
        }
        "get_match_history" => {
            let count = arguments
                .get("count")
                .and_then(Value::as_u64)
                .unwrap_or(5)
                .clamp(1, MATCH_HISTORY_MAX);
            match_history(app, count).await
        }
        "get_match_details" => {
            let id = arguments.get("matchId").and_then(Value::as_str).unwrap_or_default().trim();
            if id.is_empty() {
                text_result(&json!("matchId is required."), true)
            } else {
                match scoreboard(app, id).await {
                    Ok(reduced) => {
                        let (agents, maps) = super::bot_template::content_names().await;
                        text_result(&anonymized_scoreboard(&reduced, &agents, &maps), false)
                    }
                    Err(message) => text_result(&json!(message), true),
                }
            }
        }
        "get_friends" => {
            let reply = super::friends::friends_get(riot()).await.unwrap_or(Value::Null);
            command_result(reply, friend_summaries)
        }
        "get_account_status" => {
            let puuid = crate::riot::client::get_tokens(&riot(), false)
                .await
                .ok()
                .and_then(|tokens| tokens.get("subject").and_then(Value::as_str).map(str::to_owned));
            match puuid {
                None => text_result(&json!(LOGIN_MESSAGE), true),
                Some(puuid) => {
                    let reply = super::career::career_account_status(vec![json!(puuid)], riot())
                        .await
                        .unwrap_or(Value::Null);
                    command_result(reply, |mut value| {
                        if let Some(object) = value.as_object_mut() {
                            object.remove("success");
                        }
                        value
                    })
                }
            }
        }
        "get_agent_progression" => {
            let reply = super::bloomline::bloomline_get(vec![], riot()).await.unwrap_or(Value::Null);
            let (agents, _) = super::bot_template::content_names().await;
            command_result(reply, |reply| agent_progression(&reply, &agents))
        }
        "open_riot_client" => {
            let reply = super::riot_launch::riot_open_client_with_config(vec![], app.state::<ConfigStore>())
                .await
                .unwrap_or(Value::Null);
            command_result(reply, |_| {
                json!("The Riot Client is opening with the XMPP relay. Sign in there; no game is launched.")
            })
        }
        "open_valorant" if super::riot_launch::valorant_running() => {
            text_result(&json!("Valorant is already running."), false)
        }
        "open_valorant" => {
            let target = vec![json!("valorant"), json!("live")];
            let normal = arguments.get("mode").and_then(Value::as_str) == Some("normal");
            let reply = if normal {
                super::riot_launch::riot_launch_normal(target, app.clone(), app.state::<ConfigStore>()).await
            } else {
                super::riot_launch::riot_launch_with_config(target, app.clone(), app.state::<ConfigStore>()).await
            }
            .unwrap_or(Value::Null);
            command_result(reply, |_| {
                json!(if normal {
                    "Valorant is launching (normal startup, without the XMPP relay). Loading takes a minute, and Riot Client may ask you to sign in."
                } else {
                    "Valorant is launching with the XMPP relay. Loading takes a minute, and Riot Client may ask you to sign in."
                })
            })
        }
        _ => return None,
    })
}

/// The reduced scoreboard for one match, from the Matches page cache when it's there.
async fn scoreboard(app: &AppHandle, match_id: &str) -> Result<Value, String> {
    let reply = super::matches::match_details(
        vec![json!(match_id)],
        app.state::<RiotState>(),
        app.state::<super::matches::MatchCache>(),
        app.state::<super::matches::MatchTimelineCache>(),
    )
    .await
    .unwrap_or(Value::Null);
    match failure_message(&reply) {
        Some(message) => Err(message),
        None => reply.get("match").cloned().ok_or_else(|| "No match data.".into()),
    }
}

async fn match_history(app: &AppHandle, count: u64) -> Value {
    let list = super::matches::match_list(vec![json!(0), json!(count)], app.state::<RiotState>())
        .await
        .unwrap_or(Value::Null);
    if let Some(message) = failure_message(&list) {
        return text_result(&json!(message), true);
    }
    let ids: Vec<String> = list
        .get("matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("matchId").and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    let (agents, maps) = super::bot_template::content_names().await;
    let mut matches = Vec::with_capacity(ids.len());
    // One at a time: these share the PD budget with the rest of the app.
    for id in ids {
        matches.push(match scoreboard(app, &id).await {
            Ok(reduced) => own_match_summary(&reduced, &agents, &maps),
            Err(error) => json!({ "matchId": id, "error": error }),
        });
    }
    text_result(&json!({ "matches": matches }), false)
}

fn one_decimal(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_f64) {
        Some(number) => json!((number * 10.0).round() / 10.0),
        None => Value::Null,
    }
}

fn map_name(maps: &HashMap<String, String>, map_id: &str) -> String {
    let key = map_id.to_ascii_lowercase();
    maps.get(&key)
        .or_else(|| key.rsplit('/').find(|part| !part.is_empty()).and_then(|last| maps.get(last)))
        .cloned()
        .unwrap_or_else(|| map_id.rsplit('/').next().unwrap_or(map_id).to_string())
}

fn agent_name(agents: &HashMap<String, String>, agent_id: &str) -> Value {
    match agents.get(&agent_id.to_ascii_lowercase()) {
        Some(name) => json!(name),
        None if agent_id.is_empty() => Value::Null,
        None => json!(agent_id),
    }
}

fn mode_name(reduced: &Value) -> String {
    match reduced.get("queueId").and_then(Value::as_str).unwrap_or_default() {
        "" => "custom".into(),
        queue => queue.into(),
    }
}

/// "win", "loss" or "draw" for `team_id`, plus (mine, best enemy) rounds.
fn team_result(reduced: &Value, team_id: &str) -> (Option<&'static str>, u64, u64) {
    let teams: Vec<&Value> = reduced
        .get("teams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let id = |team: &Value| team.get("teamId").and_then(Value::as_str).unwrap_or_default().to_owned();
    let rounds = |team: &Value| team.get("roundsWon").and_then(Value::as_u64).unwrap_or(0);
    let Some(mine) = teams.iter().find(|team| !team_id.is_empty() && id(team) == team_id) else {
        return (None, 0, 0);
    };
    let enemy = teams.iter().filter(|team| id(team) != team_id).map(|team| rounds(team)).max().unwrap_or(0);
    let won = mine.get("won").and_then(Value::as_bool).unwrap_or(false);
    let result = if won {
        "win"
    } else if rounds(mine) == enemy && !teams.iter().any(|team| team.get("won") == Some(&json!(true))) {
        "draw"
    } else {
        "loss"
    };
    (Some(result), rounds(mine), enemy)
}

fn players(reduced: &Value) -> Vec<&Value> {
    reduced
        .get("players")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|player| player.get("role").and_then(Value::as_str) != Some("coach"))
        .collect()
}

fn stat_line(player: &Value, agents: &HashMap<String, String>) -> serde_json::Map<String, Value> {
    let number = |key: &str| player.get(key).cloned().unwrap_or(Value::Null);
    let tier = player.get("competitiveTier").and_then(Value::as_u64).filter(|tier| *tier > 0);
    let mut line = serde_json::Map::new();
    line.insert(
        "agent".into(),
        agent_name(agents, player.get("characterId").and_then(Value::as_str).unwrap_or_default()),
    );
    line.insert("rank".into(), tier.map(|tier| json!(rank_label(tier))).unwrap_or(Value::Null));
    for key in ["kills", "deaths", "assists", "firstBloods"] {
        line.insert(key.into(), number(key));
    }
    line.insert("acs".into(), one_decimal(player.get("acs")));
    line.insert("adr".into(), one_decimal(player.get("adr")));
    line.insert("headshotPercent".into(), one_decimal(player.get("headshotPercent")));
    line
}

/// One line of match history: the signed-in player's own game.
fn own_match_summary(
    reduced: &Value,
    agents: &HashMap<String, String>,
    maps: &HashMap<String, String>,
) -> Value {
    let me = players(reduced).into_iter().find(|player| player.get("isSelf") == Some(&json!(true)));
    let team_id = me.and_then(|me| me.get("teamId")).and_then(Value::as_str).unwrap_or_default();
    let (result, mine, enemy) = team_result(reduced, team_id);
    let mut summary = serde_json::Map::new();
    summary.insert("matchId".into(), reduced.get("matchId").cloned().unwrap_or(Value::Null));
    summary.insert("startedAtMillis".into(), reduced.get("startMillis").cloned().unwrap_or(Value::Null));
    summary.insert(
        "map".into(),
        json!(map_name(maps, reduced.get("mapId").and_then(Value::as_str).unwrap_or_default())),
    );
    summary.insert("mode".into(), json!(mode_name(reduced)));
    summary.insert("result".into(), json!(result));
    if result.is_some() {
        summary.insert("score".into(), json!(format!("{mine}-{enemy}")));
    }
    if let Some(me) = me {
        summary.extend(stat_line(me, agents));
    }
    Value::Object(summary)
}

/// A whole scoreboard with every other player reduced to Ally N / Enemy N:
/// no Riot IDs, PUUIDs or party IDs.
fn anonymized_scoreboard(
    reduced: &Value,
    agents: &HashMap<String, String>,
    maps: &HashMap<String, String>,
) -> Value {
    let all = players(reduced);
    let text = |player: &Value, key: &str| {
        player.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
    };
    let me = all.iter().copied().find(|player| player.get("isSelf") == Some(&json!(true)));
    let my_team = me.map(|me| text(me, "teamId")).unwrap_or_default();
    let my_party = me.map(|me| text(me, "partyId")).unwrap_or_default();
    let acs = |player: &&Value| player.get("acs").and_then(Value::as_f64).unwrap_or(0.0);
    let by_acs = |a: &&Value, b: &&Value| acs(b).total_cmp(&acs(a));
    let mut allies: Vec<&Value> = all
        .iter()
        .copied()
        .filter(|player| me.is_some() && text(player, "teamId") == my_team && player.get("isSelf") != Some(&json!(true)))
        .collect();
    let mut enemies: Vec<&Value> = all
        .iter()
        .copied()
        .filter(|player| me.is_none() || text(player, "teamId") != my_team)
        .collect();
    allies.sort_by(by_acs);
    enemies.sort_by(by_acs);

    let mut rows = Vec::new();
    if let Some(me) = me {
        let mut line = stat_line(me, agents);
        line.insert("player".into(), json!("You"));
        rows.push(Value::Object(line));
    }
    for (index, ally) in allies.iter().enumerate() {
        let mut line = stat_line(ally, agents);
        line.insert("player".into(), json!(format!("Ally {}", index + 1)));
        line.insert(
            "premadeWithYou".into(),
            json!(!my_party.is_empty() && text(ally, "partyId") == my_party),
        );
        rows.push(Value::Object(line));
    }
    for (index, enemy) in enemies.iter().enumerate() {
        let mut line = stat_line(enemy, agents);
        line.insert("player".into(), json!(format!("Enemy {}", index + 1)));
        rows.push(Value::Object(line));
    }
    let (result, mine, enemy) = team_result(reduced, &my_team);
    json!({
        "matchId": reduced.get("matchId"),
        "map": map_name(maps, reduced.get("mapId").and_then(Value::as_str).unwrap_or_default()),
        "mode": mode_name(reduced),
        "startedAtMillis": reduced.get("startMillis"),
        "lengthMinutes": reduced.get("lengthMillis").and_then(Value::as_u64).map(|ms| ms / 60_000),
        "completionState": reduced.get("completionState"),
        "result": result,
        "roundsWon": { "mine": mine, "enemy": enemy },
        "players": rows,
    })
}

/// Friends without PUUIDs, notes or party IDs; online friends first.
fn friend_summaries(reply: Value) -> Value {
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let mut friends: Vec<Value> = reply
        .get("friends")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|friend| {
            let online = friend.get("isOnline") == Some(&json!(true));
            let mut entry = json!({
                "riotId": text(friend, "displayName"),
                "online": online,
                "status": if online { json!(text(friend, "state")) } else { Value::Null },
                "lastOnlineMillis": friend.get("lastOnline"),
            });
            if let Some(game) = friend.get("valorant").filter(|game| game.is_object()) {
                let tier = game.get("competitiveTier").and_then(Value::as_u64).filter(|tier| *tier > 0);
                entry["valorant"] = json!({
                    "state": game.get("sessionLoopState"),
                    "queue": game.get("queueId"),
                    "map": game.get("matchMap").and_then(Value::as_str)
                        .filter(|map| !map.is_empty())
                        .and_then(|map| map.rsplit('/').next()),
                    "score": match (game.get("allyScore").and_then(Value::as_i64), game.get("enemyScore").and_then(Value::as_i64)) {
                        (Some(ally), Some(enemy)) => json!(format!("{ally}-{enemy}")),
                        _ => Value::Null,
                    },
                    "partySize": game.get("partySize"),
                    "maxPartySize": game.get("maxPartySize"),
                    "idle": game.get("isIdle"),
                    "rank": tier.map(rank_label),
                    "level": game.get("accountLevel"),
                });
            }
            entry
        })
        .collect();
    friends.sort_by_key(|friend| friend.get("online") != Some(&json!(true)));
    let requests: Vec<Value> = reply
        .get("requests")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|request| json!({ "riotId": text(request, "displayName"), "direction": text(request, "direction") }))
        .collect();
    json!({
        "online": friends.iter().filter(|friend| friend.get("online") == Some(&json!(true))).count(),
        "total": friends.len(),
        "friends": friends,
        "requests": requests,
    })
}

fn agent_progression(reply: &Value, agents: &HashMap<String, String>) -> Value {
    let mut rows: Vec<Value> = reply
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|row| {
            json!({
                "agent": agent_name(agents, row.get("agentId").and_then(Value::as_str).unwrap_or_default()),
                "level": row.get("level"),
                "longLevel": row.get("longLevel"),
                "points": row.get("points"),
            })
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.get("points").and_then(Value::as_i64).unwrap_or(-1)));
    json!({ "agents": rows })
}

/// Public valorant-api.com documents (contracts, seasons, events), fetched once
/// per session; the contracts catalog is large and changes only with a patch.
async fn public_catalog(path: &'static str) -> Option<Arc<Value>> {
    static CACHE: OnceLock<tokio::sync::Mutex<HashMap<&'static str, Arc<Value>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().await;
    if let Some(value) = cache.get(path) {
        return Some(value.clone());
    }
    let value = Arc::new(fetch_public_json(&format!("https://valorant-api.com/v1/{path}?language=en-US")).await?);
    cache.insert(path, value.clone());
    Some(value)
}

/// valorant-api.com endpoint per battle pass reward type (as the Battle Pass page uses).
fn reward_endpoint(reward_type: &str) -> Option<&'static str> {
    Some(match reward_type.to_ascii_lowercase().as_str() {
        "equippableskinlevel" => "weapons/skinlevels",
        "equippablecharmlevel" => "buddies/levels",
        "playercard" => "playercards",
        "spray" => "sprays",
        "title" => "playertitles",
        "currency" => "currencies",
        _ => return None,
    })
}

const RADIANITE_UUID: &str = "e59aa87c-4cbf-517a-5983-6e81511be9b7";

/// One tier of a pass, flattened across chapters.
#[derive(Debug, Clone, PartialEq)]
struct PassTier {
    xp: u64,
    reward_type: String,
    reward_uuid: String,
    amount: u64,
    epilogue: bool,
}

fn pass_tiers(contract: &Value) -> Vec<PassTier> {
    contract
        .pointer("/content/chapters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|chapter| {
            let epilogue = chapter.get("isEpilogue").and_then(Value::as_bool).unwrap_or(false);
            chapter
                .get("levels")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(move |level| {
                    let reward = level.get("reward")?;
                    Some(PassTier {
                        xp: level.get("xp").and_then(Value::as_u64).unwrap_or(0),
                        reward_type: reward.get("type").and_then(Value::as_str).unwrap_or_default().to_string(),
                        reward_uuid: reward.get("uuid").and_then(Value::as_str).unwrap_or_default().to_string(),
                        amount: reward.get("amount").and_then(Value::as_u64).unwrap_or(1),
                        epilogue,
                    })
                })
        })
        .collect()
}

/// The next `count` tiers after `level`: (tier number, tier, XP still needed).
fn next_tiers(tiers: &[PassTier], level: usize, xp_toward_next: u64, count: usize) -> Vec<(usize, &PassTier, u64)> {
    let mut away = 0;
    tiers
        .iter()
        .enumerate()
        .skip(level)
        .take(count)
        .map(|(index, tier)| {
            away += if index == level { tier.xp.saturating_sub(xp_toward_next) } else { tier.xp };
            (index + 1, tier, away)
        })
        .collect()
}

/// Active passes with progress and the next rewards by name.
async fn battle_pass_summary(reply: &Value) -> Value {
    let (catalog, seasons, events) = tokio::join!(
        public_catalog("contracts"),
        public_catalog("seasons"),
        public_catalog("events"),
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let mut windows: HashMap<String, (i64, i64)> = HashMap::new();
    for document in [seasons.as_deref(), events.as_deref()].into_iter().flatten() {
        for row in document.get("data").and_then(Value::as_array).into_iter().flatten() {
            let time = |key: &str| row.get(key).and_then(Value::as_str).and_then(crate::util_time::iso_to_unix_secs);
            if let (Some(id), Some(start), Some(end)) = (row.get("uuid").and_then(Value::as_str), time("startTime"), time("endTime")) {
                windows.insert(id.to_ascii_lowercase(), (start, end));
            }
        }
    }
    let progress: HashMap<String, &Value> = reply
        .get("contracts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| Some((row.get("id")?.as_str()?.to_ascii_lowercase(), row)))
        .collect();
    let owned: Vec<String> = reply
        .get("premiumContractIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_ascii_lowercase)
        .collect();

    let mut passes = Vec::new();
    for contract in catalog.as_deref().and_then(|c| c.get("data")).and_then(Value::as_array).into_iter().flatten() {
        let kind = match contract.pointer("/content/relationType").and_then(Value::as_str) {
            Some("Season") => "act",
            Some("Event") => "event",
            _ => continue,
        };
        let relation = contract.pointer("/content/relationUuid").and_then(Value::as_str).unwrap_or_default();
        let Some(&(_, end)) = windows
            .get(&relation.to_ascii_lowercase())
            .filter(|(start, end)| *start <= now && now < *end)
        else {
            continue;
        };
        let tiers = pass_tiers(contract);
        if tiers.is_empty() {
            continue;
        }
        let id = contract.get("uuid").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
        let row = progress.get(&id);
        let number = |key: &str| row.and_then(|row| row.get(key)).and_then(Value::as_u64).unwrap_or(0);
        let (level, toward, earned) = (number("level") as usize, number("xpTowardNext"), number("totalXp"));
        let premium_required = contract.pointer("/content/premiumVPCost").and_then(Value::as_u64).unwrap_or(0) > 0;
        let premium_owned = owned.contains(&id);
        let total_xp: u64 = tiers.iter().map(|tier| tier.xp).sum();

        let upcoming = next_tiers(&tiers, level, toward, 3);
        let mut lookups = tokio::task::JoinSet::new();
        for (index, (_, tier, _)) in upcoming.iter().enumerate() {
            if let Some(endpoint) = reward_endpoint(&tier.reward_type) {
                let url = format!("https://valorant-api.com/v1/{endpoint}/{}?language=en-US", tier.reward_uuid.to_ascii_lowercase());
                lookups.spawn(async move {
                    let body = fetch_public_json(&url).await;
                    let name = body.as_ref().and_then(|body| {
                        body.pointer("/data/displayName")
                            .or_else(|| body.pointer("/data/titleText"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    });
                    (index, name)
                });
            }
        }
        let mut names = vec![None; upcoming.len()];
        let _ = tokio::time::timeout(NAME_LOOKUP_TIMEOUT, async {
            while let Some(Ok((index, name))) = lookups.join_next().await {
                names[index] = name;
            }
        })
        .await;
        let next_rewards: Vec<Value> = upcoming
            .iter()
            .zip(names)
            .map(|((tier_number, tier, away), name)| {
                let amount = if tier.reward_uuid.eq_ignore_ascii_case(RADIANITE_UUID) && tier.amount == 1 { 10 } else { tier.amount };
                json!({
                    "tier": tier_number,
                    "type": tier.reward_type,
                    "name": name,
                    "amount": amount,
                    "xpAway": away,
                    "needsPremium": premium_required && !premium_owned && !tier.epilogue,
                })
            })
            .collect();

        passes.push(json!({
            "name": contract.get("displayName"),
            "kind": kind,
            "tierReached": level.min(tiers.len()),
            "totalTiers": tiers.len(),
            "xpTowardNextTier": toward,
            "xpForNextTier": tiers.get(level).map(|tier| tier.xp),
            "passXp": {
                "earned": earned,
                "total": total_xp,
                "percent": (earned.min(total_xp) * 100).checked_div(total_xp).unwrap_or(0),
            },
            "premiumRequired": premium_required,
            "premiumOwned": premium_owned,
            "daysLeft": ((end - now).max(0) + 86_399) / 86_400,
            "complete": level >= tiers.len(),
            "nextRewards": next_rewards,
        }));
    }
    let mut summary = json!({ "activePasses": passes });
    if catalog.is_none() {
        summary["note"] = json!("The public battle pass catalog (valorant-api.com) could not be reached, so passes could not be listed.");
    }
    if let Some(recruitment) = reply.get("recruitment").filter(|value| !value.is_null()) {
        summary["recruitment"] = recruitment.clone();
    }
    summary
}

/// Resolves a Riot ID or PUUID, then reads that player's profile.
async fn lookup_player(app: &AppHandle, query: &str) -> Value {
    let riot = || app.state::<RiotState>();
    let resolved = super::tools::tools_player_resolve(vec![json!(query)], riot())
        .await
        .unwrap_or(Value::Null);
    if let Some(message) = failure_message(&resolved) {
        return text_result(&json!(message), true);
    }
    let Some(puuid) = resolved.get("puuid").and_then(Value::as_str) else {
        return text_result(&json!("No Valorant player matched that lookup."), true);
    };
    let reply = super::friend_profile::friend_profile_get(vec![json!(puuid)], riot())
        .await
        .unwrap_or(Value::Null);
    let text = |key: &str| resolved.get(key).and_then(Value::as_str).unwrap_or_default();
    let riot_id = format!("{}#{}", text("gameName"), text("tagLine"));
    command_result(reply, |reply| player_profile(&riot_id, puuid, reply))
}

/// A player profile with rank tiers named.
fn player_profile(riot_id: &str, puuid: &str, reply: Value) -> Value {
    let profile = reply.get("profile").cloned().unwrap_or(Value::Null);
    let ranked = |value: Option<&Value>| value.and_then(Value::as_u64).filter(|tier| *tier > 0);
    let matches: Vec<Value> = profile
        .get("matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|game| {
            let mut game = game.clone();
            for (key, named) in [("tierBefore", "rankBefore"), ("tierAfter", "rankAfter")] {
                if let Some(tier) = ranked(game.get(key)) {
                    game[named] = json!(rank_label(tier));
                }
            }
            game
        })
        .collect();
    json!({
        "riotId": riot_id,
        "puuid": puuid,
        "currentRank": tier_entry(ranked(profile.get("currentTier"))),
        "currentRr": profile.get("currentRR"),
        "peakRank": tier_entry(ranked(profile.get("peakTier"))),
        "peakSeasonId": profile.get("peakSeasonId"),
        "rankShields": profile.get("rankShields"),
        "currentSeasonId": profile.get("currentSeasonId"),
        "competitiveSeasons": profile.get("competitiveSeasons"),
        "recentMatches": matches,
    })
}

fn tier_entry(tier: Option<u64>) -> Value {
    match tier {
        Some(tier) => json!({ "tier": tier, "name": rank_label(tier) }),
        None => Value::Null,
    }
}

/// Career without the raw MMR document (every season of every queue) and
/// with tier numbers named, so it stays small enough to be useful to a model.
fn player_overview(career: Value, region: Option<&str>) -> Value {
    let latest = career.pointer("/mmr/LatestCompetitiveUpdate");
    let field = |value: Option<&Value>, key: &str| value.and_then(|v| v.get(key)).and_then(Value::as_u64);
    let recent: Vec<Value> = career
        .pointer("/competitiveUpdates/Matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|game| {
            json!({
                "matchId": game.get("MatchID"),
                "startedAtMillis": game.get("MatchStartTime"),
                "map": game.get("MapID").and_then(Value::as_str)
                    .and_then(|path| path.rsplit('/').next()),
                "rankBefore": tier_entry(field(Some(game), "TierBeforeUpdate")),
                "rankAfter": tier_entry(field(Some(game), "TierAfterUpdate")),
                "rrEarned": game.get("RankedRatingEarned"),
                "rrAfter": game.get("RankedRatingAfterUpdate"),
            })
        })
        .collect();
    let current_season = career.get("currentSeasonId").and_then(Value::as_str).unwrap_or_default();
    let seasons: Vec<&Value> = career
        .get("competitiveSeasons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let number = |season: &Value, key: &str| season.get(key).and_then(Value::as_u64).unwrap_or(0);
    let win_rate = |wins: u64, games: u64| {
        (games > 0).then(|| ((wins as f64 / games as f64) * 1000.0).round() / 10.0)
    };
    // Riot's peak rank is the highest tier the player has won a game at.
    let peak = seasons
        .iter()
        .flat_map(|season| {
            season
                .get("winsByTier")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(move |(tier, _)| tier.parse::<u64>().ok().map(|tier| (tier, season.get("seasonId"))))
        })
        .max_by_key(|(tier, _)| *tier);
    let current_act = seasons
        .iter()
        .find(|season| season.get("seasonId").and_then(Value::as_str) == Some(current_season))
        .map(|season| {
            let (wins, games) = (number(season, "wins"), number(season, "games"));
            json!({
                "rank": tier_entry(Some(number(season, "tier")).filter(|tier| *tier > 0)),
                "rr": number(season, "rankedRating"),
                "wins": wins,
                "games": games,
                "winRatePercent": win_rate(wins, games),
                "leaderboardRank": career
                    .pointer(&format!("/mmr/QueueSkills/competitive/SeasonalInfoBySeasonID/{current_season}/LeaderboardRank"))
                    .and_then(Value::as_u64)
                    .filter(|rank| *rank > 0),
            })
        });
    let acts: Vec<Value> = seasons
        .iter()
        .filter(|season| number(season, "games") > 0)
        .map(|season| {
            let (wins, games) = (number(season, "wins"), number(season, "games"));
            json!({
                "seasonId": season.get("seasonId"),
                "rank": tier_entry(Some(number(season, "tier")).filter(|tier| *tier > 0)),
                "rr": number(season, "rankedRating"),
                "wins": wins,
                "games": games,
                "winRatePercent": win_rate(wins, games),
            })
        })
        .collect();
    let rr_change: i64 = recent
        .iter()
        .filter_map(|game| game.get("rrEarned").and_then(Value::as_i64))
        .sum();
    let (gains, losses) = recent.iter().fold((0, 0), |(up, down), game| {
        match game.get("rrEarned").and_then(Value::as_i64) {
            Some(rr) if rr > 0 => (up + 1, down),
            Some(rr) if rr < 0 => (up, down + 1),
            _ => (up, down),
        }
    });
    json!({
        "riotId": career.get("riotId"),
        "puuid": career.get("puuid"),
        "region": region,
        "accountLevel": career.get("accountLevel"),
        "currentRank": tier_entry(field(latest, "TierAfterUpdate")),
        "currentRr": field(latest, "RankedRatingAfterUpdate"),
        "rankShields": career.get("rankShields"),
        "currentSeasonId": career.get("currentSeasonId"),
        "currentAct": current_act,
        "peakRank": peak.map(|(tier, season)| json!({
            "tier": tier,
            "name": rank_label(tier),
            "seasonId": season,
        })),
        "recentCompetitiveSummary": {
            "games": recent.len(),
            "rrGained": gains,
            "rrLost": losses,
            "netRr": rr_change,
        },
        "acts": acts,
        "recentCompetitive": recent,
    })
}

/// Name, created and updated time only. The settings blobs stay local.
fn profile_summaries(profiles: Option<&Value>) -> Value {
    let list: Vec<Value> = profiles
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|profile| {
            json!({
                "name": profile.get("name"),
                "createdMillis": profile.get("created"),
                "updatedMillis": profile.get("updated"),
            })
        })
        .collect();
    json!({ "profiles": list })
}

/// Catalog lookups the store reply needs: (pointer to the id, catalog path).
fn store_name_targets(store: &Value) -> Vec<(String, String)> {
    let mut targets = Vec::new();
    for (list, item) in [("/daily/offers", "itemId"), ("/nightMarket/offers", "itemId")] {
        if let Some(offers) = store.pointer(list).and_then(Value::as_array) {
            for (index, offer) in offers.iter().enumerate() {
                if let Some(id) = offer.get(item).and_then(Value::as_str).filter(|id| !id.is_empty()) {
                    targets.push((format!("{list}/{index}"), format!("weapons/skinlevels/{id}")));
                }
            }
        }
    }
    if let Some(bundles) = store.get("featuredBundles").and_then(Value::as_array) {
        for (index, bundle) in bundles.iter().enumerate() {
            if let Some(id) = bundle.get("dataAssetId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                targets.push((format!("/featuredBundles/{index}"), format!("bundles/{id}")));
            }
        }
    }
    targets
}

/// Adds a `name` next to skin and bundle ids. Missing names are left out.
async fn with_item_names(mut store: Value) -> Value {
    let targets = store_name_targets(&store);
    let mut paths: Vec<String> = targets.iter().map(|(_, path)| path.clone()).collect();
    paths.sort();
    paths.dedup();
    let mut workers = tokio::task::JoinSet::new();
    for path in paths {
        workers.spawn(async move {
            let url = format!("https://valorant-api.com/v1/{path}?language=en-US");
            let name = fetch_public_json(&url).await.and_then(|body| {
                body.pointer("/data/displayName")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            (path, name)
        });
    }
    let mut names = BTreeMap::new();
    let _ = tokio::time::timeout(NAME_LOOKUP_TIMEOUT, async {
        while let Some(Ok((path, Some(name)))) = workers.join_next().await {
            names.insert(path, name);
        }
    })
    .await;
    for (pointer, path) in targets {
        if let (Some(name), Some(Value::Object(entry))) = (names.get(&path), store.pointer_mut(&pointer)) {
            entry.insert("name".into(), json!(name));
        }
    }
    if let Some(object) = store.as_object_mut() {
        object.remove("success");
    }
    store
}

fn status(config: &ConfigStore) -> Value {
    let port = crate::mcp::running_port();
    json!({
        "success": true,
        "enabled": config.get("mcpEnabled") == Some(json!(true)),
        "running": port.is_some(),
        "url": port.map(|port| format!("http://127.0.0.1:{port}/mcp")),
        "token": crate::mcp::token(config),
    })
}

/// The same tool list agents see, for the in-app MCP docs page.
#[tauri::command]
pub fn mcp_tools() -> Value {
    json!({ "success": true, "tools": tool_list() })
}

#[tauri::command]
pub fn mcp_status(config: State<'_, ConfigStore>) -> Value {
    status(&config)
}

/// `args: [enabled]`. Starting can fail (no free port); the flag then stays off.
#[tauri::command]
pub async fn mcp_set_enabled(
    args: Vec<Value>,
    app: AppHandle,
    config: State<'_, ConfigStore>,
) -> Result<Value, ()> {
    let Some(enabled) = args.first().and_then(Value::as_bool) else {
        return Ok(json!({ "success": false, "error": "Expected a boolean." }));
    };
    if enabled {
        if let Err(error) = crate::mcp::start(&app).await {
            return Ok(json!({ "success": false, "error": error }));
        }
    } else {
        crate::mcp::stop();
    }
    if let Err(error) = config.try_set("mcpEnabled", json!(enabled)) {
        if enabled {
            crate::mcp::stop();
        }
        return Ok(json!({ "success": false, "error": error }));
    }
    Ok(status(&config))
}

/// Replaces the token. Clients using the old one are refused from now on.
#[tauri::command]
pub fn mcp_regenerate_token(config: State<'_, ConfigStore>) -> Value {
    if let Err(error) = config.try_set("mcpToken", json!(crate::mcp::new_token())) {
        return json!({ "success": false, "error": error });
    }
    status(&config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overview_names_tiers_and_drops_raw_mmr() {
        let career = json!({
            "success": true,
            "riotId": "Me#NA1",
            "puuid": "me-puuid",
            "currentSeasonId": "act-2",
            "mmr": { "LatestCompetitiveUpdate": { "TierAfterUpdate": 24, "RankedRatingAfterUpdate": 40 },
                     "QueueSkills": { "competitive": { "SeasonalInfoBySeasonID": {
                         "act-2": { "LeaderboardRank": 812 }
                     } } } },
            "competitiveSeasons": [
                { "seasonId": "act-1", "tier": 22, "rankedRating": 10, "wins": 30, "games": 50,
                  "winsByTier": { "22": 5, "25": 1 } },
                { "seasonId": "act-2", "tier": 24, "rankedRating": 40, "wins": 9, "games": 16,
                  "winsByTier": { "24": 9 } },
                { "seasonId": "act-0", "tier": 0, "rankedRating": 0, "wins": 0, "games": 0, "winsByTier": {} },
            ],
            "competitiveUpdates": { "Matches": [
                { "MatchID": "m1", "MapID": "/Game/Maps/Ascent/Ascent", "MatchStartTime": 5,
                  "TierBeforeUpdate": 23, "TierAfterUpdate": 24, "RankedRatingEarned": 21, "RankedRatingAfterUpdate": 40 },
                { "MatchID": "m0", "MapID": "/Game/Maps/Bind/Bind", "MatchStartTime": 4,
                  "TierBeforeUpdate": 23, "TierAfterUpdate": 23, "RankedRatingEarned": -15, "RankedRatingAfterUpdate": 19 },
            ]},
        });
        let overview = player_overview(career, Some("na"));
        assert_eq!(overview["puuid"], "me-puuid");
        assert_eq!(overview["region"], "na");
        assert_eq!(overview["currentRank"]["name"], "Immortal 1");
        assert_eq!(overview["currentRr"], 40);
        assert_eq!(overview["recentCompetitive"][0]["map"], "Ascent");
        assert_eq!(overview["recentCompetitive"][0]["rankBefore"]["name"], "Ascendant 3");
        assert_eq!(overview["currentAct"]["wins"], 9);
        assert_eq!(overview["currentAct"]["winRatePercent"], 56.3);
        assert_eq!(overview["currentAct"]["leaderboardRank"], 812);
        // Peak follows the highest tier with a win, across every act.
        assert_eq!(overview["peakRank"]["name"], "Immortal 2");
        assert_eq!(overview["peakRank"]["seasonId"], "act-1");
        assert_eq!(overview["recentCompetitiveSummary"]["netRr"], 6);
        assert_eq!(overview["recentCompetitiveSummary"]["rrGained"], 1);
        assert_eq!(overview["recentCompetitiveSummary"]["rrLost"], 1);
        // Acts with no games are left out.
        assert_eq!(overview["acts"].as_array().unwrap().len(), 2);
        assert!(overview.get("mmr").is_none());
    }

    #[test]
    fn profile_summaries_never_include_settings_data() {
        let profiles = json!([{ "name": "Main", "data": "secret-blob", "created": 1, "updated": 2 }]);
        let summary = profile_summaries(Some(&profiles));
        assert_eq!(summary["profiles"][0]["name"], "Main");
        assert!(!summary.to_string().contains("secret-blob"));
    }

    #[test]
    fn failures_become_readable_messages() {
        assert!(failure_message(&json!({ "success": true })).is_none());
        assert!(failure_message(&json!({ "success": false, "code": "loginRequired" }))
            .unwrap()
            .contains("Riot Client"));
        assert!(failure_message(&json!({ "success": false, "code": "rateLimited", "retryInSeconds": 30 }))
            .unwrap()
            .contains("30 s"));
        assert_eq!(failure_message(&json!({ "error": "boom" })).unwrap(), "boom");
    }

    #[test]
    fn store_names_target_offers_and_the_bundle() {
        let store = json!({
            "daily": { "offers": [{ "itemId": "a" }, { "itemId": "" }] },
            "nightMarket": { "offers": [{ "itemId": "b" }] },
            "featuredBundles": [{ "dataAssetId": "c" }, { "dataAssetId": "d" }],
        });
        assert_eq!(
            store_name_targets(&store),
            vec![
                ("/daily/offers/0".into(), "weapons/skinlevels/a".into()),
                ("/nightMarket/offers/0".into(), "weapons/skinlevels/b".into()),
                ("/featuredBundles/0".into(), "bundles/c".into()),
                ("/featuredBundles/1".into(), "bundles/d".into()),
            ]
        );
    }

    #[test]
    fn only_open_valorant_is_not_read_only() {
        let writable: Vec<String> = tool_list()
            .into_iter()
            .filter(|tool| tool["annotations"]["readOnlyHint"] != true)
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(writable, ["open_riot_client", "open_valorant"]);
        for tool in tool_list() {
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
        let lookup = tool_list().into_iter().find(|tool| tool["name"] == "lookup_player").unwrap();
        assert_eq!(lookup["inputSchema"]["required"], json!(["player"]));
    }

    fn reduced_match() -> Value {
        let player = |subject: &str, team: &str, party: &str, acs: f64, is_self: bool| {
            json!({
                "subject": subject, "gameName": format!("Name-{subject}"), "tagLine": "TAG",
                "teamId": team, "partyId": party, "characterId": "AGENT-A", "competitiveTier": 21,
                "role": "player", "isSelf": is_self, "kills": 20, "deaths": 10, "assists": 5,
                "acs": acs, "adr": 150.04, "headshotPercent": 25.55, "firstBloods": 3,
            })
        };
        json!({
            "matchId": "m1", "mapId": "/Game/Maps/Ascent/Ascent", "queueId": "competitive",
            "startMillis": 1000, "lengthMillis": 1_800_000, "completionState": "Completed",
            "teams": [
                { "teamId": "Blue", "won": true, "roundsWon": 13 },
                { "teamId": "Red", "won": false, "roundsWon": 11 },
            ],
            "players": [
                player("me-puuid", "Blue", "party-1", 250.0, true),
                player("duo-puuid", "Blue", "party-1", 300.0, false),
                player("solo-puuid", "Blue", "party-2", 100.0, false),
                player("foe-puuid", "Red", "party-3", 200.0, false),
                { "subject": "coach-puuid", "role": "coach", "teamId": "Blue" },
            ],
        })
    }

    #[test]
    fn scoreboard_is_anonymized_and_ordered() {
        let agents = HashMap::from([("agent-a".to_string(), "Jett".to_string())]);
        let maps = HashMap::from([("/game/maps/ascent/ascent".to_string(), "Ascent".to_string())]);
        let board = anonymized_scoreboard(&reduced_match(), &agents, &maps);
        let text = board.to_string();
        for secret in ["puuid", "Name-", "party-", "TAG"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        let labels: Vec<&str> = board["players"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["player"].as_str().unwrap())
            .collect();
        assert_eq!(labels, ["You", "Ally 1", "Ally 2", "Enemy 1"]);
        assert_eq!(board["players"][1]["premadeWithYou"], true);
        assert_eq!(board["players"][2]["premadeWithYou"], false);
        assert_eq!(board["players"][0]["agent"], "Jett");
        assert_eq!(board["players"][0]["rank"], "Ascendant 1");
        assert_eq!(board["players"][0]["adr"], 150.0);
        assert_eq!(board["map"], "Ascent");
        assert_eq!(board["result"], "win");
        assert_eq!(board["lengthMinutes"], 30);
    }

    #[test]
    fn match_history_line_is_the_players_own_game() {
        let line = own_match_summary(&reduced_match(), &HashMap::new(), &HashMap::new());
        assert_eq!(line["map"], "Ascent");
        assert_eq!(line["score"], "13-11");
        assert_eq!(line["result"], "win");
        assert_eq!(line["acs"], 250.0);
        assert!(!line.to_string().contains("puuid"));
    }

    #[test]
    fn friends_drop_ids_and_list_online_first() {
        let reply = json!({
            "friends": [
                { "puuid": "p1", "displayName": "Off#1", "isOnline": false, "note": "secret note" },
                { "puuid": "p2", "displayName": "On#2", "isOnline": true, "state": "dnd",
                  "valorant": { "queueId": "competitive", "matchMap": "/Game/Maps/Bonsai/Bonsai",
                                "allyScore": 5, "enemyScore": 3, "partyId": "party-x", "competitiveTier": 12 } },
            ],
            "requests": [{ "puuid": "p3", "displayName": "Req#3", "direction": "incoming" }],
        });
        let summary = friend_summaries(reply);
        let text = summary.to_string();
        assert!(!text.contains("p1") && !text.contains("party-x") && !text.contains("secret note"));
        assert_eq!(summary["friends"][0]["riotId"], "On#2");
        assert_eq!(summary["friends"][0]["valorant"]["map"], "Bonsai");
        assert_eq!(summary["friends"][0]["valorant"]["score"], "5-3");
        assert_eq!(summary["online"], 1);
        assert_eq!(summary["requests"][0]["riotId"], "Req#3");
    }

    #[test]
    fn player_profile_names_ranks_in_summary_and_matches() {
        let reply = json!({ "success": true, "profile": {
            "currentTier": 21, "currentRR": 55, "peakTier": 24,
            "matches": [{ "matchId": "m", "tierBefore": 20, "tierAfter": 21 }, { "matchId": "u", "tierBefore": 0 }]
        }});
        let profile = player_profile("Them#EU1", "p", reply);
        assert_eq!(profile["currentRank"]["name"], "Ascendant 1");
        assert_eq!(profile["peakRank"]["name"], "Immortal 1");
        assert_eq!(profile["recentMatches"][0]["rankAfter"], "Ascendant 1");
        assert!(profile["recentMatches"][1].get("rankBefore").is_none());
    }

    #[test]
    fn next_tiers_count_xp_from_where_the_player_is() {
        let contract = json!({ "content": { "chapters": [
            { "isEpilogue": false, "levels": [
                { "xp": 100, "reward": { "type": "Spray", "uuid": "a", "amount": 1 } },
                { "xp": 200, "reward": { "type": "Title", "uuid": "b", "amount": 1 } },
            ] },
            { "isEpilogue": true, "levels": [
                { "xp": 300, "reward": { "type": "Currency", "uuid": "c", "amount": 1 } },
            ] },
        ] } });
        let tiers = pass_tiers(&contract);
        assert_eq!(tiers.len(), 3);
        assert!(tiers[2].epilogue);
        let next = next_tiers(&tiers, 1, 50, 3);
        let summary: Vec<(usize, &str, u64)> =
            next.iter().map(|(tier, row, away)| (*tier, row.reward_uuid.as_str(), *away)).collect();
        assert_eq!(summary, [(2, "b", 150), (3, "c", 450)]);
        assert!(next_tiers(&tiers, 3, 0, 3).is_empty());
        assert_eq!(reward_endpoint("EquippableSkinLevel"), Some("weapons/skinlevels"));
        assert_eq!(reward_endpoint("Unknown"), None);
    }
}
