use crate::riot::api::{self, RiotApiClient};
use crate::riot::client::RiotState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

/// Match history + per-match scoreboards.
///
/// Two endpoints back this:
///   * `/match-history/v1/history/<puuid>` — a thin list of
///     `{MatchID, GameStartTime, QueueID}`, cheap enough to load on open.
///   * `/match-details/v1/matches/<id>` — the full match. These are **large**
///     (830 KB+ for a competitive game, most of it `roundResults`), so details
///     are fetched lazily when a match is expanded, reduced to a scoreboard
///     here, and cached — the frontend never sees the raw document.

/// Normalized details, keyed by `<puuid>:<matchId>`. Matches are immutable once
/// played, so entries never need invalidating — but the reduction bakes in an
/// `isSelf` flag, so a cached match from one account must not be served to
/// another after an account switch.
#[derive(Default)]
pub struct MatchCache(Mutex<HashMap<String, Value>>);

fn cache_key(puuid: &str, match_id: &str) -> String {
    format!("{puuid}:{match_id}")
}

fn arg(args: &[Value], index: usize) -> Option<String> {
    args.get(index).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn arg_u32(args: &[Value], index: usize) -> Option<u32> {
    args.get(index).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).map(|v| v as u32)
}

/// Per-player damage totals, summed across every round.
#[derive(Default, Clone, Copy)]
struct Damage {
    total: u64,
    headshots: u64,
    bodyshots: u64,
    legshots: u64,
}

fn aggregate_damage(round_results: &[Value]) -> HashMap<String, Damage> {
    let mut totals: HashMap<String, Damage> = HashMap::new();
    for round in round_results {
        let Some(player_stats) = round.get("playerStats").and_then(|v| v.as_array()) else { continue };
        for stat in player_stats {
            let Some(subject) = stat.get("subject").and_then(|v| v.as_str()) else { continue };
            let entry = totals.entry(subject.to_string()).or_default();
            for hit in stat.get("damage").and_then(|v| v.as_array()).into_iter().flatten() {
                let num = |key: &str| hit.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
                entry.total += num("damage");
                entry.headshots += num("headshots");
                entry.bodyshots += num("bodyshots");
                entry.legshots += num("legshots");
            }
        }
    }
    totals
}

