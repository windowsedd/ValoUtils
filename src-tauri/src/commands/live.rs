use super::live_party::{self, LivePartyHistoryCache, RATE_LIMITED_ERROR};
use super::pregame_roster::{build_pregame_roster, log_pregame_debug, redact_secrets};
use crate::riot::api::{self, RiotApiClient};
use crate::riot::client::{self, RiotState};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

// Weapon IDs we surface skins for (verified against valorant-api /v1/weapons).
const WEAPON_VANDAL: &str = "9c82e19d-4575-0200-1a81-3eacf00cf872";
const WEAPON_PHANTOM: &str = "ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a";
const WEAPON_KNIFE: &str = "2f59173c-4bed-b6c3-2191-dea9b58be9c7";

// Loadout weapon socket IDs (verified against a real coregame loadout dump).
const SOCKET_SKIN: &str = "bcef87d6-209b-46c6-8b19-fbe40bd95abc";
const SOCKET_SKIN_LEVEL: &str = "e7c63390-eda7-46e0-bb7a-a6abdacd2433";
const SOCKET_SKIN_CHROMA: &str = "3ad1b2b2-acdb-4524-852f-954a76ddae0a";
const ENRICHMENT_TTL: Duration = Duration::from_secs(10 * 60);
const LIVE_PD_TIMEOUT: Duration = Duration::from_secs(2);
const PUBLIC_UNAVAILABLE_ERROR: &str = "unavailable";

async fn run_live_pd<T, F>(cache: &LivePartyHistoryCache, request: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    run_live_pd_with_timeout(cache, LIVE_PD_TIMEOUT, request).await
}

async fn run_live_pd_with_timeout<T, F>(
    cache: &LivePartyHistoryCache,
    timeout: Duration,
    request: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::time::timeout(timeout, cache.run_pd(request))
        .await
        .map_err(|_| PUBLIC_UNAVAILABLE_ERROR.to_string())?
        .map_err(|error| {
            if error == RATE_LIMITED_ERROR {
                error
            } else {
                PUBLIC_UNAVAILABLE_ERROR.to_string()
            }
        })
}

#[derive(Clone)]
struct CachedEnrichment {
    game_name: String,
    tag_line: String,
    mmr: Option<Value>,
    inserted_at: Instant,
    complete: bool,
}

fn enrichment_is_fresh(inserted_at: Instant, complete: bool, now: Instant) -> bool {
    complete && now.duration_since(inserted_at) < ENRICHMENT_TTL
}

fn enrichment_refresh_timestamp(
    previous: Option<Instant>,
    refreshed_name: bool,
    refreshed_mmr: bool,
    now: Instant,
) -> Instant {
    match previous {
        Some(inserted_at) if !refreshed_name || !refreshed_mmr => inserted_at,
        _ => now,
    }
}

/// The renderer polls every ~5s. Current match fields are rebuilt each time,
/// while PD-backed enrichment and same-roster party continuity are retained here.
#[derive(Default)]
pub struct LiveCache {
    refresh: AsyncMutex<()>,
    enrichment: Mutex<HashMap<String, CachedEnrichment>>,
    continuity_roster: Mutex<Option<String>>,
    continuity_labels: Mutex<HashMap<String, String>>,
    /// Last roster that resolved, for callers that cannot wait for a cold one.
    /// A first pregame fetch does a name and MMR lookup for all ten players and
    /// routinely outruns the bot's template budget; without this the message
    /// rendered every variable as N/A.
    last_snapshot: Mutex<Option<(Instant, String)>>,
}

/// How long a stored roster still describes the match you are in.
pub(crate) const SNAPSHOT_FALLBACK_TTL: Duration = Duration::from_secs(90);

impl LiveCache {
    fn store_snapshot(&self, payload: &str, now: Instant) {
        *self.last_snapshot.lock().unwrap() = Some((now, payload.to_string()));
    }

    pub(crate) fn recent_snapshot_at(&self, now: Instant) -> Option<String> {
        let guard = self.last_snapshot.lock().unwrap();
        let (stored_at, payload) = guard.as_ref()?;
        (now.duration_since(*stored_at) < SNAPSHOT_FALLBACK_TTL).then(|| payload.clone())
    }

    pub(crate) fn recent_snapshot(&self) -> Option<String> {
        self.recent_snapshot_at(Instant::now())
    }
}

#[derive(Clone)]
pub struct LiveStatsCache {
    values: Arc<Mutex<HashMap<String, Value>>>,
    permits: Arc<Semaphore>,
}

impl Default for LiveStatsCache {
    fn default() -> Self {
        Self {
            values: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(3)),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum LiveState {
    CoreGame,
    PreGame,
    Party,
    Idle,
}

impl LiveState {
    fn as_str(&self) -> &'static str {
        match self {
            LiveState::CoreGame => "coregame",
            LiveState::PreGame => "pregame",
            LiveState::Party => "party",
            LiveState::Idle => "idle",
        }
    }
}

fn live_roster_keys(
    state: LiveState,
    match_id: Option<&str>,
    party_id: Option<&str>,
    roster: &str,
    party_membership: &str,
) -> (String, String) {
    let cache_key = format!(
        "{}:{}:{}:{}",
        state.as_str(),
        match_id.or(party_id).unwrap_or(""),
        roster,
        party_membership
    );
    let public_key = format!(
        "{}:{}:{}:{}",
        state.as_str(),
        match_id.unwrap_or(""),
        roster,
        party_membership
    );
    (cache_key, public_key)
}

fn extract_match_context(state: LiveState, source: &Value, match_id: Option<&str>) -> Value {
    let string = |pointers: &[&str]| {
        pointers
            .iter()
            .find_map(|pointer| source.pointer(pointer).and_then(Value::as_str))
    };
    json!({
        "id": match_id,
        "mapId": string(&["/MapID", "/MapId", "/CustomGameData/Settings/Map"]),
        "modeId": string(&["/ModeID", "/ModeId", "/GameMode", "/Mode", "/CustomGameData/Settings/Mode"]),
        "queueId": string(&["/QueueID", "/QueueId", "/MatchmakingData/QueueID"]).unwrap_or_default(),
        "server": string(&["/GamePodID", "/GamePodId", "/gamePodId"]).unwrap_or_default(),
        "phase": state.as_str(),
    })
}

fn summarize_teams(players: &[Value]) -> Vec<Value> {
    let mut teams: HashMap<String, (u64, u64)> = HashMap::new();
    for player in players {
        let Some(team) = player.get("teamId").and_then(Value::as_str) else {
            continue;
        };
        let tier = player
            .get("currentTier")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let entry = teams.entry(team.to_string()).or_default();
        if tier > 0 {
            entry.0 += tier;
            entry.1 += 1;
        }
    }

    let mut output: Vec<Value> = teams
        .into_iter()
        .map(|(id, (sum, count))| {
            json!({
                "id": id,
                "averageTier": if count > 0 { Some(sum as f64 / count as f64) } else { None },
                "ratedPlayers": count,
            })
        })
        .collect();
    output.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    output
}

fn select_match_ids_for_queue(history: &Value, queue_id: &str, limit: usize) -> Vec<String> {
    if queue_id.is_empty() || queue_id.eq_ignore_ascii_case("custom") {
        return Vec::new();
    }
    history
        .get("History")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry
                .get("QueueID")
                .and_then(Value::as_str)
                .is_some_and(|queue| queue.eq_ignore_ascii_case(queue_id))
        })
        .filter_map(|entry| {
            entry
                .get("MatchID")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .take(limit)
        .collect()
}

fn player_damage_total(puuid: &str, details: &Value) -> u64 {
    let Some(rounds) = details.get("roundResults").and_then(Value::as_array) else {
        return 0;
    };
    let mut total = 0u64;
    for round in rounds {
        let Some(player_stats) = round.get("playerStats").and_then(Value::as_array) else {
            continue;
        };
        for stat in player_stats {
            let subject = stat
                .get("subject")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !subject.eq_ignore_ascii_case(puuid) {
                continue;
            }
            for hit in stat
                .get("damage")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                total += hit.get("damage").and_then(Value::as_u64).unwrap_or(0);
            }
        }
    }
    total
}

