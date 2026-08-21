//! Pregame roster assembly from legal Riot Client / GLZ sources only.
//!
//! Priority when merging the same Subject:
//! AllyTeam → Teams[] → EnemyTeam → Loadouts → TeamMatchToken/PregameMatchToken → chat.
//! A complete player object is never overwritten by a Subject-only stub.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const PLAYER_ID_KEYS: &[&str] = &[
    "subject",
    "subjects",
    "puuid",
    "puuids",
    "playerid",
    "playerids",
    "player_id",
    "player_ids",
    "players",
    "sub",
];

#[derive(Debug, Clone)]
pub struct PregameRoster {
    pub players: Vec<Value>,
    pub debug: Value,
}

pub fn build_pregame_roster(
    source: &Value,
    loadouts: Option<&Value>,
    chat: Option<&Value>,
    self_puuid: &str,
) -> PregameRoster {
    let match_id = source
        .get("ID")
        .or_else(|| source.get("MatchID"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let ally_team_id = ally_riot_team_id(source, self_puuid);
    let ally_players = collect_ally_players(source, self_puuid);
    let mut ally_ids: HashSet<String> = ally_players
        .iter()
        .filter_map(subject_of)
        .map(|id| id.to_lowercase())
        .collect();

    for team in teams_of(source) {
        let team_id = team.get("TeamID").and_then(Value::as_str).unwrap_or("");
        if !ally_team_id.is_empty() && team_id.eq_ignore_ascii_case(&ally_team_id) {
            for player in players_of_team(team) {
                if let Some(subject) = subject_of(player) {
                    ally_ids.insert(subject.to_lowercase());
                }
            }
        }
    }

    let mut player_map: HashMap<String, Value> = HashMap::new();
    let mut sources: HashMap<String, Vec<String>> = HashMap::new();

    for player in &ally_players {
        upsert(
            &mut player_map,
            &mut sources,
            player,
            "AllyTeam",
            &ally_ids,
        );
    }

    let mut teams_subject_count = HashSet::new();
    for team in teams_of(source) {
        for player in players_of_team(team) {
            if let Some(subject) = subject_of(player) {
                teams_subject_count.insert(subject.to_lowercase());
            }
            upsert(&mut player_map, &mut sources, player, "Teams", &ally_ids);
        }
    }

    let enemy_team = source.get("EnemyTeam");
    let enemy_team_label = match enemy_team {
        None | Some(Value::Null) => "null".to_string(),
        Some(team) => {
            let count = players_of_team(team).count();
            for player in players_of_team(team) {
                upsert(
                    &mut player_map,
                    &mut sources,
                    player,
                    "EnemyTeam",
                    &ally_ids,
                );
            }
            format!("{count} players")
        }
    };

    let (loadout_entries, loadout_unique, loadout_enemy_candidates) =
        merge_loadouts(&mut player_map, &mut sources, loadouts, &ally_ids);

    let (jwt_player_count, jwt_keys, jwt_kind) =
        merge_match_tokens(&mut player_map, &mut sources, source, &match_id, &ally_ids);

    let chat_debug = merge_pregame_chat(
        &mut player_map,
        &mut sources,
        chat,
        &ally_team_id,
        &ally_ids,
    );

    let mut players: Vec<Value> = player_map.into_values().collect();
    players.sort_by(|a, b| {
        is_enemy(a)
            .cmp(&is_enemy(b))
            .then_with(|| account_level(b).cmp(&account_level(a)))
            .then_with(|| subject_of(a).cmp(&subject_of(b)))
    });

    for player in &mut players {
        if let Some(subject) = subject_of(player) {
            if let Some(list) = sources.get(&subject.to_lowercase()) {
                player["_Sources"] = json!(list);
            }
        }
    }

    let ally = players.iter().filter(|p| !is_enemy(p)).count();
    let enemy = players.iter().filter(|p| is_enemy(p)).count();
    let source_rows: Vec<Value> = players
        .iter()
        .filter_map(|player| {
            let puuid = subject_of(player)?;
            let source = player
                .get("_Source")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some(json!({ "puuid": puuid, "source": source }))
        })
        .collect();

    let debug = json!({
        "matchId": if match_id.is_empty() { Value::Null } else { json!(match_id) },
        "allyTeamPlayers": ally_players.len(),
        "teamsCount": teams_of(source).count(),
        "teamsPlayerSubjects": teams_subject_count.len(),
        "enemyTeam": enemy_team_label,
        "loadoutsEntries": loadout_entries,
        "loadoutsUniqueSubjects": loadout_unique,
        "loadoutEnemyCandidates": loadout_enemy_candidates,
        "matchToken": jwt_kind,
        "jwtPlayerCount": jwt_player_count,
        "jwtPayloadKeys": jwt_keys,
        "chat": chat_debug,
        "finalRoster": players.len(),
        "ally": ally,
        "enemy": enemy,
        "sources": source_rows,
    });

    PregameRoster { players, debug }
}

pub fn format_pregame_debug(debug: &Value) -> String {
    let num = |key: &str| debug.get(key).and_then(Value::as_u64).unwrap_or(0);
    let text = |key: &str| {
        debug
            .get(key)
            .and_then(|v| v.as_str().map(str::to_string))
            .or_else(|| debug.get(key).map(|v| v.to_string()))
            .unwrap_or_else(|| "null".into())
    };
    let mut lines = vec![
        "[PREGAME DEBUG]".to_string(),
        String::new(),
        format!("MatchID: {}", text("matchId").trim_matches('"')),
        String::new(),
        format!("AllyTeam players: {}", num("allyTeamPlayers")),
        format!("Teams count: {}", num("teamsCount")),
        format!("Teams player subjects: {}", num("teamsPlayerSubjects")),
        String::new(),
        "EnemyTeam:".to_string(),
        text("enemyTeam").trim_matches('"').to_string(),
        String::new(),
        "Loadouts:".to_string(),
        format!("{} entries", num("loadoutsEntries")),
        format!("{} unique subjects", num("loadoutsUniqueSubjects")),
        String::new(),
        format!("Match token: {}", text("matchToken").trim_matches('"')),
        format!("TeamMatchToken decoded player count: {}", num("jwtPlayerCount")),
        String::new(),
        format!("Final roster:"),
        format!("{} unique players", num("finalRoster")),
        String::new(),
        format!("ALLY: {}", num("ally")),
        format!("ENEMY: {}", num("enemy")),
        String::new(),
    ];
    if let Some(rows) = debug.get("sources").and_then(Value::as_array) {
        for row in rows {
            let puuid = row.get("puuid").and_then(Value::as_str).unwrap_or("?");
            let source = row.get("source").and_then(Value::as_str).unwrap_or("?");
            lines.push(format!("PUUID {puuid} source={source}"));
        }
    }
    lines.join("\n")
}

pub fn log_pregame_debug(debug: &Value) {
    for line in format_pregame_debug(debug).lines() {
        log::info!("{line}");
    }
}

pub fn redact_secrets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                let lower = key.to_ascii_lowercase();
                if lower.contains("token")
                    || lower.contains("password")
                    || lower.contains("authorization")
                    || lower == "lockfile"
                {
                    *child = json!("[redacted]");
                } else {
                    redact_secrets(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_secrets),
        _ => {}
    }
}

fn merge_loadouts(
    player_map: &mut HashMap<String, Value>,
    sources: &mut HashMap<String, Vec<String>>,
    loadouts: Option<&Value>,
    ally_ids: &HashSet<String>,
) -> (usize, usize, usize) {
    let Some(loadouts) = loadouts else {
        return (0, 0, 0);
    };
    let entries = loadouts
        .get("Loadouts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut unique = HashSet::new();
    for entry in &entries {
        if let Some(subject) = loadout_subject(entry) {
            unique.insert(subject.to_lowercase());
            upsert(
                player_map,
                sources,
                &json!({ "Subject": subject }),
                "Loadouts",
                ally_ids,
            );
        }
    }
    let enemy_candidates = unique.difference(ally_ids).count();
    (entries.len(), unique.len(), enemy_candidates)
}

fn merge_match_tokens(
    player_map: &mut HashMap<String, Value>,
    sources: &mut HashMap<String, Vec<String>>,
    source: &Value,
    match_id: &str,
    ally_ids: &HashSet<String>,
) -> (usize, Vec<String>, String) {
    let token = source
        .get("PregameMatchToken")
        .or_else(|| source.get("TeamMatchToken"))
        .and_then(Value::as_str);
    let Some(token) = token else {
        return (0, Vec::new(), "null".into());
    };
    if token.matches('.').count() != 2 {
        return (0, Vec::new(), "present (non-JWT)".into());
    }
    let Some(payload) = decode_jwt_payload(token) else {
        return (0, Vec::new(), "present (JWT, payload unreadable)".into());
    };
    let keys = payload
        .as_object()
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();
    let ids = extract_player_ids_from_jwt(&payload, match_id);
    for id in &ids {
        upsert(
            player_map,
            sources,
            &json!({ "Subject": id }),
            "TeamMatchToken",
            ally_ids,
        );
    }
    (ids.len(), keys, "present (JWT)".into())
}

fn merge_pregame_chat(
    player_map: &mut HashMap<String, Value>,
    sources: &mut HashMap<String, Vec<String>>,
    chat: Option<&Value>,
    ally_team_id: &str,
    ally_ids: &HashSet<String>,
) -> Value {
    let Some(chat) = chat else {
        return json!({ "conversations": 0, "participants": 0, "enemyCidParticipants": 0 });
    };
    let conversations = chat
        .get("conversations")
        .or_else(|| chat.get("Conversations"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let enemy_needle = match ally_team_id {
        "Blue" => "-red@",
        "Red" => "-blue@",
        _ => "",
    };

    let mut participant_ids = HashSet::new();
    let mut enemy_cid_ids = HashSet::new();
    let mut cid_kinds = Vec::new();

    for conv in &conversations {
        let cid = conv
            .get("cid")
            .or_else(|| conv.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let kind = if cid.contains("-blue@") {
            "blue"
        } else if cid.contains("-red@") {
            "red"
        } else if cid.contains("all@") || cid.contains("-all@") {
            "all"
        } else {
            "other"
        };
        cid_kinds.push(kind);
        let ids = conversation_participant_ids(conv);
        for id in &ids {
            participant_ids.insert(id.to_lowercase());
        }
        let is_enemy_cid = !enemy_needle.is_empty() && cid.to_ascii_lowercase().contains(enemy_needle);
        let is_all_cid = kind == "all";
        if is_enemy_cid || is_all_cid {
            for id in ids {
                let lower = id.to_lowercase();
                if !ally_ids.contains(&lower) {
                    enemy_cid_ids.insert(lower.clone());
                    upsert(
                        player_map,
                        sources,
                        &json!({ "Subject": id }),
                        "Chat",
                        ally_ids,
                    );
                }
            }
        }
    }

    json!({
        "conversations": conversations.len(),
        "participants": participant_ids.len(),
        "enemyCidParticipants": enemy_cid_ids.len(),
        "cidKinds": cid_kinds,
    })
}

fn conversation_participant_ids(conv: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    let collect_value = |value: &Value, ids: &mut Vec<String>| {
        if let Some(s) = value.as_str().filter(|s| is_uuid(s)) {
            ids.push(s.to_string());
        } else if let Some(s) = value
            .get("puuid")
            .or_else(|| value.get("PUUID"))
            .or_else(|| value.get("Subject"))
            .or_else(|| value.get("id"))
            .and_then(Value::as_str)
            .filter(|s| is_uuid(s))
        {
            ids.push(s.to_string());
        }
    };
    for key in ["participants", "Participants", "members", "Members"] {
        if let Some(list) = conv.get(key).and_then(Value::as_array) {
            for item in list {
                collect_value(item, &mut ids);
            }
        }
    }
    ids
}

fn upsert(
    player_map: &mut HashMap<String, Value>,
    sources: &mut HashMap<String, Vec<String>>,
    player: &Value,
    source: &str,
    ally_ids: &HashSet<String>,
) {
    let Some(subject) = subject_of(player) else {
        return;
    };
    let key = subject.to_lowercase();
    let side = if ally_ids.contains(&key) {
        "Ally"
    } else {
        "Enemy"
    };
    sources.entry(key.clone()).or_default().push(source.to_string());
    let incoming = normalize_player(player, source, side);
    match player_map.get(&key) {
        None => {
            player_map.insert(key, incoming);
        }
        Some(existing) => {
            if player_richness(&incoming) > player_richness(existing) {
                let first_source = existing
                    .get("_Source")
                    .cloned()
                    .unwrap_or_else(|| json!(source));
                let mut better = incoming;
                better["_Source"] = first_source;
                player_map.insert(key, better);
            }
        }
    }
}

fn normalize_player(player: &Value, source: &str, side: &str) -> Value {
    let mut out = if player.is_object() {
        player.clone()
    } else {
        json!({})
    };
    if subject_of(&out).is_none() {
        return json!({});
    }
    if out.get("CharacterID").is_none() {
        out["CharacterID"] = json!("");
    }
    if out.get("CharacterSelectionState").is_none() {
        out["CharacterSelectionState"] = json!("");
    }
    if out.get("CompetitiveTier").is_none() {
        out["CompetitiveTier"] = json!(0);
    }
    if out.get("PlayerIdentity").is_none() {
        out["PlayerIdentity"] = json!({
            "AccountLevel": 0,
            "Incognito": false,
            "HideAccountLevel": true
        });
    }
    out["TeamID"] = json!(side);
    out["_Side"] = json!(if side == "Enemy" { "ENEMY" } else { "ALLY" });
    out["_Source"] = json!(source);
    out
}

fn player_richness(player: &Value) -> u32 {
    let mut score = 0;
    if player.get("PlayerIdentity").is_some()
        && player
            .pointer("/PlayerIdentity/AccountLevel")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
    {
        score += 2;
    } else if player.get("PlayerIdentity").is_some()
        && player
            .get("_Source")
            .and_then(Value::as_str)
            != Some("Loadouts")
        && player.get("_Source").and_then(Value::as_str) != Some("TeamMatchToken")
        && player.get("_Source").and_then(Value::as_str) != Some("Chat")
    {
        score += 2;
    }
    if player
        .get("CharacterID")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        score += 1;
    }
    if player
        .get("CharacterSelectionState")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        score += 1;
    }
    if player
        .get("CompetitiveTier")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        score += 1;
    }
    score
}

fn collect_ally_players(source: &Value, self_puuid: &str) -> Vec<Value> {
    let from_ally = source
        .pointer("/AllyTeam/Players")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !from_ally.is_empty() {
        return from_ally;
    }
    for team in teams_of(source) {
        let players = team
            .get("Players")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if players
            .iter()
            .any(|player| subject_of(player).is_some_and(|id| id.eq_ignore_ascii_case(self_puuid)))
        {
            return players;
        }
    }
    Vec::new()
}

fn ally_riot_team_id(source: &Value, self_puuid: &str) -> String {
    if let Some(id) = source
        .pointer("/AllyTeam/TeamID")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return id.to_string();
    }
    for team in teams_of(source) {
        let players = team.get("Players").and_then(Value::as_array);
        let contains_self = players.into_iter().flatten().any(|player| {
            subject_of(player).is_some_and(|id| id.eq_ignore_ascii_case(self_puuid))
        });
        if contains_self {
            return team
                .get("TeamID")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
    }
    String::new()
}

fn teams_of(source: &Value) -> impl Iterator<Item = &Value> {
    source
        .get("Teams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn players_of_team(team: &Value) -> impl Iterator<Item = &Value> {
    team.get("Players")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn loadout_subject(entry: &Value) -> Option<String> {
    entry
        .get("Subject")
        .or_else(|| entry.get("Loadout").and_then(|loadout| loadout.get("Subject")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn subject_of(player: &Value) -> Option<String> {
    player
        .get("Subject")
        .or_else(|| player.get("PUUID"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn is_enemy(player: &Value) -> bool {
    player.get("_Side").and_then(Value::as_str) == Some("ENEMY")
        || player.get("TeamID").and_then(Value::as_str) == Some("Enemy")
}

fn account_level(player: &Value) -> u64 {
    player
        .pointer("/PlayerIdentity/AccountLevel")
        .and_then(Value::as_u64)
        .or_else(|| {
            player
                .pointer("/PlayerIdentity/AccountLevel")
                .and_then(Value::as_i64)
                .map(|n| n.max(0) as u64)
        })
        .unwrap_or(0)
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| {
            let mut padded = payload.replace('-', "+").replace('_', "/");
            while padded.len() % 4 != 0 {
                padded.push('=');
            }
            base64::engine::general_purpose::STANDARD.decode(padded)
        })
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn extract_player_ids_from_jwt(payload: &Value, match_id: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    walk_jwt(payload, "", match_id, &mut found, &mut seen);
    found
}

fn walk_jwt(
    value: &Value,
    parent_key: &str,
    match_id: &str,
    found: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                walk_jwt(child, key, match_id, found, seen);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk_jwt(item, parent_key, match_id, found, seen);
            }
        }
        Value::String(s) if is_uuid(s) => {
            if !match_id.is_empty() && s.eq_ignore_ascii_case(match_id) {
                return;
            }
            if PLAYER_ID_KEYS
                .iter()
                .any(|key| key.eq_ignore_ascii_case(parent_key))
                && seen.insert(s.to_lowercase())
            {
                found.push(s.clone());
            }
        }
        _ => {}
    }
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => true,
            _ => c.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_jwt_payload(payload: &Value) -> String {
        let json = serde_json::to_vec(payload).unwrap_or_default();
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
        format!("eyJhbGciOiJub25lIn0.{payload}.sig")
    }

    fn player(subject: &str, level: u64, character: &str) -> Value {
        json!({
            "Subject": subject,
            "CharacterID": character,
            "CharacterSelectionState": if character.is_empty() { "" } else { "locked" },
            "CompetitiveTier": 15,
            "PlayerIdentity": {
                "AccountLevel": level,
                "Incognito": false,
                "HideAccountLevel": false
            }
        })
    }

    const SELF: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
    const A2: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2";
    const A3: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3";
    const A4: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4";
    const A5: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5";
    const E1: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
    const E2: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2";
    const E3: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3";
    const E4: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4";
    const E5: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb5";
    const MATCH: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    fn allies() -> Vec<Value> {
        vec![
            player(SELF, 200, "sage"),
            player(A2, 80, "jett"),
            player(A3, 40, ""),
            player(A4, 10, "omen"),
            player(A5, 5, "sova"),
        ]
    }

    fn enemies() -> Vec<Value> {
        vec![
            player(E1, 150, "reyna"),
            player(E2, 90, ""),
            player(E3, 20, "killjoy"),
            player(E4, 12, "cypher"),
            player(E5, 3, "phoenix"),
        ]
    }

    #[test]
    fn case_a_teams_already_has_ten() {
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Blue", "Players": allies() },
            "Teams": [
                { "TeamID": "Blue", "Players": allies() },
                { "TeamID": "Red", "Players": enemies() }
            ],
            "EnemyTeam": null
        });
        let loadouts = json!({
            "Loadouts": allies().into_iter().chain(enemies()).map(|p| json!({ "Subject": p["Subject"] })).collect::<Vec<_>>()
        });
        let roster = build_pregame_roster(&source, Some(&loadouts), None, SELF);
        assert_eq!(roster.debug["allyTeamPlayers"], 5);
        assert_eq!(roster.debug["teamsCount"], 2);
        assert_eq!(roster.debug["teamsPlayerSubjects"], 10);
        assert_eq!(roster.debug["loadoutsEntries"], 10);
        assert_eq!(roster.debug["finalRoster"], 10);
        assert_eq!(roster.debug["ally"], 5);
        assert_eq!(roster.debug["enemy"], 5);
        assert_eq!(roster.players.len(), 10);
        assert!(!is_enemy(&roster.players[0]));
        assert!(is_enemy(roster.players.last().unwrap()));
    }

    #[test]
    fn case_b_loadouts_supply_the_enemy_five() {
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Blue", "Players": allies() },
            "Teams": [{ "TeamID": "Blue", "Players": allies() }],
            "EnemyTeam": null
        });
        let loadouts = json!({
            "Loadouts": allies().into_iter().chain(enemies()).map(|p| json!({ "Subject": p["Subject"] })).collect::<Vec<_>>()
        });
        let roster = build_pregame_roster(&source, Some(&loadouts), None, SELF);
        assert_eq!(roster.debug["allyTeamPlayers"], 5);
        assert_eq!(roster.debug["teamsPlayerSubjects"], 5);
        assert_eq!(roster.debug["loadoutsEntries"], 10);
        assert_eq!(roster.debug["loadoutsUniqueSubjects"], 10);
        assert_eq!(roster.debug["loadoutEnemyCandidates"], 5);
        assert_eq!(roster.debug["finalRoster"], 10);
        assert_eq!(roster.debug["enemy"], 5);
        let first_enemy = roster.players.iter().find(|p| is_enemy(p)).unwrap();
        assert_eq!(first_enemy["_Source"], "Loadouts");
        assert_eq!(first_enemy["CharacterID"], "");
        assert_eq!(
            first_enemy["PlayerIdentity"]["HideAccountLevel"],
            true
        );
    }

    #[test]
    fn case_c_no_enemy_source_keeps_five() {
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Blue", "Players": allies() },
            "Teams": [{ "TeamID": "Blue", "Players": allies() }],
            "EnemyTeam": null
        });
        let loadouts = json!({
            "Loadouts": allies().iter().map(|p| json!({ "Subject": p["Subject"] })).collect::<Vec<_>>()
        });
        let roster = build_pregame_roster(&source, Some(&loadouts), None, SELF);
        assert_eq!(roster.debug["allyTeamPlayers"], 5);
        assert_eq!(roster.debug["teamsPlayerSubjects"], 5);
        assert_eq!(roster.debug["loadoutsEntries"], 5);
        assert_eq!(roster.debug["loadoutEnemyCandidates"], 0);
        assert_eq!(roster.debug["finalRoster"], 5);
        assert_eq!(roster.debug["ally"], 5);
        assert_eq!(roster.debug["enemy"], 0);
        assert!(roster.players.iter().all(|p| !is_enemy(p)));
    }

    #[test]
    fn loadout_stub_does_not_replace_complete_ally_object() {
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Blue", "Players": [player(SELF, 200, "sage")] },
            "Teams": [],
            "EnemyTeam": null
        });
        let loadouts = json!({ "Loadouts": [{ "Subject": SELF, "Items": {} }] });
        let roster = build_pregame_roster(&source, Some(&loadouts), None, SELF);
        assert_eq!(roster.players[0]["CharacterID"], "sage");
        assert_eq!(roster.players[0]["_Source"], "AllyTeam");
        assert_eq!(roster.players[0]["PlayerIdentity"]["AccountLevel"], 200);
    }

    #[test]
    fn missing_account_level_sorts_as_zero() {
        let mut broken = player(SELF, 0, "sage");
        broken.as_object_mut().unwrap().remove("PlayerIdentity");
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Blue", "Players": [broken, player(A2, 50, "jett")] }
        });
        let roster = build_pregame_roster(&source, None, None, SELF);
        assert_eq!(roster.players.len(), 2);
        assert_eq!(subject_of(&roster.players[0]).unwrap(), A2);
    }

    #[test]
    fn jwt_players_become_enemies_when_absent_from_ally_team() {
        let token = encode_jwt_payload(&json!({
            "match": MATCH,
            "players": [SELF, A2, A3, A4, A5, E1, E2, E3, E4, E5]
        }));
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Red", "Players": allies() },
            "Teams": [{ "TeamID": "Red", "Players": allies() }],
            "EnemyTeam": null,
            "TeamMatchToken": token
        });
        let roster = build_pregame_roster(&source, None, None, SELF);
        assert_eq!(roster.debug["jwtPlayerCount"], 10);
        assert_eq!(roster.debug["finalRoster"], 10);
        assert_eq!(roster.debug["enemy"], 5);
        assert_eq!(roster.debug["matchToken"], "present (JWT)");
        let debug = format_pregame_debug(&roster.debug);
        assert!(debug.contains("TeamMatchToken decoded player count: 10"));
        assert!(!debug.contains(&token));
    }

    #[test]
    fn jwt_does_not_treat_match_id_as_a_player() {
        let token = encode_jwt_payload(&json!({
            "match": MATCH,
            "players": [SELF]
        }));
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Blue", "Players": [player(SELF, 1, "sage")] },
            "TeamMatchToken": token
        });
        let roster = build_pregame_roster(&source, None, None, SELF);
        assert_eq!(roster.debug["jwtPlayerCount"], 1);
        assert_eq!(roster.debug["finalRoster"], 1);
    }

    #[test]
    fn enemy_chat_cid_can_add_subjects() {
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Blue", "Players": allies() },
            "Teams": [{ "TeamID": "Blue", "Players": allies() }]
        });
        let chat = json!({
            "conversations": [{
                "cid": format!("{MATCH}-red@ares-pregame.ap"),
                "participants": [E1, E2]
            }]
        });
        let roster = build_pregame_roster(&source, None, Some(&chat), SELF);
        assert_eq!(roster.debug["enemy"], 2);
        assert_eq!(roster.debug["chat"]["enemyCidParticipants"], 2);
    }

    #[test]
    fn same_team_chat_is_not_labeled_enemy() {
        let source = json!({
            "ID": MATCH,
            "AllyTeam": { "TeamID": "Blue", "Players": allies() }
        });
        let chat = json!({
            "conversations": [{
                "cid": format!("{MATCH}-blue@ares-pregame.ap"),
                "participants": [SELF, A2]
            }]
        });
        let roster = build_pregame_roster(&source, None, Some(&chat), SELF);
        assert_eq!(roster.debug["enemy"], 0);
        assert_eq!(roster.debug["finalRoster"], 5);
    }

    #[test]
    fn redact_secrets_strips_tokens_and_passwords() {
        let mut payload = json!({
            "TeamMatchToken": "header.payload.sig",
            "nested": { "password": "secret", "ok": 1 }
        });
        redact_secrets(&mut payload);
        assert_eq!(payload["TeamMatchToken"], "[redacted]");
        assert_eq!(payload["nested"]["password"], "[redacted]");
        assert_eq!(payload["nested"]["ok"], 1);
    }
}
