use super::live;
use super::live_party::LivePartyHistoryCache;
use crate::riot::chat_template::{self, format_decimal, format_percent, TemplatePlan};
use crate::riot::client::RiotState;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as AsyncMutex;

/// Budget for resolving one templated message. Agent select runs far longer
/// than this, so a cold pregame roster is worth waiting on — the old 6s cut off
/// a fetch that was still in flight and rendered the message as `N/A`.
const TEMPLATE_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
struct TemplatePlayer {
    puuid: String,
    game_name: String,
    tag_line: String,
    team_id: String,
    character_id: String,
    level: Option<u64>,
    current_tier: u64,
    current_rr: u64,
    is_self: bool,
    incognito: bool,
}

#[derive(Debug, Clone)]
struct TemplateSnapshot {
    state: String,
    map_id: String,
    queue_id: String,
    server: String,
    players: Vec<TemplatePlayer>,
}

fn normalize_server(value: &str) -> String {
    let value = value.trim();
    value.rsplit('.').next().unwrap_or_default().to_string()
}

/// Datacenter cities whose pod segment runs the words together. Anything absent
/// falls back to title-casing the segment, so a pod Riot adds tomorrow reads as
/// "Osaka" rather than going blank.
const POD_CITIES: &[(&str, &str)] = &[
    // APAC
    ("hongkong", "Hong Kong"),
    ("kualalumpur", "Kuala Lumpur"),
    ("hochiminh", "Ho Chi Minh City"),
    ("hochiminhcity", "Ho Chi Minh City"),
    ("newdelhi", "New Delhi"),
    ("hyderabad", "Hyderabad"),
    // EU / MENA
    ("telaviv", "Tel Aviv"),
    ("saintpetersburg", "Saint Petersburg"),
    ("stpetersburg", "Saint Petersburg"),
    // North America
    ("nvirginia", "N. Virginia"),
    ("northvirginia", "N. Virginia"),
    ("ncalifornia", "N. California"),
    ("northcalifornia", "N. California"),
    ("newyork", "New York"),
    ("losangeles", "Los Angeles"),
    ("sanjose", "San Jose"),
    ("saltlakecity", "Salt Lake City"),
    // LATAM / BR
    ("saopaulo", "Sao Paulo"),
    ("mexicocity", "Mexico City"),
    ("buenosaires", "Buenos Aires"),
    ("riodejaneiro", "Rio de Janeiro"),
];

