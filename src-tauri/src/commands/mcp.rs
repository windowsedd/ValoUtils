//! Tools for the local MCP server (`crate::mcp`) and the Settings commands
//! that control it. Each tool reuses an existing command, so it shares that
//! command's PD client, rate budget and auth retry. Tools that act are marked
//! `readOnlyHint: false`, among them `open_riot_client` / `open_valorant`
//! (start the Riot Client and the game like the app's launch buttons) and
//! `close_riot_client` / `restart_riot_client` (force-close it, or close it and
//! reopen it through the XMPP relay).

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

/// Marks a tool as one that changes something (not read-only).
fn action(mut tool: Value) -> Value {
    tool["annotations"] = json!({
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
    });
    tool
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
            "The current agent select or match: map, mode, phase, the live round score during a match (from your chat presence, when Riot shares it), and for each player their agent, rank, RR, peak rank, level, recent form and equipped weapon skins (non-default skins only, e.g. Reaver Vandal), detected parties (\"🔵 Party 1\": players queued together, from presence or shared match history) and playedBefore (how often they were with or against you in your last 10 matches). Players are labelled You / Ally N / Enemy N, with each one's riotId unless the user turned off Include player names (players who hid their name stay hidden).",
        ),
        tool(
            "get_store",
            "Store",
            "Today's store offers with skin names and prices, every featured bundle (often two at once) with name, price and time left, the Night Market when it's open, accessory offers (Kingdom Credits) with item name and kind (spray, player card, gun buddy, title, flex), and wallet balances (VP, Radianite, Kingdom Credits).",
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
            "get_crosshair_codes",
            "Crosshair codes",
            "Share codes (like 0;P;c;5;h;0;0l;4) for every crosshair profile saved on your account, or in a saved ValoUtils settings profile, with the active one marked. The code covers the primary crosshair, which is what players paste into Settings > Crosshair > Import.",
            string_input(
                "name",
                "Saved profile name from list_settings_profiles. Leave out for the account's current crosshairs.",
                false,
            ),
        ),
        tool(
            "get_loadout",
            "Loadout",
            "Your equipped cosmetics: the skin, chroma variant and gun buddy on every weapon (in armory order), plus your player card, title and sprays, by name.",
        ),
        tool(
            "get_owned_skins",
            "Owned skins",
            "Every weapon skin you own, grouped by weapon with counts, plus how many buddies, sprays, player cards and titles you own.",
        ),
        tool_with_input(
            "get_match_timeline",
            "Match timeline",
            "Round by round for one finished match: who won each round, how (elimination, spike detonated or defused, time), the running score, the first blood and spike plants. Give round for every kill in that round with time, killer, victim and weapon. Players are You / Ally N / Enemy N with their agent, matching get_match_details.",
            json!({
                "type": "object",
                "properties": {
                    "matchId": { "type": "string", "description": "Match ID from get_match_history." },
                    "round": { "type": "integer", "minimum": 1, "description": "A round number for its kill-by-kill detail. Leave out for the round summary." },
                },
                "required": ["matchId"],
                "additionalProperties": false,
            }),
        ),
        tool_with_input(
            "build_crosshair_code",
            "Build crosshair code",
            "Builds a VALORANT crosshair share code from a description of its settings. Turn the player's request into these settings (leave out what they didn't ask for; outer lines are usually off) and give them the returned code to paste into Settings > Crosshair > Import. Values are clamped to the game's ranges.",
            crate::crosshair_code::spec_schema(),
        ),
        tool_with_input(
            "lookup_player",
            "Look up a player",
            "Any player's Riot ID, current and peak competitive rank, RR, rank per act and recent matches, by Riot ID (Name#Tag) or PUUID. Same lookup as the ValoUtils Tools page.",
            string_input("player", "Riot ID like Name#Tag, or a player PUUID.", true),
        ),
        tool_with_input(
            "find_player",
            "Find player account",
            "Resolves accounts without fetching stats: a Riot ID alias (Name#Tag) gives the account's PUUID and exact Riot ID, and a PUUID gives its current Riot ID. Up to 10 at once. Cheap; use lookup_player when rank and matches are wanted. Riot does not expose past names.",
            json!({
                "type": "object",
                "properties": { "players": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "maxItems": 10,
                    "description": "Riot IDs like Name#Tag, or PUUIDs."
                } },
                "required": ["players"],
                "additionalProperties": false,
            }),
        ),
        tool_with_input(
            "compare_players",
            "Compare players",
            "Compares 2 to 5 players side by side by Riot ID (Name#Tag) or PUUID: current rank and RR, peak rank, this act's wins, losses and win rate, and the net RR over their recent competitive games. Use \"me\" for the signed-in player.",
            json!({
                "type": "object",
                "properties": { "players": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 2,
                    "maxItems": 5,
                    "description": "Riot IDs like Name#Tag, PUUIDs, or \"me\"."
                } },
                "required": ["players"],
                "additionalProperties": false,
            }),
        ),
        tool_with_input(
            "translate_message",
            "Translate text",
            "Translates text with the translator chosen in ValoUtils Settings (Google, DeepL or the AI provider). Without a target language it uses the Settings target language.",
            json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Text to translate (up to 2,000 characters)." },
                    "targetLanguage": { "type": "string", "description": "Language code like en, ko, zh-TW, ja, es. Leave out for the Settings target language." },
                },
                "required": ["text"],
                "additionalProperties": false,
            }),
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
            "The full scoreboard of one finished match: map, mode, length, result and rounds, and every player's agent, rank, K/D/A, ACS, ADR, headshot % and first bloods, their party (\"🔵 Party 1\" for players queued together) and playedBefore (with or against you in your other recent matches). Players are labelled You / Ally N / Enemy N, with each one's riotId unless the user turned off Include player names in ValoUtils.",
            string_input("matchId", "Match ID from get_match_history, get_player_overview or lookup_player (when the user says \"#3\", use that row's matchId).", true),
        ),
        tool_with_input(
            "get_friends",
            "Friends",
            "Your Riot friends: who is online, who is in Valorant and what they are doing (queue, map, score, party size), their rank and level when Riot shares them, the private note you saved on each friend, and pending friend requests. Give search to find friends by name or note text.",
            string_input("search", "Optional text matched against each friend's Riot ID and your note on them (case-insensitive).", false),
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
        tool(
            "get_party",
            "Party",
            "Your current Valorant party: members (Riot ID, rank, level, owner, ready), the selected queue, whether it is searching for a match, open/closed, and the queues it can enter.",
        ),
        action(tool(
            "leave_party",
            "Leave party",
            "Leaves your current Valorant party (you get a party of your own).",
        )),
        action(tool(
            "start_queue",
            "Start queue",
            "Starts searching for a match in the party's selected queue. Only the party owner can start the queue.",
        )),
        action(tool(
            "stop_queue",
            "Stop queue",
            "Stops searching for a match.",
        )),
        action(tool_with_input(
            "change_queue",
            "Change queue",
            "Selects the party's queue, e.g. competitive, unrated, swiftplay, spikerush, deathmatch, ggteam (Escalation), hurm (Team Deathmatch). Use get_party for the queues this party can enter.",
            string_input("queue", "Queue ID, e.g. competitive or unrated.", true),
        )),
        tool_with_input(
            "get_chat_messages",
            "Read chat",
            "Recent messages in your party, team or all chat, or with a friend (by Riot ID). Newest last.",
            json!({
                "type": "object",
                "properties": {
                    "channel": { "type": "string", "enum": ["party", "team", "all", "friend"] },
                    "friend": { "type": "string", "description": "Friend's Riot ID (Name#Tag) when channel is friend." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "How many messages. Default 20." },
                },
                "required": ["channel"],
                "additionalProperties": false,
            }),
        ),
        action(tool_with_input(
            "send_chat_message",
            "Send chat message",
            "Sends a message as you to your party, team or all chat, or as a whisper to a friend (by Riot ID). Team and all chat need a running match (or agent select); posting to rooms works best when the Riot Client was opened through ValoUtils' XMPP relay.",
            json!({
                "type": "object",
                "properties": {
                    "channel": { "type": "string", "enum": ["party", "team", "all", "friend"] },
                    "message": { "type": "string", "description": "The message text." },
                    "friend": { "type": "string", "description": "Friend's Riot ID (Name#Tag) when channel is friend." },
                },
                "required": ["channel", "message"],
                "additionalProperties": false,
            }),
        )),
        action(tool_with_input(
            "set_presence",
            "Set chat presence",
            "Sets how friends see you in Riot chat: online, offline (appear offline) or mobile. Needs the Riot Client opened through ValoUtils' XMPP relay.",
            json!({
                "type": "object",
                "properties": { "mode": { "type": "string", "enum": ["online", "offline", "mobile"] } },
                "required": ["mode"],
                "additionalProperties": false,
            }),
        )),
        {
            let mut create = tool(
                "create_party_code",
                "Create party code",
                "Creates an invite code and Riot party link (https://gg.riotgames.com/VAL?joinCode=...) for your current Valorant party, which friends can use to join it. You must be in a party (the game's lobby counts), and VALORANT must be running; if it isn't, offer open_valorant.",
            );
            create["annotations"] = json!({
                "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false,
            });
            create
        },
        {
            let mut join = tool_with_input(
                "join_party",
                "Join party by code",
                "Joins a Valorant party using its invite code (letters and digits, like TUE693) or a Riot party link. You leave your current party to join it. VALORANT must be running; if it isn't, offer open_valorant.",
                string_input("code", "The party invite code, or a gg.riotgames.com party link.", true),
            );
            join["annotations"] = json!({
                "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false,
            });
            join
        },
        {
            let mut disable = tool(
                "disable_party_link",
                "Disable party link",
                "Turns off your current party's invite code and party link, so they can no longer be used to join. VALORANT must be running.",
            );
            disable["annotations"] = json!({
                "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false,
            });
            disable
        },
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
                "Launches Valorant, like the app's launch buttons. If the Riot Client is already open, it starts the game from that client (after sign-in if needed) and mode doesn't matter; don't close or restart the client first. Otherwise it starts the Riot Client: the default \"relay\" mode is Launch with XMPP relay, which ValoUtils chat, presence and bot commands need; \"normal\" is a plain startup.",
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
        {
            let mut close = tool_with_input(
                "close_riot_client",
                "Close Riot Client",
                "Force-closes the Riot Client (like ending it in Task Manager) right away. Not needed to launch Valorant: open_valorant starts it from an open client. The user asking for it is the confirmation, so do not ask again. Closing a running VALORANT needs closeGame true: pass it straight away when the user already confirmed closing the game, otherwise the tool refuses and you ask once.",
                json!({
                    "type": "object",
                    "properties": {
                        "userAsked": {
                            "type": "boolean",
                            "description": "true only when the user explicitly asked for this in the conversation. Launching Valorant never needs it: open_valorant works with the Riot Client open."
                        },
                        "closeGame": {
                            "type": "boolean",
                            "description": "Also close VALORANT if it is running. Set it on the first call when the user already confirmed closing the game (e.g. \"close it, I confirm\"); otherwise leave it out, and the tool refuses while the game runs."
                        }
                    },
                    "required": ["userAsked"],
                    "additionalProperties": false,
                }),
            );
            close["annotations"] = json!({
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": true,
                "openWorldHint": false,
            });
            close
        },
        {
            let mut restart = tool_with_input(
                "restart_riot_client",
                "Restart Riot Client through relay",
                "Closes the running Riot Client and opens it again through ValoUtils' XMPP relay, so chat, presence and bot commands work. Use it only when the user wants those and the client was started without ValoUtils; it is not needed to launch Valorant, which open_valorant does from an open client. VALORANT is relaunched too if it was running. Closing a running VALORANT needs closeGame true: pass it straight away when the user already confirmed, otherwise the tool refuses and you ask once.",
                json!({
                    "type": "object",
                    "properties": {
                        "userAsked": {
                            "type": "boolean",
                            "description": "true only when the user explicitly asked for this in the conversation. Launching Valorant never needs it: open_valorant works with the Riot Client open."
                        },
                        "closeGame": {
                            "type": "boolean",
                            "description": "Also close VALORANT if it is running. Set it on the first call when the user already confirmed closing the game (e.g. \"close it, I confirm\"); otherwise leave it out, and the tool refuses while the game runs."
                        }
                    },
                    "required": ["userAsked"],
                    "additionalProperties": false,
                }),
            );
            restart["annotations"] = json!({
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false,
            });
            restart
        },
    ]
}