/// Match details omit `gameName`/`tagLine` for most players, so resolve the
/// blanks in one batched nameservice call rather than showing bare puuids.
async fn resolve_missing_names(api: &RiotApiClient, players: &[Value]) -> HashMap<String, (String, String)> {
    let missing: Vec<String> = players
        .iter()
        .filter(|p| p.get("gameName").and_then(|v| v.as_str()).unwrap_or("").trim().is_empty())
        .filter_map(|p| p.get("subject").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    let mut names = HashMap::new();
    if missing.is_empty() {
        return names;
    }
    let Ok(resolved) = api.get_names(&missing).await else { return names };
    for entry in resolved.as_array().into_iter().flatten() {
        let subject = entry.get("Subject").and_then(|v| v.as_str()).unwrap_or_default();
        let game_name = entry.get("GameName").and_then(|v| v.as_str()).unwrap_or_default();
        let tag_line = entry.get("TagLine").and_then(|v| v.as_str()).unwrap_or_default();
        if !subject.is_empty() {
            names.insert(subject.to_string(), (game_name.to_string(), tag_line.to_string()));
        }
    }
    names
}

fn reduce_match(details: &Value, names: &HashMap<String, (String, String)>, own_puuid: &str) -> Value {
    let info = details.get("matchInfo").cloned().unwrap_or(json!({}));
    let round_results = details.get("roundResults").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let damage = aggregate_damage(&round_results);

    let teams: Vec<Value> = details
        .get("teams")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .map(|team| {
            json!({
                "teamId": team.get("teamId").and_then(|v| v.as_str()).unwrap_or_default(),
                "won": team.get("won").and_then(|v| v.as_bool()).unwrap_or(false),
                "roundsWon": team.get("roundsWon").and_then(|v| v.as_u64()).unwrap_or(0),
                "roundsPlayed": team.get("roundsPlayed").and_then(|v| v.as_u64()).unwrap_or(0),
            })
        })
        .collect();

    let mut players: Vec<Value> = details
        .get("players")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .map(|player| {
            let subject = player.get("subject").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let stats = player.get("stats").cloned().unwrap_or(json!({}));
            let stat = |key: &str| stats.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
            // Deathmatch reports roundsPlayed 1; guard anyway so we never divide by zero.
            let rounds = stat("roundsPlayed").max(1);
            let score = stat("score");
            let dmg = damage.get(&subject).copied().unwrap_or_default();
            let shots = dmg.headshots + dmg.bodyshots + dmg.legshots;

            let (game_name, tag_line) = match names.get(&subject) {
                Some((n, t)) => (n.clone(), t.clone()),
                None => (
                    player.get("gameName").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    player.get("tagLine").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                ),
            };

            json!({
                "subject": subject,
                "gameName": game_name,
                "tagLine": tag_line,
                "teamId": player.get("teamId").and_then(|v| v.as_str()).unwrap_or_default(),
                "partyId": player.get("partyId").and_then(|v| v.as_str()).unwrap_or_default(),
                "characterId": player.get("characterId").and_then(|v| v.as_str()).unwrap_or_default(),
                "competitiveTier": player.get("competitiveTier").and_then(|v| v.as_u64()).unwrap_or(0),
                "playerCard": player.get("playerCard").and_then(|v| v.as_str()).unwrap_or_default(),
                "accountLevel": player.get("accountLevel").and_then(|v| v.as_u64()).unwrap_or(0),
                "isSelf": !own_puuid.is_empty() && subject.eq_ignore_ascii_case(own_puuid),
                "kills": stat("kills"),
                "deaths": stat("deaths"),
                "assists": stat("assists"),
                "score": score,
                "roundsPlayed": stat("roundsPlayed"),
                // Average Combat Score / Average Damage per Round — the two numbers
                // every tracker site shows, neither of which Riot returns directly.
                "acs": score / rounds,
                "damage": dmg.total,
                "adr": dmg.total / rounds,
                "headshots": dmg.headshots,
                "bodyshots": dmg.bodyshots,
                "legshots": dmg.legshots,
                "headshotPercent": if shots > 0 { (dmg.headshots as f64 / shots as f64) * 100.0 } else { 0.0 },
            })
        })
        .collect();

    // Best players first, which is how every scoreboard in the game is ordered.
    players.sort_by(|a, b| {
        let acs = |v: &Value| v.get("acs").and_then(|v| v.as_u64()).unwrap_or(0);
        acs(b).cmp(&acs(a))
    });

    json!({
        "matchId": info.get("matchId").and_then(|v| v.as_str()).unwrap_or_default(),
        "mapId": info.get("mapId").and_then(|v| v.as_str()).unwrap_or_default(),
        "queueId": info.get("queueID").and_then(|v| v.as_str()).unwrap_or_default(),
        "gameMode": info.get("gameMode").and_then(|v| v.as_str()).unwrap_or_default(),
        "server": info.get("gamePodId").and_then(|v| v.as_str()).unwrap_or_default(),
        "gameVersion": info.get("gameVersion").and_then(|v| v.as_str()).unwrap_or_default(),
        "seasonId": info.get("seasonId").and_then(|v| v.as_str()).unwrap_or_default(),
        "startMillis": info.get("gameStartMillis").and_then(|v| v.as_u64()).unwrap_or(0),
        "lengthMillis": info.get("gameLengthMillis").and_then(|v| v.as_u64()).unwrap_or(0),
        "isRanked": info.get("isRanked").and_then(|v| v.as_bool()).unwrap_or(false),
        "completionState": info.get("completionState").and_then(|v| v.as_str()).unwrap_or_default(),
        "provisioningFlow": info.get("provisioningFlowID").and_then(|v| v.as_str()).unwrap_or_default(),
        "rounds": round_results.len(),
        "teams": teams,
        "players": players,
    })
}

#[tauri::command]
pub async fn match_list(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let start = arg_u32(&args, 0).unwrap_or(0);
    let count = arg_u32(&args, 1).unwrap_or(20).clamp(1, 25);

    let result: Result<Value, String> = async {
        let history = api::with_api(&riot, |api| async move {
            let history = api.get_match_history(&api.puuid, start, start + count).await?;
            Ok((history, api.puuid.clone()))
        })
        .await?;
        let (history, puuid) = history;
        let entries: Vec<Value> = history
            .get("History")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .map(|entry| {
                json!({
                    "matchId": entry.get("MatchID").and_then(|v| v.as_str()).unwrap_or_default(),
                    "startMillis": entry.get("GameStartTime").and_then(|v| v.as_u64()).unwrap_or(0),
                    "queueId": entry.get("QueueID").and_then(|v| v.as_str()).unwrap_or_default(),
                })
            })
            .collect();

        Ok(json!({
            "success": true,
            "matches": entries,
            "total": history.get("Total").and_then(|v| v.as_u64()).unwrap_or(0),
            "puuid": puuid,
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

/// Warm several matches at once so a history list can show per-match stats
/// (KDA, headshot rate) without the user expanding every row.
///
/// Each match is emitted on `match:details` the moment it resolves rather than
/// batched into one reply — the documents are large and fetched one at a time,
/// so progressive filling beats a multi-second wait for the whole set.
#[tauri::command]
pub async fn match_summaries(
    args: Vec<Value>,
    app: tauri::AppHandle,
    riot: State<'_, RiotState>,
    cache: State<'_, MatchCache>,
) -> Result<String, ()> {
    use tauri::Emitter;

    let ids: Vec<String> = args
        .first()
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Ok(json!({ "success": true, "count": 0 }).to_string());
    }

    let mut api = match api::create_api(&riot).await {
        Ok(api) => api,
        Err(e) => return Ok(json!({ "success": false, "error": e }).to_string()),
    };

    let mut sent = 0usize;
    for match_id in ids {
        let key = cache_key(&api.puuid, &match_id);
        let cached = cache.0.lock().unwrap().get(&key).cloned();
        let reduced = match cached {
            Some(hit) => hit,
            None => {
                let details = match api.get_match_details(&match_id).await {
                    Ok(details) => details,
                    // The loop can outlive a token, so rebuild the client once
                    // and retry rather than abandoning the rest of the list.
                    Err(e) if api::is_auth_error(&e) => {
                        crate::riot::client::invalidate_tokens(&riot);
                        let Ok(fresh) = api::create_api(&riot).await else { break };
                        api = fresh;
                        let Ok(details) = api.get_match_details(&match_id).await else { continue };
                        details
                    }
                    Err(_) => continue,
                };
                let players = details.get("players").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                let names = resolve_missing_names(&api, &players).await;
                let reduced = reduce_match(&details, &names, &api.puuid);
                cache.0.lock().unwrap().insert(cache_key(&api.puuid, &match_id), reduced.clone());
                reduced
            }
        };
        let _ = app.emit("match:details", json!({ "success": true, "match": reduced, "cached": true }).to_string());
        sent += 1;
    }

    Ok(json!({ "success": true, "count": sent }).to_string())
}

#[tauri::command]
pub async fn match_details(args: Vec<Value>, riot: State<'_, RiotState>, cache: State<'_, MatchCache>) -> Result<String, ()> {
    let Some(match_id) = arg(&args, 0).filter(|s| !s.trim().is_empty()) else {
        return Ok(json!({ "success": false, "error": "No match id" }).to_string());
    };

    // Cheap: tokens are cached, so this doesn't hit the network in the common case.
    let own_puuid = crate::riot::client::get_tokens(&riot, false)
        .await
        .ok()
        .and_then(|t| t.get("subject").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();

    if let Some(hit) = cache.0.lock().unwrap().get(&cache_key(&own_puuid, &match_id)).cloned() {
        return Ok(json!({ "success": true, "match": hit, "cached": true }).to_string());
    }

    let result: Result<Value, String> = async {
        let match_id = match_id.clone();
        api::with_api(&riot, move |api| {
            let match_id = match_id.clone();
            async move {
                let details = api.get_match_details(&match_id).await?;
                let players = details.get("players").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                let names = resolve_missing_names(&api, &players).await;
                Ok(reduce_match(&details, &names, &api.puuid))
            }
        })
        .await
    }
    .await;

    Ok(match result {
        Ok(reduced) => {
            cache.0.lock().unwrap().insert(cache_key(&own_puuid, &match_id), reduced.clone());
            json!({ "success": true, "match": reduced, "cached": false }).to_string()
        }
        Err(e) => json!({ "success": false, "matchId": match_id, "error": e }).to_string(),
    })
}