fn title_case(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// Human name for a game pod: `aresriot.aws-ape1-prod.ap-gp-hongkong-1` →
/// `Hong Kong`.
///
/// The pod tail is `<shard>-gp-<city>-<n>`, so the city is everything between
/// the `gp` marker and the trailing pod index. Returns an empty string for a
/// pod that doesn't carry a city, and the caller then leaves `server_name`
/// unset so the template renders `N/A` instead of a half-parsed id.
fn server_display_name(pod: &str) -> String {
    let tail = normalize_server(pod);
    if tail.is_empty() {
        return String::new();
    }
    let parts: Vec<&str> = tail.split('-').filter(|part| !part.is_empty()).collect();
    let start = match parts.iter().position(|part| *part == "gp") {
        Some(index) => index + 1,
        // No `gp` marker: nothing here is reliably a city name.
        None => return String::new(),
    };
    let mut city = &parts[start..];
    // Drop the trailing pod index (`...-hongkong-1`), but only when it is one.
    if city.last().is_some_and(|last| last.chars().all(|c| c.is_ascii_digit())) {
        city = &city[..city.len() - 1];
    }
    if city.is_empty() {
        return String::new();
    }
    let key = city.concat().to_ascii_lowercase();
    if let Some((_, name)) = POD_CITIES.iter().find(|(id, _)| *id == key) {
        return (*name).to_string();
    }
    city.iter()
        .map(|part| title_case(part))
        .collect::<Vec<_>>()
        .join(" ")
}

impl TemplateSnapshot {
    fn from_value(value: &Value) -> Option<Self> {
        if !value
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return None;
        }
        let players = value
            .get("players")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|player| {
                let puuid = player.get("puuid").and_then(Value::as_str)?.trim();
                if puuid.is_empty() {
                    return None;
                }
                Some(TemplatePlayer {
                    puuid: puuid.to_ascii_lowercase(),
                    game_name: player
                        .get("gameName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    tag_line: player
                        .get("tagLine")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    team_id: player
                        .get("teamId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    character_id: player
                        .get("characterId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_ascii_lowercase(),
                    level: player.get("level").and_then(Value::as_u64),
                    current_tier: player
                        .get("currentTier")
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                    current_rr: player
                        .get("currentRR")
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                    is_self: player
                        .get("isSelf")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    incognito: player
                        .get("incognito")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
            })
            .collect();
        Some(Self {
            state: value
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            map_id: value
                .pointer("/match/mapId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            queue_id: value
                .pointer("/match/queueId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            server: normalize_server(
                value
                    .pointer("/match/server")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ),
            players,
        })
    }
}

#[derive(Debug, Default, Clone)]
struct ContentLabels {
    agents: HashMap<String, String>,
    maps: HashMap<String, String>,
}

impl ContentLabels {
    fn from_api(agents: &Value, maps: &Value) -> Self {
        let mut labels = Self::default();
        for agent in agents
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = agent.get("uuid").and_then(Value::as_str) else {
                continue;
            };
            let Some(name) = agent.get("displayName").and_then(Value::as_str) else {
                continue;
            };
            if !id.is_empty() && !name.is_empty() {
                labels
                    .agents
                    .insert(id.to_ascii_lowercase(), name.to_string());
            }
        }
        for map in maps
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(name) = map.get("displayName").and_then(Value::as_str) else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            for key in [
                map.get("uuid").and_then(Value::as_str),
                map.get("mapUrl").and_then(Value::as_str),
                map.get("mapUrl")
                    .and_then(Value::as_str)
                    .and_then(|value| value.split('/').filter(|part| !part.is_empty()).next_back()),
            ]
            .into_iter()
            .flatten()
            .filter(|key| !key.is_empty())
            {
                labels
                    .maps
                    .insert(key.to_ascii_lowercase(), name.to_string());
            }
        }
        labels
    }
}

fn riot_id(player: &TemplatePlayer) -> Option<String> {
    if (player.incognito && !player.is_self) || player.game_name.trim().is_empty() {
        return None;
    }
    if player.tag_line.trim().is_empty() {
        Some(player.game_name.clone())
    } else {
        Some(format!("{}#{}", player.game_name, player.tag_line))
    }
}

fn rank_label(tier: u64) -> &'static str {
    match tier {
        3 => "Iron 1",
        4 => "Iron 2",
        5 => "Iron 3",
        6 => "Bronze 1",
        7 => "Bronze 2",
        8 => "Bronze 3",
        9 => "Silver 1",
        10 => "Silver 2",
        11 => "Silver 3",
        12 => "Gold 1",
        13 => "Gold 2",
        14 => "Gold 3",
        15 => "Platinum 1",
        16 => "Platinum 2",
        17 => "Platinum 3",
        18 => "Diamond 1",
        19 => "Diamond 2",
        20 => "Diamond 3",
        21 => "Ascendant 1",
        22 => "Ascendant 2",
        23 => "Ascendant 3",
        24 => "Immortal 1",
        25 => "Immortal 2",
        26 => "Immortal 3",
        27 => "Radiant",
        _ => "Unrated",
    }
}

fn average_rank(players: &[&TemplatePlayer]) -> Option<String> {
    let tiers: Vec<_> = players
        .iter()
        .map(|player| player.current_tier)
        .filter(|tier| *tier >= 3)
        .collect();
    if tiers.is_empty() {
        return None;
    }
    let average = tiers.iter().sum::<u64>() as f64 / tiers.len() as f64;
    Some(rank_label(average.round() as u64).to_string())
}

fn mode_label(queue_id: &str) -> String {
    match queue_id.to_ascii_lowercase().as_str() {
        "competitive" => "Competitive".into(),
        "unrated" => "Unrated".into(),
        "swiftplay" => "Swiftplay".into(),
        "spikerush" => "Spike Rush".into(),
        "deathmatch" => "Deathmatch".into(),
        "ggteam" => "Team Deathmatch".into(),
        "hurm" => "Escalation".into(),
        "custom" => "Custom".into(),
        _ => queue_id.to_string(),
    }
}

fn phase_label(state: &str) -> Option<&'static str> {
    match state {
        "party" => Some("Party"),
        "pregame" => Some("Agent Select"),
        "coregame" => Some("Live Game"),
        _ => None,
    }
}

fn recent_number(stats: &Value, key: &str) -> f64 {
    stats.get(key).and_then(Value::as_f64).unwrap_or_default()
}

fn one_player_recent_values(prefix: &str, stats: &Value, values: &mut HashMap<String, String>) {
    let matches = recent_number(stats, "matches");
    if matches <= 0.0 {
        return;
    }
    let kills = recent_number(stats, "kills");
    let deaths = recent_number(stats, "deaths");
    let assists = recent_number(stats, "assists");
    values.insert(
        format!("{prefix}_kd"),
        format_decimal(kills / deaths.max(1.0), 2),
    );
    values.insert(
        format!("{prefix}_kda"),
        format!(
            "{}/{}/{}",
            format_decimal(kills / matches, 1),
            format_decimal(deaths / matches, 1),
            format_decimal(assists / matches, 1)
        ),
    );
    values.insert(
        format!("{prefix}_acs"),
        format_decimal(recent_number(stats, "acs"), 0),
    );
    values.insert(
        format!("{prefix}_dpr"),
        format_decimal(recent_number(stats, "dpr"), 0),
    );
    values.insert(
        format!("{prefix}_win_rate"),
        format_percent(recent_number(stats, "winRate")),
    );
}

fn team_recent_values(
    prefix: &str,
    players: &[&TemplatePlayer],
    recent: &HashMap<String, Value>,
    values: &mut HashMap<String, String>,
) {
    let samples: Vec<_> = players
        .iter()
        .filter_map(|player| recent.get(&player.puuid))
        .filter(|stats| recent_number(stats, "matches") > 0.0)
        .collect();
    if samples.is_empty() {
        return;
    }
    let sample_count = samples.len() as f64;
    let total_kills: f64 = samples
        .iter()
        .map(|stats| recent_number(stats, "kills"))
        .sum();
    let total_deaths: f64 = samples
        .iter()
        .map(|stats| recent_number(stats, "deaths"))
        .sum();
    let per_match_average = |key: &str| {
        samples
            .iter()
            .map(|stats| recent_number(stats, key) / recent_number(stats, "matches"))
            .sum::<f64>()
            / sample_count
    };
    let average = |key: &str| {
        samples
            .iter()
            .map(|stats| recent_number(stats, key))
            .sum::<f64>()
            / sample_count
    };
    values.insert(
        format!("{prefix}_kd"),
        format_decimal(total_kills / total_deaths.max(1.0), 2),
    );
    values.insert(
        format!("{prefix}_kda"),
        format!(
            "{}/{}/{}",
            format_decimal(per_match_average("kills"), 1),
            format_decimal(per_match_average("deaths"), 1),
            format_decimal(per_match_average("assists"), 1)
        ),
    );
    values.insert(format!("{prefix}_acs"), format_decimal(average("acs"), 0));
    values.insert(format!("{prefix}_dpr"), format_decimal(average("dpr"), 0));
    values.insert(
        format!("{prefix}_win_rate"),
        format_percent(average("winRate")),
    );
}

fn add_team_values(
    prefix: &str,
    players: &[&TemplatePlayer],
    recent: &HashMap<String, Value>,
    labels: &ContentLabels,
    values: &mut HashMap<String, String>,
) {
    values.insert(format!("{prefix}_count"), players.len().to_string());
    let names: Vec<_> = players
        .iter()
        .filter_map(|player| riot_id(player))
        .collect();
    if !names.is_empty() {
        values.insert(format!("{prefix}_names"), names.join(", "));
    }
    let agents: Vec<_> = players
        .iter()
        .filter_map(|player| labels.agents.get(&player.character_id).cloned())
        .collect();
    if !agents.is_empty() {
        values.insert(format!("{prefix}_agents"), agents.join(", "));
    }
    if let Some(rank) = average_rank(players) {
        values.insert(format!("{prefix}_rank"), rank);
    }
    team_recent_values(prefix, players, recent, values);
}

fn team_sides(snapshot: &TemplateSnapshot) -> (Vec<&TemplatePlayer>, Vec<&TemplatePlayer>) {
    let Some(me) = snapshot.players.iter().find(|player| player.is_self) else {
        return (Vec::new(), Vec::new());
    };
    if me.team_id.is_empty() {
        return (snapshot.players.iter().collect(), Vec::new());
    }
    snapshot
        .players
        .iter()
        .partition(|player| player.team_id == me.team_id)
}

fn values_from_context(
    snapshot: &TemplateSnapshot,
    recent: &HashMap<String, Value>,
    labels: &ContentLabels,
) -> HashMap<String, String> {
    let mut values = HashMap::new();
    values.insert("roster_count".into(), snapshot.players.len().to_string());
    if !snapshot.queue_id.is_empty() {
        values.insert("queue".into(), snapshot.queue_id.clone());
        values.insert("mode".into(), mode_label(&snapshot.queue_id));
    }
    if !snapshot.server.is_empty() {
        values.insert("server".into(), snapshot.server.clone());
        let name = server_display_name(&snapshot.server);
        if !name.is_empty() {
            values.insert("server_name".into(), name);
        }
    }
    if let Some(phase) = phase_label(&snapshot.state) {
        values.insert("phase".into(), phase.into());
    }
    if !snapshot.map_id.is_empty() {
        let map_key = snapshot.map_id.to_ascii_lowercase();
        let fallback = snapshot
            .map_id
            .split('/')
            .filter(|part| !part.is_empty())
            .next_back()
            .unwrap_or(snapshot.map_id.as_str());
        values.insert(
            "map".into(),
            labels
                .maps
                .get(&map_key)
                .cloned()
                .unwrap_or_else(|| fallback.to_string()),
        );
    }

    let (allies, enemies) = team_sides(snapshot);
    add_team_values("ally_team", &allies, recent, labels, &mut values);
    add_team_values("enemy_team", &enemies, recent, labels, &mut values);

    if let Some(me) = snapshot.players.iter().find(|player| player.is_self) {
        if let Some(name) = riot_id(me) {
            values.insert("my_name".into(), name);
        }
        if let Some(agent) = labels.agents.get(&me.character_id) {
            values.insert("my_agent".into(), agent.clone());
        }
        values.insert("my_rank".into(), rank_label(me.current_tier).into());
        values.insert("my_rr".into(), me.current_rr.to_string());
        if let Some(level) = me.level {
            values.insert("my_level".into(), level.to_string());
        }
        if let Some(stats) = recent.get(&me.puuid) {
            one_player_recent_values("my", stats, &mut values);
        }
    }
    values
}

fn is_recent_variable(id: &str) -> bool {
    matches!(
        id,
        "my_kd"
            | "my_kda"
            | "my_acs"
            | "my_dpr"
            | "my_win_rate"
            | "ally_team_kd"
            | "ally_team_kda"
            | "ally_team_acs"
            | "ally_team_dpr"
            | "ally_team_win_rate"
            | "enemy_team_kd"
            | "enemy_team_kda"
            | "enemy_team_acs"
            | "enemy_team_dpr"
            | "enemy_team_win_rate"
    )
}

fn requested_recent_puuids(plan: &TemplatePlan, snapshot: &TemplateSnapshot) -> Vec<String> {
    let wants_my = plan
        .variables
        .iter()
        .any(|id| id.starts_with("my_") && is_recent_variable(id));
    let wants_allies = plan
        .variables
        .iter()
        .any(|id| id.starts_with("ally_team_") && is_recent_variable(id));
    let wants_enemies = plan
        .variables
        .iter()
        .any(|id| id.starts_with("enemy_team_") && is_recent_variable(id));
    let (allies, enemies) = team_sides(snapshot);
    snapshot
        .players
        .iter()
        .filter(|player| {
            (wants_my && player.is_self)
                || (wants_allies && allies.iter().any(|ally| ally.puuid == player.puuid))
                || (wants_enemies && enemies.iter().any(|enemy| enemy.puuid == player.puuid))
        })
        .map(|player| player.puuid.clone())
        .collect()
}

fn content_cache() -> &'static AsyncMutex<Option<ContentLabels>> {
    static CACHE: OnceLock<AsyncMutex<Option<ContentLabels>>> = OnceLock::new();
    CACHE.get_or_init(|| AsyncMutex::new(None))
}