/// A tool result: readable Markdown for the agent to show, plus the data as
/// `structuredContent` when it is an object (MCP 2025-06-18).
fn text_result(value: &Value, is_error: bool) -> Value {
    let text = match value {
        Value::String(text) => text.clone(),
        other => crate::mcp_format::to_markdown(other),
    };
    let mut result = json!({ "content": [{ "type": "text", "text": text }], "isError": is_error });
    if value.is_object() {
        result["structuredContent"] = value.clone();
    }
    result
}

pub(crate) fn party_failure(error: &crate::riot::error::RiotError) -> String {
    if error.is_login_required() {
        LOGIN_MESSAGE.to_string()
    } else {
        error.to_string()
    }
}

/// Turns a command's `{ success: false, ... }` reply into a readable error.
pub(super) fn failure_message(reply: &Value) -> Option<String> {
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

/// Closing or restarting the Riot Client only when the user asked for it.
/// Agents holding an old tool list (from before an open client could start
/// the game) closed it just to launch; they call without `userAsked` and get
/// pointed at `open_valorant` instead.
fn user_asked(arguments: &Value) -> bool {
    arguments.get("userAsked").and_then(Value::as_bool) == Some(true)
}

const NOT_ASKED_MESSAGE: &str = "Not closed: only close or restart the Riot Client when the user asked for it (pass userAsked: true). To launch Valorant, call open_valorant; it starts the game from the open Riot Client.";

/// `None` for a tool name this server doesn't have.
pub async fn call_tool(app: &AppHandle, name: &str, arguments: &Value) -> Option<Value> {
    let riot = || app.state::<RiotState>();
    Some(match name {
        "get_player_overview" => {
            let reply = super::career::career_get(riot(), app.state::<CacheStore>()).await.unwrap_or(Value::Null);
            // Tokens are cached by now, so this is local only.
            let region = crate::riot::api::create_api(&riot()).await.ok().map(|api| api.region);
            command_result(reply, |career| player_overview(career, region.as_deref()))
        }
        "get_live_match" => match super::bot_template::ask_game_context(app, true).await {
            // The context is built as a JSON string for `.ask`; format it as data here.
            Some(context) => text_result(&serde_json::from_str(&context).unwrap_or(json!(context)), false),
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
        "get_loadout" => match super::mcp_cosmetics::get_loadout(app).await {
            Ok(loadout) => text_result(&loadout, false),
            Err(message) => text_result(&json!(message), true),
        },
        "get_owned_skins" => match super::mcp_cosmetics::get_owned_skins(app).await {
            Ok(owned) => text_result(&owned, false),
            Err(message) => text_result(&json!(message), true),
        },
        "get_match_timeline" => {
            let id = arguments.get("matchId").and_then(Value::as_str).unwrap_or_default().trim();
            let round = arguments.get("round").and_then(Value::as_u64);
            if id.is_empty() {
                text_result(&json!("matchId is required."), true)
            } else {
                match super::mcp_cosmetics::get_match_timeline(app, id, round).await {
                    Ok(timeline) => text_result(&timeline, false),
                    Err(message) => text_result(&json!(message), true),
                }
            }
        }
        "build_crosshair_code" => {
            let (code, settings) = crate::crosshair_code::code_from_spec(arguments);
            text_result(&json!({ "code": code, "settingsApplied": settings }), false)
        }
        "get_crosshair_codes" => {
            let name = arguments
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            let reply = match name {
                Some(name) => super::profiles::settings_profile_view(vec![json!(name)], app.state::<ProfilesStore>()),
                None => super::profiles::settings_current_view(riot()).await.unwrap_or(Value::Null),
            };
            command_result(reply, |value| {
                let codes = value.get("crosshairCodes").cloned().unwrap_or(json!([]));
                if codes.as_array().is_some_and(|codes| codes.is_empty()) {
                    json!("No saved crosshair profiles were found in these settings.")
                } else {
                    json!({ "source": name.unwrap_or("current account settings"), "crosshairs": codes })
                }
            })
        }
        "find_player" => {
            let queries: Vec<String> = arguments
                .get("players")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|query| query.trim().to_string())
                .filter(|query| !query.is_empty())
                .take(10)
                .collect();
            if queries.is_empty() {
                text_result(&json!("Give at least one Riot ID or PUUID."), true)
            } else {
                text_result(&find_players(app, &queries).await, false)
            }
        }
        "compare_players" => {
            let mut queries: Vec<String> = arguments
                .get("players")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|query| query.trim().to_string())
                .filter(|query| !query.is_empty())
                .collect();
            queries.dedup();
            if queries.len() < 2 || queries.len() > 5 {
                text_result(&json!("Give 2 to 5 players to compare."), true)
            } else {
                // "me" is the signed-in player.
                if queries.iter().any(|query| query.eq_ignore_ascii_case("me")) {
                    let me = crate::riot::client::get_tokens(&riot(), false)
                        .await
                        .ok()
                        .and_then(|tokens| tokens.get("subject").and_then(Value::as_str).map(str::to_owned));
                    match me {
                        Some(puuid) => queries
                            .iter_mut()
                            .filter(|query| query.eq_ignore_ascii_case("me"))
                            .for_each(|query| *query = puuid.clone()),
                        None => return Some(text_result(&json!(LOGIN_MESSAGE), true)),
                    }
                }
                compare_players(app, &queries).await
            }
        }
        "translate_message" => {
            let text = arguments.get("text").and_then(Value::as_str).unwrap_or_default().trim();
            let target = arguments.get("targetLanguage").and_then(Value::as_str).unwrap_or_default().trim();
            if text.is_empty() || text.chars().count() > 2000 {
                text_result(&json!("Give text to translate (up to 2,000 characters)."), true)
            } else {
                let reply = super::chat::chat_translate(vec![json!(text), json!(target)], app.state::<ConfigStore>())
                    .await
                    .unwrap_or(Value::Null);
                command_result(reply, |reply| {
                    json!({
                        "translation": reply.get("translatedText"),
                        "from": reply.get("sourceLanguage"),
                        "to": reply.get("targetLanguage"),
                        "translator": reply.get("provider"),
                    })
                })
            }
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
                        let met = recent_encounters(app, Some(id)).await;
                        let board = anonymized_scoreboard(&reduced, &agents, &maps, &met, show_names(app));
                        text_result(&board, false)
                    }
                    Err(message) => text_result(&json!(message), true),
                }
            }
        }
        "get_friends" => {
            let search = arguments.get("search").and_then(Value::as_str).unwrap_or_default().trim().to_string();
            let reply = super::friends::friends_get(riot()).await.unwrap_or(Value::Null);
            let (_, maps) = super::bot_template::content_names().await;
            command_result(reply, |reply| friend_summaries(reply, &search, &maps))
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
        "get_party" => match party_snapshot(app).await {
            Ok(party) => text_result(&party, false),
            Err(error) => text_result(&json!(party_failure(&error)), true),
        },
        "leave_party" | "start_queue" | "stop_queue" | "change_queue" => {
            let queue = arguments.get("queue").and_then(Value::as_str).unwrap_or_default();
            match party_action(app, name, queue).await {
                Ok(message) => text_result(&json!(message), false),
                Err(error) => text_result(&json!(party_failure(&error)), true),
            }
        }
        "get_chat_messages" => {
            let channel = arguments.get("channel").and_then(Value::as_str).unwrap_or_default();
            let friend = arguments.get("friend").and_then(Value::as_str).unwrap_or_default();
            let limit = arguments.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 50) as usize;
            match chat_messages(app, channel, friend, limit).await {
                Ok(messages) => text_result(&messages, false),
                Err(message) => text_result(&json!(message), true),
            }
        }
        "send_chat_message" => {
            let channel = arguments.get("channel").and_then(Value::as_str).unwrap_or_default();
            let friend = arguments.get("friend").and_then(Value::as_str).unwrap_or_default();
            let message = arguments.get("message").and_then(Value::as_str).unwrap_or_default();
            match send_chat(app, channel, friend, message).await {
                Ok(sent) => text_result(&json!(sent), false),
                Err(message) => text_result(&json!(message), true),
            }
        }
        "set_presence" => {
            let mode = arguments.get("mode").and_then(Value::as_str).unwrap_or_default();
            let reply = super::presence::presence_status_set(vec![json!(mode)], app.state::<ConfigStore>())
                .await
                .unwrap_or(Value::Null);
            match failure_message(&reply) {
                Some(message) => text_result(&json!(message), true),
                None => {
                    let connected = reply
                        .pointer("/presence/activeConnections")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    text_result(
                        &json!(if connected > 0 {
                            format!("Presence set to {mode}.")
                        } else {
                            format!("Presence saved as {mode}. It applies once the Riot Client is opened through ValoUtils' XMPP relay.")
                        }),
                        false,
                    )
                }
            }
        }
        "create_party_code" => match super::riot_chat::create_party_invite_code(app).await {
            Ok(code) => text_result(
                &json!({ "inviteCode": code, "link": super::riot_chat::party_link(&code) }),
                false,
            ),
            Err(error) => text_result(&json!(party_failure(&error)), true),
        },
        "disable_party_link" => match super::riot_chat::disable_party_invite_code(app).await {
            Ok(()) => text_result(&json!("The party link and invite code are turned off."), false),
            Err(error) => text_result(&json!(party_failure(&error)), true),
        },
        "join_party" => {
            let code = arguments.get("code").and_then(Value::as_str).unwrap_or_default();
            match super::riot_chat::join_party_by_code(app, code).await {
                Ok(code) => text_result(&json!(format!("Joined party {code}.")), false),
                Err(error) => text_result(&json!(party_failure(&error)), true),
            }
        }
        "open_riot_client" => {
            let reply = super::riot_launch::riot_open_client_with_config(vec![], app.state::<ConfigStore>())
                .await
                .unwrap_or(Value::Null);
            command_result(reply, |_| {
                json!("The Riot Client is opening with the XMPP relay. Sign in there; no game is launched.")
            })
        }
        "close_riot_client" | "restart_riot_client" if !user_asked(arguments) => {
            text_result(&json!(NOT_ASKED_MESSAGE), true)
        }
        "close_riot_client" => {
            let close_game = arguments.get("closeGame").and_then(Value::as_bool).unwrap_or(false);
            let reply = super::riot_launch::riot_client_close(vec![json!(close_game)], app.state::<RiotState>())
                .await
                .unwrap_or(Value::Null);
            command_result(reply, |reply| {
                json!(match (reply["closedClient"].as_bool() == Some(true), reply["closedGame"].as_bool() == Some(true)) {
                    (_, true) => "VALORANT and the Riot Client are closed.",
                    (true, false) => "The Riot Client is closed.",
                    (false, false) => "The Riot Client was not running.",
                })
            })
        }
        "restart_riot_client" => {
            let close_game = arguments.get("closeGame").and_then(Value::as_bool).unwrap_or(false);
            let reply = super::riot_launch::riot_client_restart(
                vec![json!(close_game)],
                app.clone(),
                app.state::<RiotState>(),
                app.state::<ConfigStore>(),
            )
            .await
            .unwrap_or(Value::Null);
            command_result(reply, |reply| {
                json!(if reply["relaunchedGame"].as_bool() == Some(true) {
                    "The Riot Client restarted with the XMPP relay and VALORANT is launching again. Loading takes a minute."
                } else {
                    "The Riot Client restarted with the XMPP relay. Sign in there if it asks; no game is launched."
                })
            })
        }
        "open_valorant" => {
            if super::riot_launch::valorant_running_async().await {
                return Some(text_result(&json!("Valorant is already running."), false));
            }
            let target = vec![json!("valorant"), json!("live")];
            let normal = arguments.get("mode").and_then(Value::as_str) == Some("normal");
            let reply = if normal {
                super::riot_launch::riot_launch_normal(target, app.clone(), app.state::<ConfigStore>()).await
            } else {
                super::riot_launch::riot_launch_with_config(target, app.clone(), app.state::<ConfigStore>()).await
            }
            .unwrap_or(Value::Null);
            command_result(reply, |reply| {
                if reply["runningClient"].as_bool() == Some(true) {
                    let mut message = String::from(if reply["waitingForSignIn"].as_bool() == Some(true) {
                        "The Riot Client is open but signed out. Valorant starts once the user signs in there."
                    } else {
                        "Valorant is launching from the open Riot Client. Loading takes a minute."
                    });
                    if reply["relayActive"].as_bool() != Some(true) {
                        message.push_str(" That client wasn't opened through ValoUtils' XMPP relay, so chat, presence and bot commands won't work; restart_riot_client fixes that.");
                    }
                    return json!(message);
                }
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
pub(super) async fn scoreboard(app: &AppHandle, match_id: &str) -> Result<Value, String> {
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
    text_result(&json!({ "matches": numbered(matches) }), false)
}

/// Numbers list rows from 1 (newest first) as `#`, so players can say "open #3"
/// and agents pass that row's `matchId`.
fn numbered(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter()
        .enumerate()
        .map(|(index, mut row)| {
            if let Some(object) = row.as_object_mut() {
                object.insert("#".into(), json!(index + 1));
            }
            row
        })
        .collect()
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

pub(super) fn agent_name(agents: &HashMap<String, String>, agent_id: &str) -> Value {
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

pub(super) fn players(reduced: &Value) -> Vec<&Value> {
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

/// Coloured markers for agents' Markdown, which has no colours of its own.
const PARTY_MARKS: [&str; 5] = ["🔵", "🟠", "🟣", "🟡", "🟤"];

/// "🟢 Win", "🔴 Loss" or "⚪ Draw".
fn result_mark(result: Option<&str>) -> Option<String> {
    Some(match result? {
        "win" => "🟢 Win".into(),
        "loss" => "🔴 Loss".into(),
        "draw" => "⚪ Draw".into(),
        other => other.into(),
    })
}

/// "🟢 +26", "🔴 -15" or "⚪ 0" for a ranked RR change.
fn rr_mark(rr: Option<i64>) -> Option<String> {
    let rr = rr?;
    Some(match rr.signum() {
        1 => format!("🟢 +{rr}"),
        -1 => format!("🔴 {rr}"),
        _ => "⚪ 0".into(),
    })
}

/// The rank after a match, with ⬆ or ⬇ when the tier changed.
fn rank_move(before: Option<u64>, after: Option<u64>) -> Option<String> {
    let after = after?;
    let arrow = match before {
        Some(before) if after > before => "⬆ ",
        Some(before) if after < before => "⬇ ",
        _ => "",
    };
    Some(format!("{arrow}{}", rank_label(after)))
}

/// "🔵 Party 2" for Live Game's party label ("Team 2"); `None` without one.
pub(super) fn party_mark_for_label(label: &str) -> Option<String> {
    let number: usize = label.chars().filter(char::is_ascii_digit).collect::<String>().parse().ok()?;
    let number = number.max(1);
    Some(format!("{} Party {number}", PARTY_MARKS[(number - 1) % PARTY_MARKS.len()]))
}

/// "🔵 Party 1" for each player in a party of two or more (by party id, in
/// order of first appearance); `None` for solo players and unknown ids.
fn party_marks<'a>(party_ids: impl Iterator<Item = &'a str>) -> Vec<Option<String>> {
    let ids: Vec<&str> = party_ids.collect();
    let mut numbers: HashMap<&str, usize> = HashMap::new();
    ids.iter()
        .map(|id| {
            if id.is_empty() || ids.iter().filter(|other| *other == id).count() < 2 {
                return None;
            }
            let next = numbers.len();
            let number = *numbers.entry(id).or_insert(next);
            Some(format!("{} Party {}", PARTY_MARKS[number % PARTY_MARKS.len()], number + 1))
        })
        .collect()
}

/// Who you've met in your recent matches, for MCP rows. Empty when it can't be
/// read in time (signed out, rate limited); the first call may read up to
/// [`super::encounters::RECENT_MATCHES`] scoreboards.
pub(super) async fn recent_encounters(app: &AppHandle, exclude: Option<&str>) -> BTreeMap<String, super::encounters::Encounter> {
    match tokio::time::timeout(ENCOUNTER_TIMEOUT, super::encounters::recent_boards(app)).await {
        Ok(Ok((owner, boards))) => super::encounters::tally(&owner, &boards, exclude),
        _ => BTreeMap::new(),
    }
}

const ENCOUNTER_TIMEOUT: Duration = Duration::from_secs(20);

/// One line of match history: the signed-in player's own game.
pub(super) fn own_match_summary(
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
    summary.insert("result".into(), json!(result_mark(result)));
    if result.is_some() {
        summary.insert("score".into(), json!(format!("{mine}-{enemy}")));
    }
    if let Some(me) = me {
        summary.extend(stat_line(me, agents));
    }
    Value::Object(summary)
}

/// `You` / `Ally N` / `Enemy N` by lowercase PUUID, numbered by ACS within
/// each side (as the scoreboard lists them), and the player's own team ID.
/// Whether MCP match tools add players' Riot IDs (Settings → AI agents →
/// Include player names, `mcpShowNames`; on unless turned off).
pub(super) fn show_names(app: &AppHandle) -> bool {
    app.state::<ConfigStore>().get("mcpShowNames") != Some(json!(false))
}

/// `GameName#Tag` from a reduced scoreboard player; `None` when Riot left it out.
pub(super) fn riot_id(player: &Value) -> Option<String> {
    let name = player.get("gameName").and_then(Value::as_str).unwrap_or_default().trim();
    let tag = player.get("tagLine").and_then(Value::as_str).unwrap_or_default().trim();
    match (name.is_empty(), tag.is_empty()) {
        (true, _) => None,
        (false, true) => Some(name.to_owned()),
        (false, false) => Some(format!("{name}#{tag}")),
    }
}

/// You / Ally N / Enemy N by PUUID (and your team id); with `names`, each label
/// also carries the Riot ID: "Ally 2 · Name#Tag".
pub(super) fn player_labels(reduced: &Value, names: bool) -> (HashMap<String, String>, String) {
    let all = players(reduced);
    let text = |player: &Value, key: &str| player.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let is_self = |player: &&Value| player.get("isSelf") == Some(&json!(true));
    let me = all.iter().copied().find(is_self);
    let my_team = me.map(|me| text(me, "teamId")).unwrap_or_default();
    let acs = |player: &&Value| player.get("acs").and_then(Value::as_f64).unwrap_or(0.0);
    let by_acs = |a: &&Value, b: &&Value| acs(b).total_cmp(&acs(a));
    let mut allies: Vec<&Value> = all
        .iter()
        .copied()
        .filter(|player| me.is_some() && text(player, "teamId") == my_team && !is_self(player))
        .collect();
    let mut enemies: Vec<&Value> = all
        .iter()
        .copied()
        .filter(|player| me.is_none() || text(player, "teamId") != my_team)
        .collect();
    allies.sort_by(by_acs);
    enemies.sort_by(by_acs);
    let id = |player: &Value| text(player, "subject").to_ascii_lowercase();
    let named = |label: String, player: &Value| match riot_id(player).filter(|_| names) {
        Some(riot_id) => format!("{label} · {riot_id}"),
        None => label,
    };
    let mut labels = HashMap::new();
    if let Some(me) = me {
        labels.insert(id(me), "You".to_string());
    }
    for (index, ally) in allies.iter().enumerate() {
        labels.insert(id(ally), named(format!("Ally {}", index + 1), ally));
    }
    for (index, enemy) in enemies.iter().enumerate() {
        labels.insert(id(enemy), named(format!("Enemy {}", index + 1), enemy));
    }
    (labels, my_team)
}

/// A whole scoreboard with every other player reduced to Ally N / Enemy N:
/// no Riot IDs, PUUIDs or party IDs.
fn anonymized_scoreboard(
    reduced: &Value,
    agents: &HashMap<String, String>,
    maps: &HashMap<String, String>,
    met: &BTreeMap<String, super::encounters::Encounter>,
    names: bool,
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
    let mut order: Vec<&Value> = Vec::new();
    if let Some(me) = me {
        let mut line = stat_line(me, agents);
        line.insert("player".into(), json!("You"));
        rows.push(line);
        order.push(me);
    }
    for (index, ally) in allies.iter().enumerate() {
        let mut line = stat_line(ally, agents);
        line.insert("player".into(), json!(format!("Ally {}", index + 1)));
        line.insert(
            "premadeWithYou".into(),
            json!(!my_party.is_empty() && text(ally, "partyId") == my_party),
        );
        rows.push(line);
        order.push(ally);
    }
    for (index, enemy) in enemies.iter().enumerate() {
        let mut line = stat_line(enemy, agents);
        line.insert("player".into(), json!(format!("Enemy {}", index + 1)));
        rows.push(line);
        order.push(enemy);
    }
    // Parties of two or more, numbered in row order, and who you've met before.
    let party_ids: Vec<String> = order.iter().map(|player| text(player, "partyId")).collect();
    let parties = party_marks(party_ids.iter().map(String::as_str));
    let rows: Vec<Value> = rows
        .into_iter()
        .zip(&order)
        .zip(parties)
        .map(|((mut line, player), party)| {
            line.insert("party".into(), party.map(Value::String).unwrap_or(Value::Null));
            if names {
                line.insert("riotId".into(), riot_id(player).map(Value::String).unwrap_or(Value::Null));
            }
            if player.get("isSelf") != Some(&json!(true)) {
                let seen = met.get(&text(player, "subject").to_ascii_lowercase());
                line.insert(
                    "playedBefore".into(),
                    super::encounters::describe(seen).map(Value::String).unwrap_or(Value::Null),
                );
            }
            Value::Object(line)
        })
        .collect();
    let (result, mine, enemy) = team_result(reduced, &my_team);
    json!({
        "matchId": reduced.get("matchId"),
        "map": map_name(maps, reduced.get("mapId").and_then(Value::as_str).unwrap_or_default()),
        "mode": mode_name(reduced),
        "startedAtMillis": reduced.get("startMillis"),
        "lengthMinutes": reduced.get("lengthMillis").and_then(Value::as_u64).map(|ms| ms / 60_000),
        "completionState": reduced.get("completionState"),
        "result": result_mark(result),
        "roundsWon": { "mine": mine, "enemy": enemy },
        "players": rows,
    })
}

/// Friends without PUUIDs, notes or party IDs; online friends first.
/// Whether a friend's Riot ID or the player's note on them contains `search`.
fn friend_matches(friend: &Value, search: &str) -> bool {
    if search.is_empty() {
        return true;
    }
    let needle = search.to_lowercase();
    ["displayName", "note"].iter().any(|key| {
        friend.get(*key).and_then(Value::as_str).is_some_and(|text| text.to_lowercase().contains(&needle))
    })
}

/// `maps` names map ids (`bot_template::content_names`); unknown ones keep the
/// path's last part.
fn friend_summaries(reply: Value, search: &str, maps: &HashMap<String, String>) -> Value {
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let mut friends: Vec<Value> = reply
        .get("friends")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|friend| friend_matches(friend, search))
        .map(|friend| {
            let online = friend.get("isOnline") == Some(&json!(true));
            let note = text(friend, "note");
            let mut entry = json!({
                "riotId": text(friend, "displayName"),
                "note": if note.trim().is_empty() { Value::Null } else { json!(note.trim()) },
                "online": online,
                "status": if online { json!(text(friend, "state")) } else { Value::Null },
                "lastOnlineMillis": friend.get("lastOnline"),
            });
            if let Some(game) = friend.get("valorant").filter(|game| game.is_object()) {
                let tier = game.get("competitiveTier").and_then(Value::as_u64).filter(|tier| *tier > 0);
                entry["valorant"] = json!({
                    "state": game.get("sessionLoopState"),
                    "queue": game.get("queueId").and_then(Value::as_str)
                        .map(super::bot_template::mode_label_public),
                    "map": game.get("matchMap").and_then(Value::as_str)
                        .filter(|map| !map.is_empty())
                        .map(|map| map_name(maps, map)),
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
pub(super) async fn public_catalog(path: &'static str) -> Option<Arc<Value>> {
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
                let path = format!("{endpoint}/{}", tier.reward_uuid.to_ascii_lowercase());
                lookups.spawn(async move { (index, item_name(path).await) });
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

fn riot_id_from_names(names: &Value, puuid: &str) -> Option<String> {
    let entry = names.as_array()?.iter().find(|entry| {
        entry.get("Subject").and_then(Value::as_str).is_some_and(|subject| subject.eq_ignore_ascii_case(puuid))
    })?;
    let name = entry.get("GameName").and_then(Value::as_str)?.trim();
    let tag = entry.get("TagLine").and_then(Value::as_str).unwrap_or_default().trim();
    (!name.is_empty()).then(|| if tag.is_empty() { name.to_string() } else { format!("{name}#{tag}") })
}

/// A party document reduced to what a player cares about.
fn party_summary(party: &Value, party_id: &str, me: &str, names: &Value) -> Value {
    let members: Vec<Value> = party
        .get("Members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|member| {
            let subject = member.get("Subject").and_then(Value::as_str).unwrap_or_default();
            let tier = member.get("CompetitiveTier").and_then(Value::as_u64).filter(|tier| *tier > 0);
            json!({
                "riotId": riot_id_from_names(names, subject),
                "isYou": subject.eq_ignore_ascii_case(me),
                "isOwner": member.get("IsOwner").and_then(Value::as_bool).unwrap_or(false),
                "rank": tier.map(rank_label),
                "level": member.pointer("/PlayerIdentity/AccountLevel"),
                "ready": member.get("IsReady"),
            })
        })
        .collect();
    let state = party.get("State").and_then(Value::as_str).unwrap_or_default();
    json!({
        "partyId": party_id,
        "state": state,
        "searching": state.eq_ignore_ascii_case("MATCHMAKING"),
        "queue": party.pointer("/MatchmakingData/QueueID"),
        "accessibility": party.get("Accessibility"),
        "eligibleQueues": party.get("EligibleQueues"),
        "members": members,
    })
}

async fn current_party(api: &crate::riot::api::RiotApiClient) -> Result<(String, Value), crate::riot::error::RiotError> {
    let player = api.party_get_by_player(&api.puuid).await?;
    let party_id = player
        .get("CurrentPartyID")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "You are not in a party. Open Valorant first.".to_string())?
        .to_string();
    let party = api.party_get(&party_id).await?;
    Ok((party_id, party))
}

pub(crate) async fn party_snapshot(app: &AppHandle) -> Result<Value, crate::riot::error::RiotError> {
    let riot = app.state::<RiotState>();
    crate::riot::api::with_api(&riot, |api| async move {
        let (party_id, party) = current_party(&api).await?;
        let subjects: Vec<String> = party
            .get("Members")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|member| member.get("Subject").and_then(Value::as_str).map(str::to_owned))
            .collect();
        let names = api.get_names(&subjects).await.unwrap_or(Value::Null);
        Ok(party_summary(&party, &party_id, &api.puuid, &names))
    })
    .await
}

/// Leave the party, or start, stop or change its queue.
pub(crate) async fn party_action(app: &AppHandle, action: &str, queue: &str) -> Result<String, crate::riot::error::RiotError> {
    let riot = app.state::<RiotState>();
    let (action, queue) = (action.to_string(), queue.trim().to_ascii_lowercase());
    crate::riot::api::with_api(&riot, |api| {
        let (action, queue) = (action.clone(), queue.clone());
        async move {
            if action == "leave_party" {
                api.party_leave().await?;
                return Ok("Left the party.".to_string());
            }
            let (party_id, party) = current_party(&api).await?;
            let selected = party.pointer("/MatchmakingData/QueueID").and_then(Value::as_str).unwrap_or("?").to_string();
            match action.as_str() {
                "start_queue" => {
                    api.party_queue_join(&party_id).await?;
                    Ok(format!("Searching for a match in {selected}."))
                }
                "stop_queue" => {
                    api.party_queue_leave(&party_id).await?;
                    Ok("Stopped searching for a match.".to_string())
                }
                _ => {
                    if queue.is_empty() {
                        return Err("Name a queue, e.g. competitive.".to_string());
                    }
                    let eligible: Vec<&str> = party
                        .get("EligibleQueues")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect();
                    if !eligible.is_empty() && !eligible.iter().any(|id| id.eq_ignore_ascii_case(&queue)) {
                        return Err(format!("This party can't enter {queue}. Available: {}.", eligible.join(", ")));
                    }
                    api.party_change_queue(&party_id, &queue).await?;
                    Ok(format!("Queue changed to {queue}."))
                }
            }
        }
    })
    .await
}

fn same_riot_id(a: &str, b: &str) -> bool {
    let clean = |value: &str| value.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    clean(a) == clean(b)
}

fn chat_reply_failure(reply: &Value) -> Option<String> {
    failure_message(reply).or_else(|| (!reply.is_object()).then(|| "Chat isn't available right now.".to_string()))
}

/// Recent lines in one room or friend conversation, newest last.
async fn chat_messages(app: &AppHandle, channel: &str, friend: &str, limit: usize) -> Result<Value, String> {
    let reply = super::chat::chat_get(app.clone(), app.state::<RiotState>()).await.unwrap_or(Value::Null);
    if let Some(message) = chat_reply_failure(&reply) {
        return Err(message);
    }
    let room = |key: &str| reply.pointer(&format!("/rooms/{key}")).and_then(Value::as_str).filter(|cid| !cid.is_empty());
    let cid = match channel {
        "party" => room("party"),
        "team" => room("matchTeam").or_else(|| room("match")),
        "all" => room("matchAll"),
        "friend" => reply
            .get("conversations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|conversation| {
                conversation.get("type").and_then(Value::as_str) == Some("chat")
                    && conversation.get("title").and_then(Value::as_str).is_some_and(|title| same_riot_id(title, friend))
            })
            .and_then(|conversation| conversation.get("cid").and_then(Value::as_str)),
        _ => return Err("channel must be party, team, all or friend.".into()),
    }
    .map(str::to_owned)
    .ok_or_else(|| match channel {
        "friend" => format!("No conversation with {friend}."),
        "party" => "You aren't in a party chat right now.".to_string(),
        _ => format!("There is no {channel} chat right now; it exists during a match."),
    })?;
    let root = |value: &str| value.split('@').next().unwrap_or_default().to_ascii_lowercase();
    let lines: Vec<Value> = reply
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| message.get("conversationId").and_then(Value::as_str).is_some_and(|id| root(id) == root(&cid)))
        .map(|message| {
            json!({
                "from": message.get("senderName"),
                "you": message.get("isSelf"),
                "text": message.get("body"),
                "time": message.get("timestamp"),
            })
        })
        .collect();
    let start = lines.len().saturating_sub(limit);
    Ok(json!({ "channel": channel, "messages": lines[start..] }))
}

/// Sends `message` as the player to a room, or as a whisper to a friend.
pub(crate) async fn send_chat(app: &AppHandle, channel: &str, friend: &str, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("The message is empty.".into());
    }
    if channel == "friend" {
        let riot = app.state::<RiotState>();
        let friends = crate::riot::client::get_friends(&riot).await.map_err(|error| party_failure(&error))?;
        let pid = friends
            .iter()
            .find(|entry| {
                let name = entry.get("game_name").and_then(Value::as_str).unwrap_or_default();
                let tag = entry.get("game_tag").and_then(Value::as_str).unwrap_or_default();
                same_riot_id(&format!("{name}#{tag}"), friend)
            })
            .and_then(|entry| entry.get("pid").and_then(Value::as_str))
            .ok_or_else(|| format!("{friend} isn't on your friends list."))?;
        crate::riot::client::send_chat_message(&riot, pid, message, "chat")
            .await
            .map_err(|error| party_failure(&error))?;
        return Ok(format!("Whispered to {friend}."));
    }
    let room = crate::riot::models::ChatChannel::parse(channel)
        .ok_or_else(|| "channel must be party, team, all or friend.".to_string())?;
    super::riot_chat::post_to_room(room, message.to_string(), app)
        .await
        .map_err(|error| party_failure(&error))?;
    Ok(format!("Sent to {channel} chat."))
}

/// Resolves a Riot ID or PUUID, then reads that player's profile.
/// Riot ID ↔ PUUID for each query through the Riot Client's alias lookup
/// (`tools_player_resolve`), one at a time; no PD stat requests.
async fn find_players(app: &AppHandle, queries: &[String]) -> Value {
    let mut rows = Vec::with_capacity(queries.len());
    for query in queries {
        let reply = super::tools::tools_player_resolve(vec![json!(query)], app.state::<RiotState>())
            .await
            .unwrap_or(Value::Null);
        rows.push(resolved_row(query, &reply));
    }
    json!({ "players": rows })
}

fn resolved_row(query: &str, reply: &Value) -> Value {
    if let Some(message) = failure_message(reply) {
        return json!({ "query": query, "found": false, "note": message });
    }
    let text = |key: &str| reply.get(key).and_then(Value::as_str).unwrap_or_default();
    json!({
        "query": query,
        "found": true,
        "riotId": format!("{}#{}", text("gameName"), text("tagLine")),
        "puuid": text("puuid"),
    })
}

/// A player's profile (as `lookup_player` shows it) by Riot ID or PUUID.
async fn fetch_player_profile(app: &AppHandle, query: &str) -> Result<Value, String> {
    let riot = || app.state::<RiotState>();
    let resolved = super::tools::tools_player_resolve(vec![json!(query)], riot())
        .await
        .unwrap_or(Value::Null);
    if let Some(message) = failure_message(&resolved) {
        return Err(format!("{query}: {message}"));
    }
    let puuid = resolved
        .get("puuid")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{query}: no Valorant player matched that lookup."))?
        .to_string();
    let reply = super::friend_profile::friend_profile_get(vec![json!(puuid)], riot())
        .await
        .unwrap_or(Value::Null);
    if let Some(message) = failure_message(&reply) {
        return Err(format!("{query}: {message}"));
    }
    let text = |key: &str| resolved.get(key).and_then(Value::as_str).unwrap_or_default();
    let riot_id = format!("{}#{}", text("gameName"), text("tagLine"));
    Ok(player_profile(&riot_id, &puuid, reply))
}

async fn lookup_player(app: &AppHandle, query: &str) -> Value {
    match fetch_player_profile(app, query).await {
        Ok(mut profile) => {
            mark_rr(&mut profile["recentMatches"]);
            text_result(&profile, false)
        }
        Err(message) => text_result(&json!(message), true),
    }
}

/// Swaps each row's numeric `rrEarned` for a coloured `rr` ("🟢 +26") once
/// nothing else needs the number.
fn mark_rr(rows: &mut Value) {
    for row in rows.as_array_mut().into_iter().flatten() {
        if let Some(row) = row.as_object_mut() {
            let rr = row.remove("rrEarned").and_then(|rr| rr.as_i64());
            row.insert("rr".into(), rr_mark(rr).map(Value::String).unwrap_or(Value::Null));
        }
    }
}

/// One comparison row from a player profile: rank, peak, this act's record
/// and the RR trend over recent competitive games.
fn comparison_row(profile: &Value) -> Value {
    let current_season = profile.get("currentSeasonId").and_then(Value::as_str).unwrap_or_default();
    let act = profile
        .get("competitiveSeasons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|season| season.get("seasonId").and_then(Value::as_str) == Some(current_season));
    let number = |key: &str| act.and_then(|act| act.get(key)).and_then(Value::as_u64).unwrap_or(0);
    let (wins, games) = (number("wins"), number("games"));
    let rr: Vec<i64> = profile
        .get("recentMatches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|game| game.get("rrEarned").and_then(Value::as_i64))
        .collect();
    json!({
        "riotId": profile.get("riotId"),
        "currentRank": profile.get("currentRank"),
        "currentRr": profile.get("currentRr"),
        "peakRank": profile.get("peakRank"),
        "actRecord": if games > 0 { json!(format!("{wins}W–{}L", games - wins)) } else { Value::Null },
        "actWinRate": (wins * 100 + games / 2).checked_div(games).map(|rate| json!(format!("{rate}%"))).unwrap_or(Value::Null),
        "recentRanked": rr.len(),
        "recentNetRr": if rr.is_empty() { Value::Null } else { json!(rr.iter().sum::<i64>()) },
    })
}

/// Profiles for up to five players, side by side; failed lookups are listed.
async fn compare_players(app: &AppHandle, queries: &[String]) -> Value {
    let lookups = lookup_in_turn(app, queries).await;
    let mut rows = Vec::new();
    let mut failed = Vec::new();
    for result in lookups {
        match result {
            Ok(profile) => rows.push(comparison_row(&profile)),
            Err(message) => failed.push(json!(message)),
        }
    }
    if rows.is_empty() {
        return text_result(&json!(failed.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")), true);
    }
    let mut summary = json!({ "players": rows });
    if !failed.is_empty() {
        summary["notFound"] = json!(failed);
    }
    text_result(&summary, false)
}

/// Looks the players up one after another: each costs PD requests from the
/// shared budget, so they are not fired all at once.
async fn lookup_in_turn(app: &AppHandle, queries: &[String]) -> Vec<Result<Value, String>> {
    let mut results = Vec::with_capacity(queries.len());
    for query in queries {
        results.push(fetch_player_profile(app, query).await);
    }
    results
}

/// A player profile with rank tiers named.
fn player_profile(riot_id: &str, puuid: &str, reply: Value) -> Value {
    let profile = reply.get("profile").cloned().unwrap_or(Value::Null);
    let ranked = |value: Option<&Value>| value.and_then(Value::as_u64).filter(|tier| *tier > 0);
    // One readable row per match: the id to open it with, the mode, and RR and
    // ranks only where the match was competitive.
    let matches: Vec<Value> = profile
        .get("matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|game| {
            json!({
                "matchId": game.get("matchId"),
                "mode": super::bot_template::mode_label_public(
                    game.get("queueId").and_then(Value::as_str).unwrap_or_default(),
                ),
                "startedAtMillis": game.get("startMillis"),
                "rrEarned": game.get("rrEarned"),
                "rankBefore": ranked(game.get("tierBefore")).map(rank_label),
                "rankAfter": rank_move(ranked(game.get("tierBefore")), ranked(game.get("tierAfter"))),
            })
        })
        .collect();
    let matches = numbered(matches);
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
pub(super) fn player_overview(career: Value, region: Option<&str>) -> Value {
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
    let recent = numbered(recent);
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
    let recent_games = recent.len();
    let mut recent = Value::Array(recent);
    mark_rr(&mut recent);
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
            "games": recent_games,
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
/// The accessory shop mixes item kinds; the reward's item type picks the
/// valorant-api.com endpoint (as in the Store page) and the label shown.
/// Buddies and sprays are sold as levels.
const ACCESSORY_TYPES: [(&str, &str, &str); 6] = [
    ("d5f120f8-ff8c-4aac-92ea-f2b5acbe9475", "sprays", "Spray"),
    ("290f8769-97c6-492a-a1a8-caacf3d5b325", "sprays/levels", "Spray"),
    ("3f296c07-64c3-494c-923b-fe692a4fa1bd", "playercards", "Player card"),
    ("dd3bf334-87f3-40bd-b043-682a57a8dc3a", "buddies/levels", "Gun buddy"),
    ("de7caa6b-adf7-4588-bbd1-143831e786c6", "playertitles", "Player title"),
    ("03a572de-4234-31ed-d344-ababa488f981", "flex", "Flex"),
];

fn accessory_type(item_type_id: &str) -> Option<(&'static str, &'static str)> {
    ACCESSORY_TYPES
        .iter()
        .find(|(id, _, _)| id.eq_ignore_ascii_case(item_type_id))
        .map(|(_, path, kind)| (*path, *kind))
}

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
    if let Some(offers) = store.pointer("/accessory/offers").and_then(Value::as_array) {
        for (index, offer) in offers.iter().enumerate() {
            let text = |key: &str| offer.get(key).and_then(Value::as_str).unwrap_or_default();
            if let (Some((path, _)), id) = (accessory_type(text("itemTypeId")), text("itemId")) {
                if !id.is_empty() {
                    targets.push((format!("/accessory/offers/{index}"), format!("{path}/{id}")));
                }
            }
        }
    }
    targets
}

/// An item's English name from valorant-api.com. Buddy and spray levels carry
/// internal names ("AggrobotSkateboard"), so they take their parent's name
/// ("Cruiser Buddy") from the session-cached catalog.
async fn item_name(path: String) -> Option<String> {
    for (level, catalog) in [("buddies/levels/", "buddies"), ("sprays/levels/", "sprays")] {
        if let Some(id) = path.strip_prefix(level) {
            let catalog = public_catalog(catalog).await;
            let mut names = super::mcp_cosmetics::catalog_names(catalog.as_deref());
            if let Some(name) = names.remove(&id.to_ascii_lowercase()).filter(|name| !name.is_empty()) {
                return Some(name);
            }
        }
    }
    let body = fetch_public_json(&format!("https://valorant-api.com/v1/{path}?language=en-US")).await?;
    body.pointer("/data/displayName")
        .or_else(|| body.pointer("/data/titleText"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// Adds a `name` next to skin and bundle ids. Missing names are left out.
async fn with_item_names(mut store: Value) -> Value {
    let targets = store_name_targets(&store);
    let mut paths: Vec<String> = targets.iter().map(|(_, path)| path.clone()).collect();
    paths.sort();
    paths.dedup();
    let mut workers = tokio::task::JoinSet::new();
    for path in paths {
        workers.spawn(async move { (path.clone(), item_name(path).await) });
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
    // What each accessory is, known without a lookup.
    if let Some(offers) = store.pointer_mut("/accessory/offers").and_then(Value::as_array_mut) {
        for offer in offers {
            let kind = offer
                .get("itemTypeId")
                .and_then(Value::as_str)
                .and_then(accessory_type)
                .map(|(_, kind)| kind);
            if let (Some(kind), Some(entry)) = (kind, offer.as_object_mut()) {
                entry.insert("kind".into(), json!(kind));
            }
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
            "accessory": { "offers": [
                { "itemId": "e", "itemTypeId": "DD3BF334-87F3-40BD-B043-682A57A8DC3A" },
                { "itemId": "f", "itemTypeId": "de7caa6b-adf7-4588-bbd1-143831e786c6" },
                { "itemId": "g", "itemTypeId": "unknown-type" },
            ] },
        });
        assert_eq!(
            store_name_targets(&store),
            vec![
                ("/daily/offers/0".into(), "weapons/skinlevels/a".into()),
                ("/nightMarket/offers/0".into(), "weapons/skinlevels/b".into()),
                ("/featuredBundles/0".into(), "bundles/c".into()),
                ("/featuredBundles/1".into(), "bundles/d".into()),
                ("/accessory/offers/0".into(), "buddies/levels/e".into()),
                ("/accessory/offers/1".into(), "playertitles/f".into()),
            ]
        );
        assert_eq!(accessory_type("d5f120f8-ff8c-4aac-92ea-f2b5acbe9475"), Some(("sprays", "Spray")));
    }

    #[test]
    fn markers_colour_results_rr_ranks_and_parties() {
        assert_eq!(result_mark(Some("loss")).as_deref(), Some("🔴 Loss"));
        assert_eq!(result_mark(None), None);
        let mut rows = json!([{ "rrEarned": 26 }, { "rrEarned": -15 }, { "rrEarned": null }]);
        mark_rr(&mut rows);
        assert_eq!(rows, json!([{ "rr": "🟢 +26" }, { "rr": "🔴 -15" }, { "rr": null }]));
        assert_eq!(rank_move(Some(20), Some(19)).as_deref(), Some(format!("⬇ {}", rank_label(19)).as_str()));
        assert_eq!(rank_move(Some(21), Some(21)).as_deref(), Some(rank_label(21)));
        let marks = party_marks(["a", "", "b", "a", "c", "b"].into_iter());
        assert_eq!(marks, [Some("🔵 Party 1".into()), None, Some("🟠 Party 2".into()), Some("🔵 Party 1".into()), None, Some("🟠 Party 2".into())]);
    }

    #[test]
    fn closing_the_riot_client_needs_the_user_to_have_asked() {
        assert!(!user_asked(&json!({})));
        assert!(!user_asked(&json!({ "userAsked": false, "closeGame": true })));
        assert!(user_asked(&json!({ "userAsked": true })));
        for name in ["close_riot_client", "restart_riot_client"] {
            let tool = tool_list().into_iter().find(|tool| tool["name"] == name).unwrap();
            assert_eq!(tool["inputSchema"]["required"], json!(["userAsked"]));
        }
    }

    #[test]
    fn only_open_valorant_is_not_read_only() {
        let writable: Vec<String> = tool_list()
            .into_iter()
            .filter(|tool| tool["annotations"]["readOnlyHint"] != true)
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            writable,
            [
                "leave_party",
                "start_queue",
                "stop_queue",
                "change_queue",
                "send_chat_message",
                "set_presence",
                "create_party_code",
                "join_party",
                "disable_party_link",
                "open_riot_client",
                "open_valorant",
                "close_riot_client",
                "restart_riot_client",
            ]
        );
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
        let board = anonymized_scoreboard(&reduced_match(), &agents, &maps, &BTreeMap::new(), false);
        let named = anonymized_scoreboard(&reduced_match(), &agents, &maps, &BTreeMap::new(), true);
        assert!(board["players"][1].get("riotId").is_none());
        assert!(named["players"][1]["riotId"].as_str().is_some_and(|id| id.contains("#TAG")));
        assert!(named["players"][0]["riotId"].as_str().is_some());
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
        assert_eq!(board["result"], "🟢 Win");
        assert_eq!(board["lengthMinutes"], 30);
    }

    #[test]
    fn match_history_line_is_the_players_own_game() {
        let line = own_match_summary(&reduced_match(), &HashMap::new(), &HashMap::new());
        assert_eq!(line["map"], "Ascent");
        assert_eq!(line["score"], "13-11");
        assert_eq!(line["result"], "🟢 Win");
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
        let maps = HashMap::from([("bonsai".to_string(), "Split".to_string())]);
        let summary = friend_summaries(reply.clone(), "", &maps);
        let text = summary.to_string();
        assert!(!text.contains("\"p1\"") && !text.contains("party-x"));
        // The player's own notes are shown and searchable.
        assert_eq!(summary["friends"][1]["note"], "secret note");
        let found = friend_summaries(reply.clone(), "SECRET", &maps);
        assert_eq!(found["total"], 1);
        assert_eq!(found["friends"][0]["riotId"], "Off#1");
        assert_eq!(friend_summaries(reply, "on#2", &maps)["total"], 1);
        assert_eq!(summary["friends"][0]["riotId"], "On#2");
        assert_eq!(summary["friends"][0]["valorant"]["map"], "Split");
        assert_eq!(summary["friends"][0]["valorant"]["queue"], "Competitive");
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
        assert_eq!(profile["recentMatches"][0]["rankAfter"], "⬆ Ascendant 1");
        assert_eq!(profile["recentMatches"][0]["#"], 1);
        assert_eq!(profile["recentMatches"][0]["matchId"], "m");
        assert_eq!(profile["recentMatches"][1]["#"], 2);
        assert!(profile["recentMatches"][1]["rankBefore"].is_null());
        assert!(profile["recentMatches"][0].get("tierAfter").is_none());
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

    #[test]
    fn party_summary_names_members_and_queue() {
        let party = json!({
            "State": "MATCHMAKING",
            "Accessibility": "CLOSED",
            "EligibleQueues": ["competitive", "unrated"],
            "MatchmakingData": { "QueueID": "competitive" },
            "Members": [
                { "Subject": "me", "IsOwner": true, "CompetitiveTier": 21, "IsReady": true,
                  "PlayerIdentity": { "AccountLevel": 120 } },
                { "Subject": "duo", "IsOwner": false, "CompetitiveTier": 0, "IsReady": false },
            ],
        });
        let names = json!([
            { "Subject": "ME", "GameName": "Me", "TagLine": "NA1" },
            { "Subject": "duo", "GameName": "Duo", "TagLine": "" },
        ]);
        let summary = party_summary(&party, "p1", "me", &names);
        assert_eq!(summary["searching"], true);
        assert_eq!(summary["queue"], "competitive");
        assert_eq!(summary["members"][0]["riotId"], "Me#NA1");
        assert_eq!(summary["members"][0]["isYou"], true);
        assert_eq!(summary["members"][0]["rank"], "Ascendant 1");
        assert_eq!(summary["members"][1]["riotId"], "Duo");
        assert!(summary["members"][1]["rank"].is_null());
    }

    #[test]
    fn riot_ids_match_ignoring_case_and_spaces() {
        assert!(same_riot_id("Some Name#NA1", "somename#na1"));
        assert!(!same_riot_id("Some#NA1", "Some#EU1"));
    }

    #[test]
    fn comparison_row_summarizes_rank_act_and_rr_trend() {
        let profile = json!({
            "riotId": "Them#EU1",
            "currentRank": { "tier": 21, "name": "Ascendant 1" },
            "currentRr": 55,
            "peakRank": { "tier": 24, "name": "Immortal 1" },
            "currentSeasonId": "act",
            "competitiveSeasons": [{ "seasonId": "act", "wins": 12, "games": 20 }],
            "recentMatches": [{ "rrEarned": 21 }, { "rrEarned": -16 }, { "rrEarned": null }],
        });
        let row = comparison_row(&profile);
        assert_eq!(row["actRecord"], "12W–8L");
        assert_eq!(row["actWinRate"], "60%");
        assert_eq!(row["recentRanked"], 2);
        assert_eq!(row["recentNetRr"], 5);
        let empty = comparison_row(&json!({ "riotId": "New#1" }));
        assert!(empty["actRecord"].is_null() && empty["recentNetRr"].is_null());
    }

    #[test]
    fn resolved_rows_show_riot_id_and_puuid_or_the_reason() {
        let found = resolved_row("me#na1", &json!({ "success": true, "puuid": "p1", "gameName": "Me", "tagLine": "NA1" }));
        assert_eq!(found["riotId"], "Me#NA1");
        assert_eq!(found["puuid"], "p1");
        let missing = resolved_row("Nobody#000", &json!({ "success": false, "code": "playerNotFound", "error": "No Valorant player matched that lookup." }));
        assert_eq!(missing["found"], false);
        assert_eq!(missing["note"], "No Valorant player matched that lookup.");
    }
}