fn find_match_player<'a>(puuid: &str, details: &'a Value) -> Option<&'a Value> {
    details.get("players")?.as_array()?.iter().find(|player| {
        player
            .get("subject")
            .and_then(Value::as_str)
            .is_some_and(|subject| subject.eq_ignore_ascii_case(puuid))
    })
}

fn normalize_recent_match(puuid: &str, details: &Value) -> Option<Value> {
    let player = find_match_player(puuid, details)?;
    let stats = player.get("stats").unwrap_or(&Value::Null);
    let number = |key: &str| stats.get(key).and_then(Value::as_u64).unwrap_or(0);
    let team_id = player.get("teamId").and_then(Value::as_str);
    let teams = details.get("teams").and_then(Value::as_array);
    let ally = teams
        .into_iter()
        .flatten()
        .find(|team| team.get("teamId").and_then(Value::as_str) == team_id);
    let enemy = teams.into_iter().flatten().find(|team| {
        team.get("teamId").and_then(Value::as_str).is_some()
            && team.get("teamId").and_then(Value::as_str) != team_id
    });
    let rounds_played = number("roundsPlayed");
    let damage = player_damage_total(puuid, details);

    Some(json!({
        "matchId": details.pointer("/matchInfo/matchId").and_then(Value::as_str).unwrap_or_default(),
        "startMillis": details.pointer("/matchInfo/gameStartMillis").and_then(Value::as_u64).unwrap_or(0),
        "mapId": details.pointer("/matchInfo/mapId").and_then(Value::as_str).unwrap_or_default(),
        "agentId": player.get("characterId").and_then(Value::as_str).unwrap_or_default(),
        "won": ally.and_then(|team| team.get("won")).and_then(Value::as_bool).unwrap_or(false),
        "allyRounds": ally.and_then(|team| team.get("roundsWon")).and_then(Value::as_u64).unwrap_or(0),
        "enemyRounds": enemy.and_then(|team| team.get("roundsWon")).and_then(Value::as_u64).unwrap_or(0),
        "kills": number("kills"),
        "deaths": number("deaths"),
        "assists": number("assists"),
        "acs": number("score") as f64 / rounds_played.max(1) as f64,
        "dpr": damage as f64 / rounds_played.max(1) as f64,
    }))
}

fn json_i64(value: Option<&Value>) -> i64 {
    value
        .and_then(|value| value.as_i64().or_else(|| value.as_u64().map(|n| n as i64)))
        .unwrap_or(0)
}

fn rr_by_match_id(updates: Option<&Value>) -> HashMap<String, i64> {
    updates
        .and_then(|value| value.get("Matches"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let match_id = entry.get("MatchID").and_then(Value::as_str)?;
            if match_id.is_empty() {
                return None;
            }
            Some((
                match_id.to_string(),
                json_i64(entry.get("RankedRatingEarned")),
            ))
        })
        .collect()
}

fn compute_streak(history: &[Value], rr_by_match: &HashMap<String, i64>) -> Value {
    if history.is_empty() {
        return json!({ "kind": Value::Null, "matches": 0, "rr": 0 });
    }
    let mut ordered = history.to_vec();
    ordered.sort_by(|a, b| {
        b.get("startMillis")
            .and_then(Value::as_u64)
            .cmp(&a.get("startMillis").and_then(Value::as_u64))
    });
    let winning = ordered[0]
        .get("won")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut matches = 0u64;
    let mut rr = 0i64;
    for summary in &ordered {
        if summary.get("won").and_then(Value::as_bool).unwrap_or(false) != winning {
            break;
        }
        matches += 1;
        if let Some(match_id) = summary.get("matchId").and_then(Value::as_str) {
            rr += rr_by_match.get(match_id).copied().unwrap_or(0);
        }
    }
    json!({
        "kind": if winning { "win" } else { "lose" },
        "matches": matches,
        "rr": rr,
    })
}

fn aggregate_recent_stats(puuid: &str, matches: &[Value]) -> Result<Value, String> {
    aggregate_recent_stats_with_rr(puuid, matches, &HashMap::new())
}

fn aggregate_recent_stats_with_rr(
    puuid: &str,
    matches: &[Value],
    rr_by_match: &HashMap<String, i64>,
) -> Result<Value, String> {
    let mut analyzed = 0u64;
    let mut wins = 0u64;
    let mut kills = 0u64;
    let mut deaths = 0u64;
    let mut assists = 0u64;
    let mut score = 0u64;
    let mut rounds = 0u64;
    let mut damage = 0u64;
    let mut history = Vec::new();

    for details in matches {
        let Some(player) = find_match_player(puuid, details) else {
            continue;
        };
        let Some(summary) = normalize_recent_match(puuid, details) else {
            continue;
        };
        let stats = player.get("stats").unwrap_or(&Value::Null);
        let number = |key: &str| stats.get(key).and_then(Value::as_u64).unwrap_or(0);
        let team_id = player.get("teamId").and_then(Value::as_str);

        analyzed += 1;
        kills += number("kills");
        deaths += number("deaths");
        assists += number("assists");
        score += number("score");
        rounds += number("roundsPlayed");
        damage += player_damage_total(puuid, details);
        history.push(summary);
        if team_id.is_some_and(|team_id| {
            details
                .get("teams")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|team| {
                    team.get("teamId").and_then(Value::as_str) == Some(team_id)
                        && team.get("won").and_then(Value::as_bool).unwrap_or(false)
                })
        }) {
            wins += 1;
        }
    }

    if analyzed == 0 {
        return Err("No recent competitive match data was available for this player.".into());
    }

    Ok(json!({
        "matches": analyzed,
        "kills": kills,
        "deaths": deaths,
        "assists": assists,
        "wins": wins,
        "kd": kills as f64 / deaths.max(1) as f64,
        "winRate": wins as f64 * 100.0 / analyzed as f64,
        "acs": score as f64 / rounds.max(1) as f64,
        "dpr": damage as f64 / rounds.max(1) as f64,
        "history": history,
        "streak": compute_streak(&history, rr_by_match),
    }))
}

fn is_not_found(error: &str) -> bool {
    error.contains("404")
}