fn public_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

async fn fetch_public_json(url: &'static str) -> Option<Value> {
    public_client()
        .get(url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()
}

async fn load_content_labels(
    plan: &TemplatePlan,
    deadline: tokio::time::Instant,
) -> Option<ContentLabels> {
    if !plan.needs_content {
        return Some(ContentLabels::default());
    }
    let mut cache = tokio::time::timeout_at(deadline, content_cache().lock())
        .await
        .ok()?;
    if let Some(labels) = cache.as_ref() {
        return Some(labels.clone());
    }

    let mut workers = tokio::task::JoinSet::new();
    workers.spawn(async {
        (
            "agents",
            fetch_public_json(
                "https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=en-US",
            )
            .await,
        )
    });
    workers.spawn(async {
        (
            "maps",
            fetch_public_json("https://valorant-api.com/v1/maps?language=en-US").await,
        )
    });
    let mut agents = None;
    let mut maps = None;
    loop {
        match tokio::time::timeout_at(deadline, workers.join_next()).await {
            Ok(Some(Ok(("agents", value)))) => agents = value,
            Ok(Some(Ok(("maps", value)))) => maps = value,
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => break,
        }
    }
    workers.abort_all();
    let complete = agents.is_some() && maps.is_some();
    let labels = ContentLabels::from_api(
        agents.as_ref().unwrap_or(&Value::Null),
        maps.as_ref().unwrap_or(&Value::Null),
    );
    if complete {
        *cache = Some(labels.clone());
    }
    Some(labels)
}

/// Whether the template asks for anything about the other team.
fn wants_enemy_data(plan: &TemplatePlan) -> bool {
    plan.variables
        .iter()
        .any(|variable| variable.starts_with("enemy_team"))
}

/// Whether this roster can actually answer the template.
///
/// Riot publishes a pregame match before it publishes the loadouts that leak
/// the other team, so the first fetch after the transition routinely returns
/// your five and nobody else.
fn snapshot_is_usable(snapshot: &TemplateSnapshot, needs_enemies: bool) -> bool {
    if snapshot.players.is_empty() {
        return false;
    }
    if !needs_enemies {
        return true;
    }
    !team_sides(snapshot).1.is_empty()
}

/// Gap between roster attempts while agent select fills in.
const SNAPSHOT_RETRY_DELAY: Duration = Duration::from_millis(1200);

/// The roster the template renders against.
///
/// The lifecycle trigger fires the moment pregame starts, which is *before*
/// Riot has published the loadouts the enemy side is read from. Rendering that
/// first answer produced the `N/A - N/A | N/A` whisper while the app's own
/// Live Game view filled in seconds later. So this waits: it re-asks until the
/// roster can answer the message, and only falls back to the last stored roster
/// when the budget runs out.
async fn load_snapshot(
    app: &AppHandle,
    deadline: tokio::time::Instant,
    needs_enemies: bool,
) -> Option<TemplateSnapshot> {
    let mut best: Option<TemplateSnapshot> = None;
    loop {
        let fetched = tokio::time::timeout_at(
            deadline,
            live::live_game_fetch(
                app.state::<RiotState>(),
                app.state::<live::LiveCache>(),
                app.state::<LivePartyHistoryCache>(),
            ),
        )
        .await
        .ok()
        .and_then(Result::ok);

        if let Some(snapshot) = fetched
            .as_deref()
            .and_then(|response| serde_json::from_str::<Value>(response).ok())
            .as_ref()
            .and_then(TemplateSnapshot::from_value)
        {
            if snapshot_is_usable(&snapshot, needs_enemies) {
                return Some(snapshot);
            }
            // Half a roster still beats N/A if nothing better arrives.
            if !snapshot.players.is_empty() {
                best = Some(snapshot);
            }
        }

        if tokio::time::Instant::now() + SNAPSHOT_RETRY_DELAY >= deadline {
            break;
        }
        tokio::time::sleep(SNAPSHOT_RETRY_DELAY).await;
    }

    best.or_else(|| {
        let stored = app.state::<live::LiveCache>().recent_snapshot()?;
        let value: Value = serde_json::from_str(&stored).ok()?;
        TemplateSnapshot::from_value(&value)
    })
}

fn render_custom_messages(
    messages: &[String],
    snapshot: &TemplateSnapshot,
    recent: &HashMap<String, Value>,
    labels: &ContentLabels,
) -> Vec<String> {
    let values = values_from_context(snapshot, recent, labels);
    messages
        .iter()
        .map(|message| chat_template::render_template(message, &values))
        .collect()
}

pub(crate) async fn resolve_custom_messages(
    app: &AppHandle,
    messages: &[String],
) -> Result<Vec<String>, String> {
    let plans: Vec<_> = messages
        .iter()
        .map(|message| chat_template::plan_template(message))
        .collect();
    let mut plan = TemplatePlan::default();
    for message_plan in &plans {
        plan.merge(message_plan);
    }
    if plan.variables.is_empty() {
        return Ok(messages.to_vec());
    }
    let deadline = tokio::time::Instant::now() + TEMPLATE_RESOLUTION_TIMEOUT;
    let Some(snapshot) = load_snapshot(app, deadline, wants_enemy_data(&plan)).await else {
        return Ok(messages
            .iter()
            .map(|message| chat_template::render_template(message, &HashMap::new()))
            .collect());
    };
    let puuids = requested_recent_puuids(&plan, &snapshot);
    let recent = if puuids.is_empty() {
        HashMap::new()
    } else {
        live::template_recent_stats(
            app.state::<RiotState>().inner(),
            app.state::<live::LiveStatsCache>().inner(),
            app.state::<LivePartyHistoryCache>().inner(),
            puuids,
            snapshot.queue_id.clone(),
            deadline,
        )
        .await
    };
    let labels = load_content_labels(&plan, deadline)
        .await
        .unwrap_or_default();
    Ok(render_custom_messages(
        messages, &snapshot, &recent, &labels,
    ))
}

pub(crate) async fn resolve_custom_message(app: &AppHandle, message: &str) -> String {
    resolve_custom_messages(app, &[message.to_string()])
        .await
        .ok()
        .and_then(|mut messages| messages.pop())
        .unwrap_or_else(|| chat_template::render_template(message, &HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> TemplateSnapshot {
        TemplateSnapshot::from_value(&json!({
            "success": true,
            "state": "pregame",
            "match": { "mapId": "/Game/Maps/Ascent/Ascent", "queueId": "competitive" },
            "players": [
                { "puuid": "me", "gameName": "Me", "tagLine": "TW", "teamId": "Ally", "characterId": "sage", "level": 184, "currentTier": 18, "currentRR": 62, "isSelf": true, "incognito": false },
                { "puuid": "ally", "gameName": "Duo", "tagLine": "TW", "teamId": "Ally", "characterId": "sova", "level": 90, "currentTier": 17, "currentRR": 20, "isSelf": false, "incognito": false },
                { "puuid": "enemy", "gameName": "Enemy", "tagLine": "NA", "teamId": "Enemy", "characterId": "jett", "level": 120, "currentTier": 15, "currentRR": 40, "isSelf": false, "incognito": false },
                { "puuid": "hidden", "gameName": "Hidden", "tagLine": "EU", "teamId": "Enemy", "characterId": "omen", "level": null, "currentTier": 0, "currentRR": 0, "isSelf": false, "incognito": true }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn resolves_personal_team_and_match_values_from_fixed_context() {
        let snapshot = snapshot();
        let recent = HashMap::from([
            (
                "me".into(),
                json!({ "matches": 5, "kills": 86, "deaths": 73, "assists": 26, "kd": 1.178, "winRate": 60.0, "acs": 226.2, "dpr": 147.4 }),
            ),
            (
                "enemy".into(),
                json!({ "matches": 5, "kills": 82, "deaths": 66, "assists": 24, "kd": 1.242, "winRate": 54.0, "acs": 238.0, "dpr": 151.0 }),
            ),
        ]);
        let labels = ContentLabels {
            agents: HashMap::from([
                ("sage".into(), "Sage".into()),
                ("sova".into(), "Sova".into()),
                ("jett".into(), "Jett".into()),
                ("omen".into(), "Omen".into()),
            ]),
            maps: HashMap::from([("/game/maps/ascent/ascent".into(), "Ascent".into())]),
        };
        let values = values_from_context(&snapshot, &recent, &labels);

        assert_eq!(values["my_name"], "Me#TW");
        assert_eq!(values["my_agent"], "Sage");
        assert_eq!(values["my_rank"], "Diamond 1");
        assert_eq!(values["my_rr"], "62");
        assert_eq!(values["my_level"], "184");
        assert_eq!(values["my_kda"], "17.2/14.6/5.2");
        assert_eq!(values["enemy_team_kd"], "1.24");
        assert_eq!(values["enemy_team_kda"], "16.4/13.2/4.8");
        assert_eq!(values["enemy_team_agents"], "Jett, Omen");
        assert_eq!(values["enemy_team_count"], "2");
        assert_eq!(values["enemy_team_names"], "Enemy#NA");
        assert_eq!(values["map"], "Ascent");
        assert_eq!(values["mode"], "Competitive");
        assert_eq!(values["phase"], "Agent Select");
        assert_eq!(values["roster_count"], "4");
    }

    #[test]
    fn partial_stats_use_successful_players_and_empty_samples_stay_missing() {
        let snapshot = snapshot();
        let recent = HashMap::from([(
            "enemy".into(),
            json!({ "matches": 5, "kills": 75, "deaths": 60, "assists": 20, "kd": 1.25, "winRate": 60.0, "acs": 220.0, "dpr": 145.0 }),
        )]);
        let values = values_from_context(&snapshot, &recent, &ContentLabels::default());

        assert_eq!(values["enemy_team_kd"], "1.25");
        assert!(!values.contains_key("ally_team_kd"));
        assert!(!values.contains_key("my_kd"));
    }

    #[test]
    fn own_incognito_flag_does_not_hide_the_local_riot_id() {
        let mut snapshot = snapshot();
        snapshot
            .players
            .iter_mut()
            .find(|player| player.is_self)
            .unwrap()
            .incognito = true;

        let values = values_from_context(&snapshot, &HashMap::new(), &ContentLabels::default());

        assert_eq!(values["my_name"], "Me#TW");
        assert!(values["ally_team_names"].contains("Me#TW"));
        assert!(!values["enemy_team_names"].contains("Hidden#EU"));
    }

    #[test]
    fn recent_request_planning_fetches_only_the_requested_side() {
        let snapshot = snapshot();
        let plan = crate::riot::chat_template::plan_template("{{enemy_team_kd}} {{map}}");
        assert_eq!(
            requested_recent_puuids(&plan, &snapshot),
            vec!["enemy".to_string(), "hidden".to_string()]
        );
    }

    #[test]
    fn a_pregame_without_the_enemy_side_yet_is_not_usable() {
        // Riot publishes the pregame match before the loadouts the enemy team
        // is read from. Sending on that first answer is what produced
        // "N/A - N/A | N/A" the instant agent select opened.
        let ally_only = TemplateSnapshot::from_value(&json!({
            "success": true,
            "state": "pregame",
            "match": { "queueId": "competitive" },
            "players": [
                { "puuid": "me", "teamId": "Ally", "isSelf": true },
                { "puuid": "mate", "teamId": "Ally", "isSelf": false }
            ]
        }))
        .unwrap();
        assert!(!snapshot_is_usable(&ally_only, true));
        // A message that never mentions the enemy can go out immediately.
        assert!(snapshot_is_usable(&ally_only, false));

        let full = TemplateSnapshot::from_value(&json!({
            "success": true,
            "state": "pregame",
            "match": { "queueId": "competitive" },
            "players": [
                { "puuid": "me", "teamId": "Ally", "isSelf": true },
                { "puuid": "foe", "teamId": "Enemy", "isSelf": false }
            ]
        }))
        .unwrap();
        assert!(snapshot_is_usable(&full, true));

        let empty = TemplateSnapshot::from_value(&json!({
            "success": true, "state": "idle", "match": Value::Null, "players": []
        }))
        .unwrap();
        assert!(!snapshot_is_usable(&empty, false));
    }

    #[test]
    fn only_enemy_variables_make_the_send_wait_for_the_other_team() {
        assert!(wants_enemy_data(&chat_template::plan_template(
            "{{enemy_team_rank}}"
        )));
        assert!(wants_enemy_data(&chat_template::plan_template(
            "{{queue}} {{enemy_team_kd}}"
        )));
        assert!(!wants_enemy_data(&chat_template::plan_template(
            "{{queue}} - {{server_name}} {{my_rank}}"
        )));
    }

    #[test]
    fn template_resolution_budget_outlasts_a_cold_pregame_fetch() {
        // A cold pregame resolves a name and an MMR for ten players. At six
        // seconds that fetch was still in flight when the budget expired, and
        // the message rendered every variable as N/A. Agent select lasts far
        // longer than this, so waiting costs nothing that matters.
        assert_eq!(TEMPLATE_RESOLUTION_TIMEOUT, Duration::from_secs(15));
        assert!(TEMPLATE_RESOLUTION_TIMEOUT < Duration::from_secs(60));
    }

    #[test]
    fn start_and_end_templates_render_from_one_shared_snapshot() {
        let messages = vec![
            "Map: {{map}}".to_string(),
            "Players: {{roster_count}}".to_string(),
        ];
        assert_eq!(
            render_custom_messages(
                &messages,
                &snapshot(),
                &HashMap::new(),
                &ContentLabels::default(),
            ),
            vec!["Map: Ascent", "Players: 4"]
        );
    }

    #[test]
    fn content_labels_index_agent_and_map_api_fields() {
        let labels = ContentLabels::from_api(
            &json!({ "data": [{ "uuid": "SAGE-ID", "displayName": "Sage" }] }),
            &json!({ "data": [{
                "uuid": "ASCENT-ID",
                "mapUrl": "/Game/Maps/Ascent/Ascent",
                "displayName": "Ascent"
            }] }),
        );

        assert_eq!(labels.agents["sage-id"], "Sage");
        assert_eq!(labels.maps["ascent-id"], "Ascent");
        assert_eq!(labels.maps["/game/maps/ascent/ascent"], "Ascent");
        assert_eq!(labels.maps["ascent"], "Ascent");
    }

    #[test]
    fn converts_game_pods_to_region_names() {
        for (pod, expected) in [
            ("aresriot.aws-ape1-prod.ap-gp-hongkong-1", "Hong Kong"),
            ("aresriot.aws-apne1-prod.ap-gp-tokyo-1", "Tokyo"),
            ("aresriot.aws-euc1-prod.eu-gp-frankfurt-1", "Frankfurt"),
            ("aresriot.aws-usw2-prod.na-gp-oregon-1", "Oregon"),
            ("aresriot.aws-saeast1-prod.br-gp-saopaulo-1", "Sao Paulo"),
            // Bare tail, no product/cloud prefix.
            ("ap-gp-singapore-2", "Singapore"),
            // Unknown city still reads as a place rather than going blank.
            ("aresriot.aws-apne1-prod.ap-gp-osaka-1", "Osaka"),
        ] {
            assert_eq!(server_display_name(pod), expected, "pod={pod}");
        }
    }

    #[test]
    fn single_word_pod_cities_need_no_table_entry() {
        // The title-case fallback already covers every one-word datacenter, in
        // every shard, so the table only carries names it would get wrong.
        for (pod, expected) in [
            // APAC
            ("ap-gp-tokyo-1", "Tokyo"),
            ("ap-gp-singapore-2", "Singapore"),
            ("ap-gp-mumbai-1", "Mumbai"),
            ("ap-gp-sydney-1", "Sydney"),
            ("ap-gp-jakarta-1", "Jakarta"),
            ("ap-gp-seoul-1", "Seoul"),
            ("ap-gp-taipei-1", "Taipei"),
            ("ap-gp-osaka-1", "Osaka"),
            // EU
            ("eu-gp-frankfurt-1", "Frankfurt"),
            ("eu-gp-london-1", "London"),
            ("eu-gp-paris-1", "Paris"),
            ("eu-gp-madrid-1", "Madrid"),
            ("eu-gp-stockholm-1", "Stockholm"),
            ("eu-gp-warsaw-1", "Warsaw"),
            ("eu-gp-istanbul-1", "Istanbul"),
            ("eu-gp-milan-1", "Milan"),
            ("eu-gp-bahrain-1", "Bahrain"),
            // North America
            ("na-gp-ashburn-1", "Ashburn"),
            ("na-gp-atlanta-1", "Atlanta"),
            ("na-gp-chicago-1", "Chicago"),
            ("na-gp-dallas-1", "Dallas"),
            ("na-gp-oregon-1", "Oregon"),
            ("na-gp-ohio-1", "Ohio"),
        ] {
            assert_eq!(server_display_name(pod), expected, "pod={pod}");
        }
    }

    #[test]
    fn multi_word_pod_cities_come_from_the_table() {
        // Both spellings Riot could use — run together, or split across pod
        // segments — normalize to the same key.
        for (pod, expected) in [
            ("ap-gp-kualalumpur-1", "Kuala Lumpur"),
            ("ap-gp-kuala-lumpur-1", "Kuala Lumpur"),
            ("ap-gp-hochiminh-1", "Ho Chi Minh City"),
            ("eu-gp-telaviv-1", "Tel Aviv"),
            ("na-gp-nvirginia-1", "N. Virginia"),
            ("na-gp-n-virginia-1", "N. Virginia"),
            ("na-gp-losangeles-1", "Los Angeles"),
            ("na-gp-saltlakecity-1", "Salt Lake City"),
            ("br-gp-saopaulo-1", "Sao Paulo"),
            ("latam-gp-mexicocity-1", "Mexico City"),
            ("latam-gp-buenosaires-1", "Buenos Aires"),
        ] {
            assert_eq!(server_display_name(pod), expected, "pod={pod}");
        }
    }

    #[test]
    fn leaves_unparseable_pods_without_a_name() {
        // No `gp` marker, nothing else in the id is reliably a city, so the
        // template renders N/A rather than a half-parsed pod.
        assert_eq!(server_display_name(""), "");
        assert_eq!(server_display_name("local-pod"), "");
        assert_eq!(server_display_name("aresriot.aws-ape1-prod"), "");
        // A `gp` marker with only an index behind it names nothing.
        assert_eq!(server_display_name("ap-gp-1"), "");
    }

    #[test]
    fn server_name_accompanies_the_raw_pod_id() {
        let values = values_from_context(
            &TemplateSnapshot::from_value(&json!({
                "success": true,
                "state": "ingame",
                "match": { "server": "aresriot.aws-ape1-prod.ap-gp-hongkong-1" },
                "players": []
            }))
            .unwrap(),
            &HashMap::new(),
            &ContentLabels::default(),
        );
        // The raw id stays put: existing templates must not change output.
        assert_eq!(values["server"], "ap-gp-hongkong-1");
        assert_eq!(values["server_name"], "Hong Kong");
    }

    #[test]
    fn normalizes_server_from_match_game_pod() {
        let value = json!({
            "success": true,
            "state": "coregame",
            "match": {
                "server": "aresriot.aws-ape1-prod.ap-gp-hongkong-1"
            },
            "players": []
        });
        let snapshot = TemplateSnapshot::from_value(&value).unwrap();
        let values = values_from_context(&snapshot, &HashMap::new(), &ContentLabels::default());
        assert_eq!(values["server"], "ap-gp-hongkong-1");
    }

    #[test]
    fn preserves_undotted_server_and_omits_missing_server() {
        assert_eq!(normalize_server("local-pod"), "local-pod");
        assert_eq!(normalize_server(""), "");
    }
}
