use crate::riot::api::{self, RiotApiClient};
use crate::riot::client::{self, RiotState};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
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

/// The renderer polls every ~5s. We only re-enrich (names/MMR/loadouts) when
/// the underlying roster actually changes; otherwise we replay the last payload.
#[derive(Default)]
pub struct LiveCache {
    state_key: Mutex<Option<String>>,
    payload: Mutex<Option<String>>,
    refresh: AsyncMutex<()>,
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

fn select_competitive_match_ids(history: &Value, limit: usize) -> Vec<String> {
    history
        .get("History")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry
                .get("QueueID")
                .and_then(Value::as_str)
                .is_some_and(|queue| queue.eq_ignore_ascii_case("competitive"))
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
    }))
}

fn aggregate_recent_stats(puuid: &str, matches: &[Value]) -> Result<Value, String> {
    let mut analyzed = 0u64;
    let mut wins = 0u64;
    let mut kills = 0u64;
    let mut deaths = 0u64;
    let mut assists = 0u64;
    let mut score = 0u64;
    let mut rounds = 0u64;
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
        "history": history,
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

fn extract_competitive_seasons(mmr: Option<&Value>) -> (Option<String>, Vec<Value>) {
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

fn extract_rank(mmr: Option<&Value>) -> (i64, i64, i64, Option<String>) {
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

/// Riot strips *other* players' PartyID from live coregame/pregame to deter
/// stream-sniping, so parties are reconstructed from presence data (self +
/// friends) and the local player's own party roster (covers non-friend
/// party-mates with no visible presence). Strangers with neither signal stay solo.
fn assign_parties(
    players: &mut [Value],
    presence_map: &HashMap<String, String>,
    premade: &HashSet<String>,
    own_party_id: Option<&str>,
) {
    let party_id_for = |puuid: &str| -> String {
        let id = presence_map.get(puuid).cloned().or_else(|| {
            if premade.contains(puuid) {
                own_party_id.map(|s| s.to_string())
            } else {
                None
            }
        });
        id.filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("solo-{puuid}"))
    };

    let mut groups: HashMap<String, usize> = HashMap::new();
    let mut party_ids = Vec::with_capacity(players.len());
    for p in players.iter() {
        let puuid = p.get("puuid").and_then(|v| v.as_str()).unwrap_or_default();
        let party_id = party_id_for(puuid);
        *groups.entry(party_id.clone()).or_insert(0) += 1;
        party_ids.push(party_id);
    }

    let mut mapping: HashMap<String, String> = HashMap::new();
    let mut team_number = 1;
    // Stable order for team numbering: first-seen order of party ids.
    let mut seen = HashSet::new();
    for party_id in &party_ids {
        if seen.insert(party_id.clone()) && !party_id.starts_with("solo-") && groups[party_id] > 1 {
            mapping.insert(party_id.clone(), format!("Team {team_number}"));
            team_number += 1;
        }
    }

    for (player, party_id) in players.iter_mut().zip(party_ids.iter()) {
        player["party"] = mapping
            .get(party_id)
            .cloned()
            .map(Value::String)
            .unwrap_or(Value::Null);
    }
}

async fn enrich_players(
    api: &RiotApiClient,
    raw_players: &[Value],
    loadout_map: Option<&LoadoutMap>,
    premade: &HashSet<String>,
    presence_map: &HashMap<String, String>,
    own_party_id: Option<&str>,
) -> Vec<Value> {
    let puuids: Vec<String> = raw_players
        .iter()
        .map(raw_puuid)
        .filter(|s| !s.is_empty())
        .collect();

    let names_res = api.get_names(&puuids).await.unwrap_or(Value::Array(vec![]));
    let mut mmr_map = HashMap::new();
    for puuid in &puuids {
        if let Ok(mmr) = api.get_mmr(puuid).await {
            mmr_map.insert(puuid.clone(), mmr);
        }
    }

    let mut name_map: HashMap<String, (String, String)> = HashMap::new();
    for n in names_res.as_array().into_iter().flatten() {
        if let Some(subject) = n.get("Subject").and_then(|v| v.as_str()) {
            name_map.insert(
                subject.to_string(),
                (
                    n.get("GameName")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    n.get("TagLine")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                ),
            );
        }
    }

    let mut players: Vec<Value> = raw_players
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let puuid = raw_puuid(raw);
            let mmr = mmr_map.get(&puuid);
            let (current_tier, current_rr, peak_tier, peak_season_id) = extract_rank(mmr);
            let (current_season_id, competitive_seasons) = extract_competitive_seasons(mmr);
            let (game_name, tag_line) = name_map.get(&puuid).cloned().unwrap_or_default();
            let identity = raw.get("PlayerIdentity").cloned().unwrap_or(json!({}));

            let loadout = loadout_map.and_then(|lm| lm.by_subject.get(&puuid).cloned().or_else(|| lm.by_index.get(index).cloned()));

            let hide_level = identity.get("HideAccountLevel").and_then(|v| v.as_bool()).unwrap_or(false);

            json!({
                "puuid": puuid,
                "gameName": game_name,
                "tagLine": tag_line,
                "teamId": raw.get("TeamID"),
                "characterId": raw.get("CharacterID"),
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
                "loadout": loadout,
            })
        })
        .collect();

    assign_parties(&mut players, presence_map, premade, own_party_id);
    players
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
            *cache.state_key.lock().unwrap() = Some("idle".to_string());
            *cache.payload.lock().unwrap() = Some(payload.clone());
            return Ok(payload);
        }

        let match_data = detected.match_data.clone().unwrap_or(Value::Null);
        let raw_players = normalize_raw_players(detected.state, &match_data);

        let mut roster: Vec<String> = raw_players
            .iter()
            .map(raw_puuid)
            .filter(|s| !s.is_empty())
            .collect();
        roster.sort();
        let roster_key = roster.join(",");
        let state_key = format!(
            "{}:{}:{}",
            detected.state.as_str(),
            detected
                .match_id
                .as_deref()
                .or(detected.party_id.as_deref())
                .unwrap_or(""),
            roster_key
        );

        {
            let cached_key = cache.state_key.lock().unwrap();
            let cached_payload = cache.payload.lock().unwrap();
            if cached_key.as_deref() == Some(state_key.as_str()) {
                if let Some(payload) = cached_payload.as_ref() {
                    return Ok(payload.clone());
                }
            }
        }

        let loadout_map = detected.loadouts.as_ref().map(build_loadout_map);
        let presence_map = build_presence_party_map(&riot).await;
        let premade_set: HashSet<String> = detected.premade.into_iter().collect();
        let players = enrich_players(
            &api,
            &raw_players,
            loadout_map.as_ref(),
            &premade_set,
            &presence_map,
            detected.party_id.as_deref(),
        )
        .await;

        let match_context =
            extract_match_context(detected.state, &match_data, detected.match_id.as_deref());
        let teams = summarize_teams(&players);
        let payload = json!({
            "success": true,
            "state": detected.state.as_str(),
            "rosterKey": state_key.clone(),
            "match": match_context,
            "teams": teams,
            "players": players
        })
        .to_string();
        *cache.state_key.lock().unwrap() = Some(state_key);
        *cache.payload.lock().unwrap() = Some(payload.clone());
        Ok::<String, String>(payload)
    }
    .await;

    Ok(result.unwrap_or_else(|e| json!({ "success": false, "error": e }).to_string()))
}