async fn safe_get_player<F, Fut>(f: F) -> Result<Option<Value>, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    match f().await {
        Ok(v) => Ok(Some(v)),
        Err(e) if is_not_found(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

fn non_negative(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0).max(0)
}

pub(crate) fn extract_competitive_seasons(mmr: Option<&Value>) -> (Option<String>, Vec<Value>) {
    let Some(mmr) = mmr else {
        return (None, vec![]);
    };
    let current_season_id = mmr
        .pointer("/LatestCompetitiveUpdate/SeasonID")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let Some(seasonal) = mmr
        .pointer("/QueueSkills/competitive/SeasonalInfoBySeasonID")
        .and_then(Value::as_object)
    else {
        return (current_season_id, vec![]);
    };

    let seasons = seasonal
        .iter()
        .filter(|(season_id, _)| !season_id.is_empty())
        .map(|(season_id, info)| {
            let mut wins_by_tier = serde_json::Map::new();
            if let Some(wins) = info.get("WinsByTier").and_then(Value::as_object) {
                for (tier, count) in wins {
                    let valid_tier = tier
                        .parse::<i64>()
                        .ok()
                        .filter(|tier| (3..=27).contains(tier));
                    let count = non_negative(Some(count));
                    if valid_tier.is_some() && count > 0 {
                        wins_by_tier.insert(tier.clone(), json!(count));
                    }
                }
            }
            json!({
                "seasonId": season_id,
                "tier": non_negative(info.get("CompetitiveTier")),
                "rankedRating": non_negative(info.get("RankedRating")),
                "wins": non_negative(info.get("NumberOfWins")),
                "games": non_negative(info.get("NumberOfGames")),
                "winsByTier": wins_by_tier,
            })
        })
        .collect();
    (current_season_id, seasons)
}

pub(crate) fn extract_rank(mmr: Option<&Value>) -> (i64, i64, i64, Option<String>) {
    let Some(mmr) = mmr else {
        return (0, 0, 0, None);
    };
    let seasonal = mmr
        .pointer("/QueueSkills/competitive/SeasonalInfoBySeasonID")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let latest = mmr.get("LatestCompetitiveUpdate");

    let mut current_tier = latest
        .and_then(|l| l.get("TierAfterUpdate"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let mut current_rr = latest
        .and_then(|l| l.get("RankedRatingAfterUpdate"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let mut peak_tier = 0i64;
    let mut peak_season_id: Option<String> = None;
    let has_latest = latest.is_some();

    for (season_id, info) in seasonal.iter() {
        let win_tiers: Vec<i64> = info
            .get("WinsByTier")
            .and_then(|v| v.as_object())
            .map(|obj| obj.keys().filter_map(|k| k.parse::<i64>().ok()).collect())
            .unwrap_or_default();
        let competitive_tier = info
            .get("CompetitiveTier")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let season_peak = competitive_tier.max(win_tiers.into_iter().max().unwrap_or(0));
        if season_peak > peak_tier {
            peak_tier = season_peak;
            peak_season_id = Some(season_id.clone());
        }
        if !has_latest && competitive_tier > 0 && current_tier == 0 {
            current_tier = competitive_tier;
            current_rr = info
                .get("RankedRating")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
        }
    }

    (current_tier, current_rr, peak_tier, peak_season_id)
}

fn extract_weapon(items: &Value, weapon_id: &str) -> Option<Value> {
    let sockets = items.get(weapon_id)?.get("Sockets")?;
    Some(json!({
        "skinId": sockets.pointer(&format!("/{SOCKET_SKIN}/Item/ID")),
        "levelId": sockets.pointer(&format!("/{SOCKET_SKIN_LEVEL}/Item/ID")),
        "chromaId": sockets.pointer(&format!("/{SOCKET_SKIN_CHROMA}/Item/ID")),
    }))
}

fn build_loadout(items: Option<&Value>) -> Value {
    let empty = Value::Null;
    let items = items.unwrap_or(&empty);
    json!({
        "vandal": extract_weapon(items, WEAPON_VANDAL),
        "phantom": extract_weapon(items, WEAPON_PHANTOM),
        "knife": extract_weapon(items, WEAPON_KNIFE),
    })
}

/// subject -> loadout, plus positional fallback for entries with no `Subject`.
struct LoadoutMap {
    by_subject: HashMap<String, Value>,
    by_index: Vec<Value>,
}

fn build_loadout_map(loadouts: &Value) -> LoadoutMap {
    let mut by_subject = HashMap::new();
    let mut by_index = Vec::new();
    for entry in loadouts
        .get("Loadouts")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        // coregame nests the real loadout under `.Loadout`; pregame is flatter.
        let inner = entry.get("Loadout").unwrap_or(entry);
        let loadout = build_loadout(inner.get("Items"));
        by_index.push(loadout.clone());
        if let Some(subject) = inner
            .get("Subject")
            .or_else(|| entry.get("Subject"))
            .and_then(|v| v.as_str())
        {
            by_subject.insert(subject.to_string(), loadout);
        }
    }
    LoadoutMap {
        by_subject,
        by_index,
    }
}

fn normalize_raw_players(state: LiveState, source: &Value) -> Vec<Value> {
    match state {
        LiveState::CoreGame => source
            .get("Players")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        LiveState::PreGame => {
            let tag = |players: Option<&Vec<Value>>, team: &str| -> Vec<Value> {
                players
                    .into_iter()
                    .flatten()
                    .map(|p| {
                        let mut p = p.clone();
                        p["TeamID"] = json!(team);
                        p
                    })
                    .collect()
            };
            let mut all = tag(
                source
                    .pointer("/AllyTeam/Players")
                    .and_then(|v| v.as_array()),
                "Ally",
            );
            all.extend(tag(
                source
                    .pointer("/EnemyTeam/Players")
                    .and_then(|v| v.as_array()),
                "Enemy",
            ));
            all
        }
        LiveState::Party => source
            .get("Members")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        LiveState::Idle => Vec::new(),
    }
}

fn raw_puuid(p: &Value) -> String {
    p.get("Subject")
        .or_else(|| p.get("PUUID"))
        .or_else(|| p.get("puuid"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Decode a VALORANT presence `private` blob (base64 JSON) and pull out the
/// player's party id, tolerating the newer `partyPresenceData` nesting.
fn decode_presence_party(private: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(private)
        .ok()?;
    let json: Value = serde_json::from_slice(&bytes).ok()?;
    json.pointer("/partyPresenceData/partyId")
        .or_else(|| json.get("partyId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

async fn build_presence_party_map(riot: &RiotState) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(presences) = client::get_presences(riot).await {
        for p in presences {
            let puuid = p
                .get("puuid")
                .or_else(|| p.get("PUUID"))
                .and_then(|v| v.as_str());
            let party_id = p
                .get("private")
                .and_then(|v| v.as_str())
                .and_then(decode_presence_party);
            if let (Some(puuid), Some(party_id)) = (puuid, party_id) {
                map.insert(puuid.to_string(), party_id);
            }
        }
    }
    map
}

async fn enrich_players(
    api: &RiotApiClient,
    raw_players: &[Value],
    loadout_map: Option<&LoadoutMap>,
    cache: &LiveCache,
    pd_cache: &LivePartyHistoryCache,
) -> (Vec<Value>, bool) {
    let puuids: Vec<String> = raw_players
        .iter()
        .map(raw_puuid)
        .filter(|s| !s.is_empty())
        .collect();

    let now = Instant::now();
    let mut enrichments = HashMap::new();
    let mut refresh_puuids = Vec::new();
    {
        let stored = cache.enrichment.lock().unwrap();
        for puuid in &puuids {
            let normalized = puuid.to_ascii_lowercase();
            if let Some(entry) = stored.get(&normalized).cloned() {
                if enrichment_is_fresh(entry.inserted_at, entry.complete, now) {
                    enrichments.insert(normalized, entry);
                    continue;
                }
                enrichments.insert(normalized, entry);
            }
            refresh_puuids.push(puuid.clone());
        }
    }

    let mut rate_limited = false;
    let names_result = if refresh_puuids.is_empty() {
        Ok(Value::Array(vec![]))
    } else {
        run_live_pd(pd_cache, api.get_names(&refresh_puuids)).await
    };
    if names_result
        .as_ref()
        .err()
        .is_some_and(|error| error == RATE_LIMITED_ERROR)
    {
        rate_limited = true;
    }
    let names_res = names_result.unwrap_or(Value::Array(vec![]));
    let mut refreshed_names: HashMap<String, (String, String)> = HashMap::new();
    for n in names_res.as_array().into_iter().flatten() {
        if let Some(subject) = n.get("Subject").and_then(|v| v.as_str()) {
            let game_name = n
                .get("GameName")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            // An empty GameName is Riot declining to answer, not an answer.
            // Recording it marked the entry `complete`, which made it cache as
            // fresh and stopped the retry — a pregame enemy that resolved on
            // the next poll stayed "Hidden Player" for the whole TTL instead.
            if game_name.is_empty() {
                continue;
            }
            refreshed_names.insert(
                subject.to_ascii_lowercase(),
                (
                    game_name,
                    n.get("TagLine")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                ),
            );
        }
    }

    for puuid in refresh_puuids {
        let normalized = puuid.to_ascii_lowercase();
        let previous = enrichments.get(&normalized).cloned();
        let refreshed_name = refreshed_names.get(&normalized).cloned();
        let name = refreshed_name
            .clone()
            .or_else(|| {
                previous
                    .as_ref()
                    .map(|entry| (entry.game_name.clone(), entry.tag_line.clone()))
            })
            .unwrap_or_default();
        let mmr_result = run_live_pd(pd_cache, api.get_mmr(&puuid)).await;
        if mmr_result
            .as_ref()
            .err()
            .is_some_and(|error| error == RATE_LIMITED_ERROR)
        {
            rate_limited = true;
        }
        let refreshed_mmr = mmr_result.ok();
        let mmr = refreshed_mmr
            .clone()
            .or_else(|| previous.as_ref().and_then(|entry| entry.mmr.clone()));
        if previous.is_some() || !name.0.is_empty() || mmr.is_some() {
            let inserted_at = enrichment_refresh_timestamp(
                previous.as_ref().map(|entry| entry.inserted_at),
                refreshed_name.is_some(),
                refreshed_mmr.is_some(),
                now,
            );
            let entry = CachedEnrichment {
                game_name: name.0,
                tag_line: name.1,
                mmr,
                inserted_at,
                complete: refreshed_name.is_some() && refreshed_mmr.is_some(),
            };
            cache
                .enrichment
                .lock()
                .unwrap()
                .insert(normalized.clone(), entry.clone());
            enrichments.insert(normalized, entry);
        }
    }

    let players = raw_players
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let puuid = raw_puuid(raw);
            let enrichment = enrichments.get(&puuid.to_ascii_lowercase());
            let mmr = enrichment.and_then(|entry| entry.mmr.as_ref());
            let (current_tier, current_rr, peak_tier, peak_season_id) = extract_rank(mmr);
            let (current_season_id, competitive_seasons) = extract_competitive_seasons(mmr);
            let (game_name, tag_line) = enrichment
                .map(|entry| (entry.game_name.clone(), entry.tag_line.clone()))
                .unwrap_or_default();
            let identity = raw.get("PlayerIdentity").cloned().unwrap_or(json!({}));

            let loadout = loadout_map.and_then(|lm| {
                lm.by_subject.get(&puuid).cloned().or_else(|| {
                    // Positional fallback is only safe when this subject is absent
                    // from the map; never assign another player's loadout to a
                    // Pregame stub that already has a PUUID.
                    if lm.by_subject.is_empty() {
                        lm.by_index.get(index).cloned()
                    } else {
                        None
                    }
                })
            });

            let hide_level = identity.get("HideAccountLevel").and_then(|v| v.as_bool()).unwrap_or(false);
            let character_id = raw
                .get("CharacterID")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(Value::from)
                .unwrap_or(Value::Null);

            json!({
                "puuid": puuid,
                "gameName": game_name,
                "tagLine": tag_line,
                "teamId": raw.get("TeamID"),
                "characterId": character_id,
                "cardId": identity.get("PlayerCardID"),
                "level": if hide_level { Value::Null } else { identity.get("AccountLevel").cloned().unwrap_or(Value::Null) },
                "currentTier": current_tier,
                "currentRR": current_rr,
                "peakTier": peak_tier,
                "peakSeasonId": peak_season_id,
                "currentSeasonId": current_season_id,
                "competitiveSeasons": competitive_seasons,
                "party": Value::Null,
                "isSelf": puuid.eq_ignore_ascii_case(&api.puuid),
                "incognito": identity.get("Incognito").and_then(|v| v.as_bool()).unwrap_or(false),
                "inMyParty": puuid.eq_ignore_ascii_case(&api.puuid),
                "loadout": loadout,
            })
        })
        .collect();
    (players, rate_limited)
}

/// Flag the players you are actually queued with.
///
/// `premade` is Riot's own party roster (`/parties/v1/parties/<id>` Members),
/// not the anonymous party *inference* — the inference can group strangers, and
/// this flag unmasks names, so it must come from the authoritative source only.
fn apply_party_membership(players: &mut [Value], premade: &HashSet<String>) {
    let premade: HashSet<String> = premade
        .iter()
        .map(|puuid| puuid.to_ascii_lowercase())
        .collect();
    for player in players {
        let puuid = raw_puuid(player).to_ascii_lowercase();
        let is_self = player
            .get("isSelf")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        player["inMyParty"] = Value::Bool(is_self || premade.contains(&puuid));
    }
}

fn apply_party_labels(players: &mut [Value], labels: &HashMap<String, String>) {
    for player in players {
        let puuid = raw_puuid(player).to_ascii_lowercase();
        player["party"] = labels
            .get(&puuid)
            .cloned()
            .map(Value::String)
            .unwrap_or(Value::Null);
    }
}

struct DetectedState {
    state: LiveState,
    match_id: Option<String>,
    party_id: Option<String>,
    match_data: Option<Value>,
    loadouts: Option<Value>,
    premade: Vec<String>,
}

async fn detect_state(api: &RiotApiClient, puuid: &str) -> Result<DetectedState, String> {
    let mut premade = Vec::new();
    let mut party: Option<Value> = None;
    let party_p = safe_get_player(|| api.party_get_by_player(puuid)).await?;
    let party_id = party_p
        .as_ref()
        .and_then(|p| p.get("CurrentPartyID"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if let Some(party_id) = &party_id {
        party = api.party_get(party_id).await.ok();
        premade = party
            .as_ref()
            .and_then(|p| p.get("Members"))
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|m| {
                m.get("Subject")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
    }

    // 1. Live core game
    if let Some(core_p) = safe_get_player(|| api.coregame_get_player(puuid)).await? {
        if let Some(match_id) = core_p.get("MatchID").and_then(|v| v.as_str()) {
            let match_data = api.coregame_get_match(match_id).await?;
            let loadouts = api.coregame_get_loadouts(match_id).await.ok();
            return Ok(DetectedState {
                state: LiveState::CoreGame,
                match_id: Some(match_id.to_string()),
                party_id,
                match_data: Some(match_data),
                loadouts,
                premade,
            });
        }
    }

    // 2. Agent select
    if let Some(pre_p) = safe_get_player(|| api.pregame_get_player(puuid)).await? {
        if let Some(match_id) = pre_p.get("MatchID").and_then(|v| v.as_str()) {
            let match_data = api.pregame_get_match(match_id).await?;
            let loadouts = api.pregame_get_loadouts(match_id).await.ok();
            return Ok(DetectedState {
                state: LiveState::PreGame,
                match_id: Some(match_id.to_string()),
                party_id,
                match_data: Some(match_data),
                loadouts,
                premade,
            });
        }
    }

    // 3. Party lobby
    if let (Some(party_id), Some(party)) = (&party_id, &party) {
        return Ok(DetectedState {
            state: LiveState::Party,
            match_id: None,
            party_id: Some(party_id.clone()),
            match_data: Some(party.clone()),
            loadouts: None,
            premade,
        });
    }

    Ok(DetectedState {
        state: LiveState::Idle,
        match_id: None,
        party_id: None,
        match_data: None,
        loadouts: None,
        premade: Vec::new(),
    })
}

#[tauri::command]
pub async fn live_game_fetch(
    riot: State<'_, RiotState>,
    cache: State<'_, LiveCache>,
    party_history_cache: State<'_, LivePartyHistoryCache>,
) -> Result<String, ()> {
    // Polls and manual refreshes can overlap. Serializing the complete refresh
    // prevents an older, slower request from replacing a newer snapshot/cache.
    let _refresh_guard = cache.refresh.lock().await;
    let api = match api::create_api(&riot).await {
        Ok(api) => api,
        Err(_) => return Ok(json!({ "success": false, "code": "loginRequired" }).to_string()),
    };

    let result = async {
        let detected = detect_state(&api, &api.puuid).await?;

        if detected.state == LiveState::Idle {
            let payload = json!({
                "success": true,
                "state": "idle",
                "rosterKey": "idle",
                "match": Value::Null,
                "teams": [],
                "players": []
            })
            .to_string();
            return Ok(payload);
        }

        let match_data = detected.match_data.clone().unwrap_or(Value::Null);
        let chat = if detected.state == LiveState::PreGame {
            match tokio::time::timeout(
                std::time::Duration::from_millis(800),
                client::get_pre_game_chat_info(&riot),
            )
            .await
            {
                Ok(Ok(value)) => Some(value),
                _ => None,
            }
        } else {
            None
        };
        let (raw_players, pregame_debug) = if detected.state == LiveState::PreGame {
            let roster = build_pregame_roster(
                &match_data,
                detected.loadouts.as_ref(),
                chat.as_ref(),
                &api.puuid,
            );
            log_pregame_debug(&roster.debug);
            (roster.players, Some(roster.debug))
        } else {
            (normalize_raw_players(detected.state, &match_data), None)
        };

        let loadout_map = detected.loadouts.as_ref().map(build_loadout_map);
        let presence_map = build_presence_party_map(&riot).await;
        let premade_set: HashSet<String> = detected.premade.into_iter().collect();
        let roster: Vec<String> = raw_players
            .iter()
            .map(raw_puuid)
            .filter(|s| !s.is_empty())
            .collect();
        let mut sorted_roster = roster.clone();
        sorted_roster.sort_by_key(|puuid| puuid.to_ascii_lowercase());
        let roster_key = sorted_roster.join(",").to_ascii_lowercase();
        let continuity_labels =
            if cache.continuity_roster.lock().unwrap().as_deref() == Some(roster_key.as_str()) {
                cache.continuity_labels.lock().unwrap().clone()
            } else {
                HashMap::new()
            };
        let party_resolution = live_party::resolve_live_parties(
            &api,
            &roster,
            &presence_map,
            &premade_set,
            detected.party_id.as_deref(),
            &continuity_labels,
            &party_history_cache,
        )
        .await;
        let party_membership = party_resolution.partition_key(&roster);
        let party_labels = party_resolution.anonymous_labels(&roster);
        let (_, public_roster_key) = live_roster_keys(
            detected.state,
            detected.match_id.as_deref(),
            detected.party_id.as_deref(),
            &roster_key,
            &party_membership,
        );

        let (mut players, enrichment_rate_limited) = enrich_players(
            &api,
            &raw_players,
            loadout_map.as_ref(),
            &cache,
            &party_history_cache,
        )
        .await;
        let warning = if enrichment_rate_limited || party_history_cache.is_cooling_down().await {
            Some(RATE_LIMITED_ERROR)
        } else {
            None
        };
        apply_party_labels(&mut players, &party_labels);
        apply_party_membership(&mut players, &premade_set);
        *cache.continuity_roster.lock().unwrap() = Some(roster_key.clone());
        *cache.continuity_labels.lock().unwrap() = party_labels;

        let match_context =
            extract_match_context(detected.state, &match_data, detected.match_id.as_deref());
        let teams = summarize_teams(&players);
        let payload = json!({
            "success": true,
            "state": detected.state.as_str(),
            "rosterKey": public_roster_key,
            "match": match_context,
            "teams": teams,
            "players": players,
            "warning": warning,
            "pregameDebug": pregame_debug
        })
        .to_string();
        cache.store_snapshot(&payload, Instant::now());
        Ok::<String, String>(payload)
    }
    .await;

    Ok(result.unwrap_or_else(|error| {
        let error = if error == RATE_LIMITED_ERROR {
            RATE_LIMITED_ERROR
        } else {
            PUBLIC_UNAVAILABLE_ERROR
        };
        json!({ "success": false, "error": error }).to_string()
    }))
}

async fn fetch_recent_stats(
    api: RiotApiClient,
    puuid: String,
    queue_id: String,
    cache: Arc<Mutex<HashMap<String, Value>>>,
    permits: Arc<Semaphore>,
    pd_cache: LivePartyHistoryCache,
) -> (String, Result<Value, String>) {
    let result = async {
        let _permit = permits
            .acquire_owned()
            .await
            .map_err(|_| "Recent-stat worker pool is unavailable.".to_string())?;
        if queue_id.is_empty() || queue_id.eq_ignore_ascii_case("custom") {
            return Err("Recent stats are unavailable for this game mode.".into());
        }
        let history = if let Some(history) = pd_cache.get_history_document(&puuid) {
            history
        } else {
            let history = run_live_pd(&pd_cache, api.get_match_history(&puuid, 0, 25)).await?;
            pd_cache.put_history_document(&puuid, history.clone());
            history
        };
        let match_ids = select_match_ids_for_queue(&history, &queue_id, 5);
        if match_ids.is_empty() {
            return Err(format!(
                "No recent {queue_id} matches were found for this player."
            ));
        }

        let cache_key = format!(
            "{}:{}:{}",
            puuid.to_lowercase(),
            queue_id.to_lowercase(),
            match_ids.join(",")
        );
        if let Some(cached) = cache.lock().unwrap().get(&cache_key).cloned() {
            return Ok(cached);
        }

        let competitive_updates =
            match run_live_pd(&pd_cache, api.get_competitive_history(&puuid, 0, 20)).await {
                Ok(value) => Some(value),
                Err(error) if error == RATE_LIMITED_ERROR => return Err(error),
                Err(_) => None,
            };
        let expected_matches = match_ids.len();
        let mut matches = Vec::with_capacity(expected_matches);
        for match_id in match_ids {
            if let Some(details) = pd_cache.get_match(&match_id) {
                matches.push(details);
                continue;
            }
            match run_live_pd(&pd_cache, api.get_match_details(&match_id)).await {
                Ok(details) => {
                    pd_cache.put_match(&match_id, details.clone());
                    matches.push(details);
                }
                Err(error) if error == RATE_LIMITED_ERROR => return Err(error),
                Err(_) => {}
            }
        }
        let stats = aggregate_recent_stats_with_rr(
            &puuid,
            &matches,
            &rr_by_match_id(competitive_updates.as_ref()),
        )?;
        let normalized_matches = stats["matches"].as_u64().unwrap_or_default() as usize;
        if should_cache_recent_stats(expected_matches, matches.len(), normalized_matches) {
            cache.lock().unwrap().insert(cache_key, stats.clone());
        }
        Ok(stats)
    }
    .await;
    (puuid, result)
}

pub(crate) async fn template_recent_stats(
    riot: &RiotState,
    cache: &LiveStatsCache,
    pd_cache: &LivePartyHistoryCache,
    puuids: Vec<String>,
    queue_id: String,
    deadline: tokio::time::Instant,
) -> HashMap<String, Value> {
    let Ok(Ok(api)) = tokio::time::timeout_at(deadline, api::create_api(riot)).await else {
        return HashMap::new();
    };
    let mut workers = tokio::task::JoinSet::new();
    for puuid in puuids {
        workers.spawn(fetch_recent_stats(
            api.clone(),
            puuid,
            queue_id.clone(),
            cache.values.clone(),
            cache.permits.clone(),
            pd_cache.clone(),
        ));
    }

    let mut values = HashMap::new();
    loop {
        match tokio::time::timeout_at(deadline, workers.join_next()).await {
            Ok(Some(Ok((puuid, Ok(stats))))) => {
                values.insert(puuid.to_ascii_lowercase(), stats);
            }
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => break,
        }
    }
    workers.abort_all();
    values
}

fn should_cache_recent_stats(expected: usize, fetched: usize, normalized: usize) -> bool {
    expected > 0 && expected == fetched && expected == normalized
}

#[tauri::command]
pub async fn live_game_stats(
    args: Vec<Value>,
    app: AppHandle,
    riot: State<'_, RiotState>,
    cache: State<'_, LiveStatsCache>,
    pd_cache: State<'_, LivePartyHistoryCache>,
) -> Result<String, ()> {
    use tauri::Emitter;

    let roster_key = args
        .first()
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let attempt_id = args.get(2).and_then(Value::as_u64).unwrap_or_default();
    let queue_id = args
        .get(3)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let players: Vec<String> = args
        .get(1)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            value
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .collect();
    if roster_key.is_empty() || players.is_empty() {
        return Ok(json!({ "success": true, "rosterKey": roster_key, "attemptId": attempt_id, "count": 0 }).to_string());
    }

    let api = match api::create_api(&riot).await {
        Ok(api) => api,
        Err(_) => {
            return Ok(json!({
                "success": false,
                "rosterKey": roster_key,
                "attemptId": attempt_id,
                "error": PUBLIC_UNAVAILABLE_ERROR,
            })
            .to_string())
        }
    };
    let requested = players.len();
    let mut pending = players.into_iter();
    let mut workers = tokio::task::JoinSet::new();
    let shared_cache = cache.values.clone();
    let shared_permits = cache.permits.clone();
    let pd_cache = pd_cache.inner().clone();

    for _ in 0..3 {
        let Some(puuid) = pending.next() else { break };
        workers.spawn(fetch_recent_stats(
            api.clone(),
            puuid,
            queue_id.clone(),
            shared_cache.clone(),
            shared_permits.clone(),
            pd_cache.clone(),
        ));
    }

    while let Some(joined) = workers.join_next().await {
        if let Ok((puuid, result)) = joined {
            let payload = match result {
                Ok(stats) => json!({
                    "rosterKey": roster_key,
                    "attemptId": attempt_id,
                    "puuid": puuid,
                    "success": true,
                    "stats": stats,
                    "error": Value::Null,
                }),
                Err(error) => json!({
                    "rosterKey": roster_key,
                    "attemptId": attempt_id,
                    "puuid": puuid,
                    "success": false,
                    "stats": Value::Null,
                    "error": error,
                }),
            };
            let _ = app.emit("live-game:player-stats", payload.to_string());
        }

        if let Some(puuid) = pending.next() {
            workers.spawn(fetch_recent_stats(
                api.clone(),
                puuid,
                queue_id.clone(),
                shared_cache.clone(),
                shared_permits.clone(),
                pd_cache.clone(),
            ));
        }
    }

    Ok(json!({ "success": true, "rosterKey": roster_key, "attemptId": attempt_id, "count": requested }).to_string())
}

#[tauri::command]
pub async fn live_game_dump(app: AppHandle, riot: State<'_, RiotState>) -> Result<String, ()> {
    use tauri_plugin_dialog::DialogExt;

    let api = match api::create_api(&riot).await {
        Ok(api) => api,
        Err(_) => return Ok(json!({ "success": false, "code": "loginRequired" }).to_string()),
    };

    let mut out = Map::new();
    out.insert("puuid".into(), json!(api.puuid));
    out.insert("region".into(), json!(api.region));
    out.insert("clientVersion".into(), json!(api.client_version));

    macro_rules! grab {
        ($label:expr, $fut:expr) => {
            match $fut.await {
                Ok(v) => out.insert($label.into(), v),
                Err(e) => out.insert($label.into(), json!({ "__error": e })),
            }
        };
    }

    grab!("party.getByPlayer", api.party_get_by_player(&api.puuid));
    let party_id = out
        .get("party.getByPlayer")
        .and_then(|v| v.get("CurrentPartyID"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if let Some(party_id) = &party_id {
        grab!("party.get", api.party_get(party_id));
    }

    let presences_dump = async {
        let presences = client::get_presences(&riot).await?;
        let mapped: Vec<Value> = presences
            .iter()
            .map(|p| {
                json!({
                    "puuid": p.get("puuid").or_else(|| p.get("PUUID")),
                    "gameName": p.get("game_name"),
                    "decodedPartyId": p.get("private").and_then(|v| v.as_str()).and_then(decode_presence_party),
                })
            })
            .collect();
        Ok::<Value, String>(json!(mapped))
    };
    grab!("chat.presences", presences_dump);

    grab!("pregame.getPlayer", api.pregame_get_player(&api.puuid));
    let pre_match_id = out
        .get("pregame.getPlayer")
        .and_then(|v| v.get("MatchID"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if let Some(match_id) = &pre_match_id {
        grab!("pregame.getMatch", api.pregame_get_match(match_id));
        grab!("pregame.getLoadouts", api.pregame_get_loadouts(match_id));
    }

    grab!("coregame.getPlayer", api.coregame_get_player(&api.puuid));
    let core_match_id = out
        .get("coregame.getPlayer")
        .and_then(|v| v.get("MatchID"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if let Some(match_id) = &core_match_id {
        grab!("coregame.getMatch", api.coregame_get_match(match_id));
        grab!("coregame.getLoadouts", api.coregame_get_loadouts(match_id));
    }

    if pre_match_id.is_some() {
        let match_data = out.get("pregame.getMatch").cloned().unwrap_or(Value::Null);
        let loadouts = out.get("pregame.getLoadouts").cloned();
        let chat = client::get_pre_game_chat_info(&riot).await.ok();
        let roster =
            build_pregame_roster(&match_data, loadouts.as_ref(), chat.as_ref(), &api.puuid);
        out.insert("pregame.rosterDebug".into(), roster.debug);
    }

    let mut dump = Value::Object(out);
    redact_secrets(&mut dump);
    let json_str = serde_json::to_string_pretty(&dump).unwrap_or_default();
    let file_path = app
        .dialog()
        .file()
        .set_title("Dump live game data")
        .set_file_name(format!("live-dump-{}.json", chrono_millis()))
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    let Some(file_path) = file_path.and_then(|p| p.as_path().map(|p| p.to_path_buf())) else {
        return Ok(json!({ "success": false }).to_string());
    };

    if let Err(e) = std::fs::write(&file_path, json_str) {
        return Ok(json!({ "success": false, "error": e.to_string() }).to_string());
    }

    use tauri::Emitter;
    let _ = app.emit(
        "alert:info",
        format!("Live dump saved to {}", file_path.to_string_lossy()),
    );
    Ok(json!({ "success": true, "filePath": file_path.to_string_lossy() }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_roster_is_served_until_it_goes_stale() {
        // The bot's template falls back to this when a cold pregame fetch
        // outruns its budget, instead of rendering every variable as N/A.
        let cache = LiveCache::default();
        let now = Instant::now();
        assert_eq!(cache.recent_snapshot_at(now), None);

        cache.store_snapshot("{\"success\":true}", now);
        assert_eq!(
            cache.recent_snapshot_at(now + Duration::from_secs(30)),
            Some("{\"success\":true}".to_string())
        );
        // Past the TTL it is a different match's roster, so it is withheld.
        assert_eq!(
            cache.recent_snapshot_at(now + SNAPSHOT_FALLBACK_TTL + Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn empty_name_service_answers_do_not_count_as_resolved() {
        // Riot returns an empty GameName for some accounts. Treating that as a
        // resolved name marked the enrichment `complete`, which cached it fresh
        // for ENRICHMENT_TTL and stopped the retry, so a pregame enemy whose
        // name would have arrived on the next poll stayed "Hidden Player".
        let now = Instant::now();
        assert!(!enrichment_is_fresh(now, false, now));
        assert!(enrichment_is_fresh(now, true, now));
        // An incomplete entry keeps its original timestamp, so a run of empty
        // answers can never push the TTL forward.
        let earlier = now - Duration::from_secs(60);
        assert_eq!(
            enrichment_refresh_timestamp(Some(earlier), false, true, now),
            earlier
        );
        assert_eq!(
            enrichment_refresh_timestamp(Some(earlier), true, true, now),
            now
        );
    }

    #[test]
    fn party_membership_flags_premades_and_self_only() {
        let mut players = vec![
            json!({ "puuid": "SELF", "isSelf": true }),
            json!({ "puuid": "duo", "isSelf": false }),
            json!({ "puuid": "stranger", "isSelf": false }),
        ];
        // Riot's party roster, cased differently than the match roster.
        let premade = HashSet::from(["Duo".to_string(), "self".to_string()]);
        apply_party_membership(&mut players, &premade);

        assert_eq!(players[0]["inMyParty"], json!(true));
        assert_eq!(players[1]["inMyParty"], json!(true));
        // A stranger stays masked no matter what the party *inference* said.
        assert_eq!(players[2]["inMyParty"], json!(false));
    }

    #[test]
    fn party_membership_keeps_self_flagged_without_a_party() {
        // Solo queue: no party endpoint members, but you still know your own name.
        let mut players = vec![json!({ "puuid": "SELF", "isSelf": true })];
        apply_party_membership(&mut players, &HashSet::new());
        assert_eq!(players[0]["inMyParty"], json!(true));
    }

    #[test]
    fn party_labels_apply_by_puuid_without_exposing_internal_membership() {
        let mut players = vec![
            json!({ "puuid": "P1", "party": null }),
            json!({ "puuid": "p2", "party": null }),
            json!({ "puuid": "p3", "party": null }),
        ];
        let labels = HashMap::from([
            ("p1".to_string(), "Team 1".to_string()),
            ("p2".to_string(), "Team 1".to_string()),
        ]);

        apply_party_labels(&mut players, &labels);

        assert_eq!(players[0]["party"], "Team 1");
        assert_eq!(players[1]["party"], "Team 1");
        assert!(players[2]["party"].is_null());
        assert!(!serde_json::to_string(&players)
            .unwrap()
            .contains("party-id"));
    }

    #[test]
    fn pregame_loadout_party_ids_do_not_enter_the_loadout_map() {
        let loadouts = json!({
            "Loadouts": [
                { "Subject": "p1", "PartyID": "secret-loadout-party", "Items": {} }
            ]
        });
        let loadout_map = build_loadout_map(&loadouts);
        let serialized = serde_json::to_string(&loadout_map.by_subject).unwrap();

        assert!(loadout_map.by_subject.contains_key("p1"));
        assert!(!serialized.contains("secret-loadout-party"));
    }

    #[test]
    fn public_party_roster_key_hides_the_raw_party_id() {
        let (cache_key, public_key) = live_roster_keys(
            LiveState::Party,
            None,
            Some("secret-riot-party-id"),
            "p1,p2",
            "p1,p2",
        );

        assert!(cache_key.contains("secret-riot-party-id"));
        assert!(!public_key.contains("secret-riot-party-id"));
        assert!(public_key.contains("p1,p2"));
    }

    #[test]
    fn extracts_coregame_match_context() {
        let source = json!({
            "MapID": "/Game/Maps/Ascent/Ascent",
            "ModeID": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C",
            "QueueID": "competitive",
            "GamePodID": "aresriot.aws-ape1-prod.ap-gp-hongkong-1"
        });

        assert_eq!(
            extract_match_context(LiveState::CoreGame, &source, Some("match-1")),
            json!({
                "id": "match-1",
                "mapId": "/Game/Maps/Ascent/Ascent",
                "modeId": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C",
                "queueId": "competitive",
                "server": "aresriot.aws-ape1-prod.ap-gp-hongkong-1",
                "phase": "coregame"
            })
        );
    }

    #[test]
    fn extracts_party_matchmaking_and_custom_game_context() {
        let source = json!({
            "MatchmakingData": { "QueueID": "competitive" },
            "CustomGameData": { "Settings": {
                "Map": "/Game/Maps/Bonsai/Bonsai",
                "Mode": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C"
            }}
        });

        assert_eq!(
            extract_match_context(LiveState::Party, &source, None),
            json!({
                "id": null,
                "mapId": "/Game/Maps/Bonsai/Bonsai",
                "modeId": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C",
                "queueId": "competitive",
                "server": "",
                "phase": "party"
            })
        );
    }

    #[test]
    fn extracts_pregame_mode_field() {
        let source = json!({
            "MapID": "/Game/Maps/Jam/Jam",
            "Mode": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C"
        });

        let context = extract_match_context(LiveState::PreGame, &source, Some("pregame-1"));
        assert_eq!(
            context["modeId"],
            "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C"
        );
        assert_eq!(context["phase"], "pregame");
    }

    #[test]
    fn summarizes_only_rated_players() {
        let players = vec![
            json!({"teamId":"Blue","currentTier":15}),
            json!({"teamId":"Blue","currentTier":0}),
            json!({"teamId":"Blue","currentTier":17}),
        ];

        assert_eq!(
            summarize_teams(&players),
            vec![json!({"id":"Blue", "averageTier":16.0, "ratedPlayers":2})]
        );
    }

    #[test]
    fn selects_recent_matches_for_active_queue() {
        let history = json!({"History": [
            {"MatchID":"c1","QueueID":"competitive"},
            {"MatchID":"u1","QueueID":"unrated"},
            {"MatchID":"u2","QueueID":"UNRATED"},
            {"MatchID":"u3","QueueID":"unrated"},
            {"MatchID":"u4","QueueID":"unrated"},
            {"MatchID":"u5","QueueID":"unrated"},
            {"MatchID":"u6","QueueID":"unrated"},
            {"MatchID":"c3","QueueID":"competitive"},
            {"MatchID":"custom1","QueueID":"custom"},
            {"MatchID":"","QueueID":"unrated"}
        ]});

        assert_eq!(
            select_match_ids_for_queue(&history, "unrated", 5),
            ["u1", "u2", "u3", "u4", "u5"]
        );
        assert_eq!(
            select_match_ids_for_queue(&history, "competitive", 5),
            ["c1", "c3"]
        );
        assert!(select_match_ids_for_queue(&history, "", 5).is_empty());
        assert!(select_match_ids_for_queue(&history, "custom", 5).is_empty());
    }

    #[test]
    fn aggregates_recent_player_stats() {
        let matches = vec![
            json!({
                "players":[{"subject":"p1","teamId":"Blue","stats":{"kills":20,"deaths":10,"assists":5,"score":4000,"roundsPlayed":20}}],
                "teams":[{"teamId":"Blue","won":true}],
                "roundResults":[{"playerStats":[{"subject":"p1","damage":[{"damage":3010}]}]}]
            }),
            json!({
                "players":[{"subject":"p1","teamId":"Red","stats":{"kills":10,"deaths":10,"assists":7,"score":3000,"roundsPlayed":20}}],
                "teams":[{"teamId":"Red","won":false}],
                "roundResults":[{"playerStats":[{"subject":"p1","damage":[{"damage":2000}]}]}]
            }),
        ];

        let result = aggregate_recent_stats("p1", &matches).unwrap();
        assert_eq!(result["matches"], 2);
        assert_eq!(result["kills"], 30);
        assert_eq!(result["deaths"], 20);
        assert_eq!(result["assists"], 12);
        assert_eq!(result["kd"], 1.5);
        assert_eq!(result["winRate"], 50.0);
        assert_eq!(result["acs"], 175.0);
        assert_eq!(result["dpr"], 125.25);
        assert_eq!(result["streak"]["kind"], "win");
        assert_eq!(result["streak"]["matches"], 1);
    }

    #[test]
    fn counts_consecutive_wins_and_rr_from_newest_match() {
        let history = vec![
            json!({"matchId":"m1","startMillis":300,"won":true}),
            json!({"matchId":"m2","startMillis":200,"won":true}),
            json!({"matchId":"m3","startMillis":100,"won":false}),
        ];
        let mut rr = HashMap::new();
        rr.insert("m1".into(), 18);
        rr.insert("m2".into(), 12);
        rr.insert("m3".into(), -16);
        assert_eq!(
            compute_streak(&history, &rr),
            json!({"kind":"win","matches":2,"rr":30})
        );
    }

    #[test]
    fn counts_a_lose_streak_and_negative_rr() {
        let history = vec![
            json!({"matchId":"m1","startMillis":2,"won":false}),
            json!({"matchId":"m2","startMillis":1,"won":false}),
        ];
        let mut rr = HashMap::new();
        rr.insert("m1".into(), -21);
        rr.insert("m2".into(), -14);
        assert_eq!(
            compute_streak(&history, &rr),
            json!({"kind":"lose","matches":2,"rr":-35})
        );
    }

    #[test]
    fn aggregation_skips_documents_without_the_requested_player() {
        let matches = vec![
            json!({"players": [], "teams": []}),
            json!({
                "players":[{"subject":"p1","teamId":"Blue","stats":{"kills":5,"deaths":0,"assists":2,"score":1000,"roundsPlayed":5}}],
                "teams":[{"teamId":"Blue","won":true}]
            }),
        ];

        let result = aggregate_recent_stats("p1", &matches).unwrap();
        assert_eq!(result["matches"], 1);
        assert_eq!(result["kd"], 5.0);
        assert_eq!(result["winRate"], 100.0);
        assert_eq!(result["acs"], 200.0);
    }

    #[test]
    fn recent_stats_pool_has_three_global_permits() {
        let cache = LiveStatsCache::default();
        assert_eq!(cache.permits.available_permits(), 3);
    }

    #[test]
    fn normalizes_recent_match_summary() {
        let details = json!({
            "matchInfo": {
                "matchId": "m1",
                "gameStartMillis": 1234,
                "mapId": "/Game/Maps/Ascent/Ascent"
            },
            "players": [{
                "subject": "p1",
                "teamId": "Blue",
                "characterId": "agent-1",
                "stats": {"kills":20,"deaths":10,"assists":5,"score":4000,"roundsPlayed":20}
            }],
            "teams": [
                {"teamId":"Blue","won":true,"roundsWon":13},
                {"teamId":"Red","won":false,"roundsWon":9}
            ],
            "roundResults":[{"playerStats":[{"subject":"p1","damage":[{"damage":3010}]}]}]
        });

        assert_eq!(
            normalize_recent_match("p1", &details),
            Some(json!({
                "matchId": "m1",
                "startMillis": 1234,
                "mapId": "/Game/Maps/Ascent/Ascent",
                "agentId": "agent-1",
                "won": true,
                "allyRounds": 13,
                "enemyRounds": 9,
                "kills": 20,
                "deaths": 10,
                "assists": 5,
                "acs": 200.0,
                "dpr": 150.5
            }))
        );
        assert_eq!(normalize_recent_match("missing", &details), None);
    }

    #[test]
    fn aggregate_includes_only_normalized_history() {
        let matches = vec![
            json!({
                "matchInfo":{"matchId":"m1","gameStartMillis":1234,"mapId":"map-1"},
                "players":[{"subject":"p1","teamId":"Blue","characterId":"agent-1","stats":{"kills":5,"deaths":2,"assists":1,"score":1000,"roundsPlayed":5}}],
                "teams":[{"teamId":"Blue","won":true,"roundsWon":5},{"teamId":"Red","won":false,"roundsWon":2}]
            }),
            json!({"matchInfo":{"matchId":"m2"},"players":[],"teams":[]}),
        ];

        let result = aggregate_recent_stats("p1", &matches).unwrap();
        assert_eq!(result["matches"], 1);
        assert_eq!(result["history"].as_array().unwrap().len(), 1);
        assert_eq!(result["history"][0]["matchId"], "m1");
    }

    #[test]
    fn caches_recent_stats_only_when_every_selected_match_was_fetched() {
        assert!(should_cache_recent_stats(5, 5, 5));
        assert!(!should_cache_recent_stats(5, 4, 4));
        assert!(!should_cache_recent_stats(5, 5, 4));
        assert!(!should_cache_recent_stats(1, 0, 0));
    }

    #[test]
    fn normalizes_competitive_seasons_and_current_id() {
        let mmr = json!({
            "LatestCompetitiveUpdate": {"SeasonID": "act-current"},
            "QueueSkills": {"competitive": {"SeasonalInfoBySeasonID": {
                "act-current": {
                    "CompetitiveTier": 22,
                    "RankedRating": 61,
                    "NumberOfWins": 12,
                    "NumberOfGames": 20,
                    "WinsByTier": {"22": 8, "21": 4, "bad": 99, "20": -2}
                }
            }}}
        });

        let (current, seasons) = extract_competitive_seasons(Some(&mmr));
        assert_eq!(current.as_deref(), Some("act-current"));
        assert_eq!(seasons.len(), 1);
        assert_eq!(seasons[0]["seasonId"], "act-current");
        assert_eq!(seasons[0]["tier"], 22);
        assert_eq!(seasons[0]["rankedRating"], 61);
        assert_eq!(seasons[0]["wins"], 12);
        assert_eq!(seasons[0]["games"], 20);
        assert_eq!(seasons[0]["winsByTier"], json!({"21": 4, "22": 8}));
    }

    #[test]
    fn competitive_seasons_tolerate_missing_and_negative_values() {
        assert_eq!(extract_competitive_seasons(None), (None, vec![]));

        let mmr = json!({
            "QueueSkills": {"competitive": {"SeasonalInfoBySeasonID": {
                "act-old": {"CompetitiveTier": -1, "NumberOfWins": null}
            }}}
        });
        let (current, seasons) = extract_competitive_seasons(Some(&mmr));
        assert_eq!(current, None);
        assert_eq!(seasons[0]["tier"], 0);
        assert_eq!(seasons[0]["rankedRating"], 0);
        assert_eq!(seasons[0]["wins"], 0);
        assert_eq!(seasons[0]["games"], 0);
        assert_eq!(seasons[0]["winsByTier"], json!({}));
    }

    #[test]
    fn enrichment_cache_freshness_expires_after_ten_minutes() {
        let inserted_at = std::time::Instant::now();
        assert!(enrichment_is_fresh(
            inserted_at,
            true,
            inserted_at + std::time::Duration::from_secs(599)
        ));
        assert!(!enrichment_is_fresh(
            inserted_at,
            true,
            inserted_at + std::time::Duration::from_secs(600)
        ));
    }

    #[test]
    fn partial_first_enrichment_remains_retryable() {
        let inserted_at = Instant::now();
        assert!(!enrichment_is_fresh(
            inserted_at,
            false,
            inserted_at + Duration::from_secs(1)
        ));
    }

    #[test]
    fn failed_enrichment_refresh_preserves_the_previous_timestamp() {
        let previous = Instant::now();
        let now = previous + Duration::from_secs(601);

        assert_eq!(
            enrichment_refresh_timestamp(Some(previous), true, false, now),
            previous
        );
        assert_eq!(
            enrichment_refresh_timestamp(Some(previous), true, true, now),
            now
        );
    }

    #[tokio::test]
    async fn live_pd_errors_are_bounded_public_codes() {
        let cache = LivePartyHistoryCache::default();
        let raw = r#"{"status":500,"path":"/match-history/v1/history/private-puuid"}"#;
        assert_eq!(
            run_live_pd(&cache, async { Err::<(), _>(raw.to_string()) }).await,
            Err(PUBLIC_UNAVAILABLE_ERROR.to_string())
        );
    }

    #[tokio::test]
    async fn live_pd_requests_have_a_bounded_timeout() {
        let cache = LivePartyHistoryCache::default();
        let result = run_live_pd_with_timeout(
            &cache,
            Duration::from_millis(10),
            std::future::pending::<Result<(), String>>(),
        )
        .await;

        assert_eq!(result, Err(PUBLIC_UNAVAILABLE_ERROR.to_string()));
    }
}

fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