async fn fetch_recent_stats(
    api: RiotApiClient,
    puuid: String,
    cache: Arc<Mutex<HashMap<String, Value>>>,
    permits: Arc<Semaphore>,
) -> (String, Result<Value, String>) {
    let result = async {
        let _permit = permits
            .acquire_owned()
            .await
            .map_err(|_| "Recent-stat worker pool is unavailable.".to_string())?;
        let history = api.get_match_history(&puuid, 0, 20).await?;
        let match_ids = select_competitive_match_ids(&history, 5);
        if match_ids.is_empty() {
            return Err("No recent competitive matches were found for this player.".into());
        }

        let cache_key = format!("{}:{}", puuid.to_lowercase(), match_ids.join(","));
        if let Some(cached) = cache.lock().unwrap().get(&cache_key).cloned() {
            return Ok(cached);
        }

        let expected_matches = match_ids.len();
        let mut matches = Vec::with_capacity(expected_matches);
        for match_id in match_ids {
            if let Ok(details) = api.get_match_details(&match_id).await {
                matches.push(details);
            }
        }
        let stats = aggregate_recent_stats(&puuid, &matches)?;
        let normalized_matches = stats["matches"].as_u64().unwrap_or_default() as usize;
        if should_cache_recent_stats(expected_matches, matches.len(), normalized_matches) {
            cache.lock().unwrap().insert(cache_key, stats.clone());
        }
        Ok(stats)
    }
    .await;
    (puuid, result)
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
) -> Result<String, ()> {
    use tauri::Emitter;

    let roster_key = args
        .first()
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let attempt_id = args.get(2).and_then(Value::as_u64).unwrap_or_default();
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
        Err(error) => {
            return Ok(json!({
                "success": false,
                "rosterKey": roster_key,
                "attemptId": attempt_id,
                "error": error,
            })
            .to_string())
        }
    };
    let requested = players.len();
    let mut pending = players.into_iter();
    let mut workers = tokio::task::JoinSet::new();
    let shared_cache = cache.values.clone();
    let shared_permits = cache.permits.clone();

    for _ in 0..3 {
        let Some(puuid) = pending.next() else { break };
        workers.spawn(fetch_recent_stats(
            api.clone(),
            puuid,
            shared_cache.clone(),
            shared_permits.clone(),
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
                shared_cache.clone(),
                shared_permits.clone(),
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

    let json_str = serde_json::to_string_pretty(&Value::Object(out)).unwrap_or_default();
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
    fn extracts_coregame_match_context() {
        let source = json!({
            "MapID": "/Game/Maps/Ascent/Ascent",
            "ModeID": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C",
            "QueueID": "competitive"
        });

        assert_eq!(
            extract_match_context(LiveState::CoreGame, &source, Some("match-1")),
            json!({
                "id": "match-1",
                "mapId": "/Game/Maps/Ascent/Ascent",
                "modeId": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C",
                "queueId": "competitive",
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
    fn selects_five_newest_competitive_matches() {
        let history = json!({"History": [
            {"MatchID":"c1","QueueID":"competitive"},
            {"MatchID":"u1","QueueID":"unrated"},
            {"MatchID":"c2","QueueID":"competitive"},
            {"MatchID":"c3","QueueID":"competitive"},
            {"MatchID":"c4","QueueID":"competitive"},
            {"MatchID":"c5","QueueID":"competitive"},
            {"MatchID":"c6","QueueID":"competitive"}
        ]});

        assert_eq!(
            select_competitive_match_ids(&history, 5),
            ["c1", "c2", "c3", "c4", "c5"]
        );
    }

    #[test]
    fn aggregates_recent_player_stats() {
        let matches = vec![
            json!({
                "players":[{"subject":"p1","teamId":"Blue","stats":{"kills":20,"deaths":10,"assists":5,"score":4000,"roundsPlayed":20}}],
                "teams":[{"teamId":"Blue","won":true}]
            }),
            json!({
                "players":[{"subject":"p1","teamId":"Red","stats":{"kills":10,"deaths":10,"assists":7,"score":3000,"roundsPlayed":20}}],
                "teams":[{"teamId":"Red","won":false}]
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
            ]
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
                "acs": 200.0
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
}

fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
