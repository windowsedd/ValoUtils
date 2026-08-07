//! Ability-cast extraction ported from `sidecar/replay/abilities.ts`.
//!
//! [`build_abilities`] fetches agent metadata from the public
//! `valorant-api.com` agents endpoint, reads `positions.json` (written by
//! [`crate::replay::extract::extract_records`]) and `channels.jsonl` (actor-channel
//! `"open"` events), classifies each ability-object channel open against the
//! hardcoded `ABILITY_CLASSES` table, and writes `abilities.json`.
//!
//! # Judgment calls vs. the TS source
//!
//! - TS's `AgentEntry` also computes `sigColor` (from `backgroundGradientColors`
//!   luma) and stores the agent's own `displayIcon`. Neither field is ever
//!   read anywhere else in `abilities.ts` — only `agent.displayName` and
//!   `agent.abilitiesBySlot` end up in `abilities.json`'s output objects —
//!   so this port omits computing them entirely rather than carrying dead
//!   fields.
//! - `parseClass`'s regex `^(?:GameObject|Projectile|Ability|Patch|FXC)_(\w+?)_`
//!   is reproduced by hand (no `regex` crate dependency): the lazy `(\w+?)_`
//!   group is exactly "grow a candidate substring one character at a time,
//!   starting at length 1, until the very next character is `_`" — which is
//!   what the loop in `parse_class` below does. This is *not* simply "split
//!   on the first `_`": if the class name has consecutive underscores right
//!   after the prefix (e.g. `GameObject__Foo_Bar`), the regex — and this
//!   port — captures `_Foo` (leading underscore included), not `Foo`. No
//!   real Valorant class name observed in the fixtures hits this edge case;
//!   it's handled anyway since the hand-rolled loop costs nothing extra.
//! - `o.t`/`o.x`/`o.y` are round-tripped as raw `serde_json::Value`s from the
//!   input line straight into the output object (rather than re-parsed to
//!   `f64` and re-serialized) specifically to avoid any floating-point
//!   text-formatting drift between this port and the TS source's numbers.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct AgentAbilityApi {
    slot: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "displayIcon")]
    display_icon: Option<String>,
}

#[derive(Deserialize)]
struct AgentDataApi {
    #[serde(rename = "developerName")]
    developer_name: Option<String>,
    #[serde(rename = "displayName")]
    display_name: String,
    abilities: Option<Vec<AgentAbilityApi>>,
}

#[derive(Deserialize)]
struct AgentsResponse {
    data: Vec<AgentDataApi>,
}

struct AbilitySlotInfo {
    display_name: String,
    icon: String,
}

struct AgentEntry {
    display_name: String,
    abilities_by_slot: HashMap<String, AbilitySlotInfo>,
}

/// `(keywords, slotOrder, type, life, radius, outerRadius)` — TS `ABILITY_CLASSES`.
type AbilityClass = (&'static [&'static str], &'static [&'static str], &'static str, i32, i32, Option<i32>);

const ABILITY_CLASSES: &[AbilityClass] = &[
    (&["FlameWall_ThroughWall"], &["Grenade"], "wall-cast", 3, 80, None),
    (
        &["Phoenix_E_FlareCurve_Synced_Right", "FlareCurve_Synced_Right"],
        &["Ability2"],
        "flash-proj-right",
        2,
        400,
        None,
    ),
    (&["Phoenix_E_FlareCurve", "FlareCurve"], &["Ability2"], "flash-proj-left", 2, 400, None),
    (&["Projectile_Phoenix_4_Molotov"], &["Ability1"], "grenade", 3, 100, None),
    (&["Patch_Phoenix_MolotovFire", "MolotovFire"], &["Ability1"], "molly", 6, 280, None),
    (&["Smoke", "NewSmoke", "DarkCover", "Ruse"], &["Ability2", "Grenade"], "smoke", 19, 600, Some(750)),
    (&["Wall_Fortifying"], &["Grenade", "Ability2"], "wall", 30, 100, None),
    (&["Wall_Segment"], &["Grenade", "Ability2"], "wall-seg", 30, 75, None),
    (&["SlowField", "Slow"], &["Ability1"], "slow", 7, 270, None),
    (&["Molly", "Burn", "Incendiary"], &["Ability1", "Grenade"], "molly", 7, 320, None),
    (&["Satchel_Arming", "Satchel_Production"], &["Ability1"], "satchel", 5, 50, None),
    (&["Satchel_Explosion", "Q_Explosion"], &["Ability1"], "satchel-boom", 1, 350, Some(700)),
    (
        &["BoomBot", "Projectile_Secondary", "PaintShells"],
        &["Ability2", "Grenade"],
        "grenade",
        3,
        350,
        Some(700),
    ),
    (
        &["Trailblazer", "PossessableScout", "ScoutAbilities"],
        &["Ability1", "Grenade"],
        "drone",
        10,
        50,
        None,
    ),
    (&["Drone", "OwlDrone"], &["Grenade"], "drone", 10, 50, None),
    (&["HawkFlash_FlashSource", "FlashSource"], &["Ability2", "Ability1"], "flash-src", 3, 1500, None),
    (
        &["HawkFlash_C", "Projectile_Guide_E_HawkFlash"],
        &["Ability2", "Ability1"],
        "flash-proj",
        2,
        100,
        None,
    ),
    (&["GuidingLight"], &["Ability2"], "flash-src", 3, 1500, None),
    (&["Flash"], &["Ability2", "Ability1"], "flash", 2, 600, None),
    (&["LoSReveal", "Reveal", "Haunt", "Spycam"], &["Ability2"], "reveal", 5, 600, None),
    (&["NearsightAOE", "Leer"], &["Grenade"], "leer", 4, 200, None),
    (&["CyberCage"], &["Ability1"], "smoke", 12, 250, None),
    (&["Phoenix_Q_FireballWall", "FireballWall", "FlameWall"], &["Grenade"], "wall", 8, 80, None),
    (&["Phoenix_X_SelfRes", "SelfRes", "ResTarget"], &["Ultimate"], "postdeath", 3, 100, None),
    (&["Heal_HealPool", "HealPool"], &["Ability1"], "heal-pool", 6, 150, None),
    (
        &["PostDeath_PC", "PostDeath_ReactiveResStart", "ReactiveResStart"],
        &["Grenade", "Ultimate"],
        "postdeath",
        3,
        100,
        None,
    ),
];

struct Classified {
    type_: &'static str,
    life: i32,
    radius: i32,
    outer_radius: Option<i32>,
    ability: String,
    icon: String,
}

fn classify_ability(cls: &str, agent: &AgentEntry) -> Option<Classified> {
    for (keywords, slot_order, type_, life, radius, outer_radius) in ABILITY_CLASSES {
        if !keywords.iter().any(|k| cls.contains(k)) {
            continue;
        }
        let mut info: Option<&AbilitySlotInfo> = None;
        for s in *slot_order {
            if let Some(v) = agent.abilities_by_slot.get(*s) {
                info = Some(v);
                break;
            }
        }
        return Some(Classified {
            type_,
            life: *life,
            radius: *radius,
            outer_radius: *outer_radius,
            ability: info.map(|i| i.display_name.clone()).unwrap_or_else(|| type_.to_string()),
            icon: info.map(|i| i.icon.clone()).unwrap_or_default(),
        });
    }
    None
}

const CLASS_PREFIXES: &[&str] = &["GameObject_", "Projectile_", "Ability_", "Patch_", "FXC_"];

/// TS: `cls.match(/^(?:GameObject|Projectile|Ability|Patch|FXC)_(\w+?)_/)`.
/// See module doc comment for how the lazy group is reproduced exactly.
fn parse_class<'a>(cls: &str, agent_by_dev: &'a HashMap<String, AgentEntry>) -> Option<(String, &'a AgentEntry)> {
    let rest = CLASS_PREFIXES.iter().find_map(|p| cls.strip_prefix(p))?;
    let bytes = rest.as_bytes();
    let end = bytes.iter().enumerate().skip(1).find(|(_, &b)| b == b'_').map(|(i, _)| i)?;
    let dev_name = rest[..end].to_lowercase();
    let agent = agent_by_dev.get(&dev_name)?;
    Some((dev_name, agent))
}

#[derive(Deserialize)]
struct MetaSub {
    #[serde(rename = "uniqueGuids")]
    unique_guids: Vec<String>,
}

#[derive(Deserialize, Clone, Copy)]
struct BombStateEntry {
    t: f64,
    #[serde(rename = "sampleIdx")]
    sample_idx: usize,
}

#[derive(Deserialize)]
struct PositionsData {
    meta: MetaSub,
    samples: Vec<(f64, String, f64, f64, f64)>,
    #[serde(rename = "bombStates", default)]
    bomb_states: Vec<BombStateEntry>,
}

/// Port of TS `buildAbilities(channelsPath, positionsPath, abilitiesPath)`.
/// Performs a blocking network call to `valorant-api.com` — the same public,
/// unauthenticated endpoint the TS sidecar hits.
pub fn build_abilities(channels_path: &Path, positions_path: &Path, abilities_path: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::new();
    let resp: AgentsResponse = client
        .get("https://valorant-api.com/v1/agents?isPlayableCharacter=true")
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    let mut agent_by_dev: HashMap<String, AgentEntry> = HashMap::new();
    for a in resp.data {
        let dev = a.developer_name.unwrap_or_default().to_lowercase();
        if dev.is_empty() {
            continue;
        }
        let mut entry = AgentEntry {
            display_name: a.display_name,
            abilities_by_slot: HashMap::new(),
        };
        for ab in a.abilities.unwrap_or_default() {
            if let Some(icon) = ab.display_icon {
                if !icon.is_empty() {
                    entry.abilities_by_slot.insert(
                        ab.slot,
                        AbilitySlotInfo {
                            display_name: ab.display_name,
                            icon,
                        },
                    );
                }
            }
        }
        agent_by_dev.insert(dev, entry);
    }

    let raw = fs::read_to_string(positions_path).map_err(|e| e.to_string())?;
    let pos_data: PositionsData = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let n = pos_data.samples.len();
    let bomb_states = &pos_data.bomb_states;

    let mut clock_by_sample = vec![0f64; n];
    {
        let mut bsi = 0usize;
        for (s, slot) in clock_by_sample.iter_mut().enumerate() {
            while bsi < bomb_states.len() && bomb_states[bsi].sample_idx <= s {
                bsi += 1;
            }
            let prev = if bsi > 0 { Some(bomb_states[bsi - 1]) } else { None };
            let next = if bsi < bomb_states.len() { Some(bomb_states[bsi]) } else { None };
            *slot = match (prev, next) {
                (Some(p), Some(nx)) => {
                    let span = nx.sample_idx as i64 - p.sample_idx as i64;
                    let a = if span > 0 {
                        (s as i64 - p.sample_idx as i64) as f64 / span as f64
                    } else {
                        0.0
                    };
                    p.t + (nx.t - p.t) * a
                }
                (Some(p), None) => p.t,
                (None, Some(nx)) => nx.t,
                (None, None) => 0.0,
            };
        }
    }

    let guid_idx: HashMap<&str, usize> = pos_data
        .meta
        .unique_guids
        .iter()
        .enumerate()
        .map(|(i, g)| (g.as_str(), i))
        .collect();
    let num_actors = pos_data.meta.unique_guids.len();
    let mut sample_count_by_guid = vec![0u32; num_actors];
    for s in &pos_data.samples {
        if let Some(&ai) = guid_idx.get(s.1.as_str()) {
            sample_count_by_guid[ai] += 1;
        }
    }

    let mut actor_stream: Vec<Vec<u32>> = (0..num_actors)
        .map(|ai| Vec::with_capacity(sample_count_by_guid[ai] as usize))
        .collect();
    let mut actor_x: Vec<Vec<f64>> = (0..num_actors)
        .map(|ai| Vec::with_capacity(sample_count_by_guid[ai] as usize))
        .collect();
    let mut actor_y: Vec<Vec<f64>> = (0..num_actors)
        .map(|ai| Vec::with_capacity(sample_count_by_guid[ai] as usize))
        .collect();
    for (s, sample) in pos_data.samples.iter().enumerate() {
        if let Some(&ai) = guid_idx.get(sample.1.as_str()) {
            actor_stream[ai].push(s as u32);
            actor_x[ai].push(sample.2);
            actor_y[ai].push(sample.3);
        }
    }

    let mut player_idxs: Vec<usize> = (0..num_actors).collect();
    player_idxs.sort_by(|&a, &b| sample_count_by_guid[b].cmp(&sample_count_by_guid[a]));
    player_idxs.truncate(10);

    let mut spawn: Vec<(usize, f64)> = player_idxs
        .iter()
        .map(|&ai| (ai, *actor_y[ai].first().unwrap_or(&0.0)))
        .collect();
    spawn.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut team_of_actor = vec![-1i8; num_actors];
    for (i, (ai, _)) in spawn.iter().enumerate() {
        if i < 5 {
            team_of_actor[*ai] = 0;
        } else if i < 10 {
            team_of_actor[*ai] = 1;
        }
    }

    let actor_pos_at = |ai: usize, s_idx: i64| -> Option<(f64, f64)> {
        let arr = &actor_stream[ai];
        if arr.is_empty() || s_idx < arr[0] as i64 {
            return None;
        }
        let last = arr.len() - 1;
        if s_idx >= arr[last] as i64 {
            return Some((actor_x[ai][last], actor_y[ai][last]));
        }
        let mut lo = 0usize;
        let mut hi = last;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if (arr[mid] as i64) < s_idx {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let idx = lo.saturating_sub(1);
        Some((actor_x[ai][idx], actor_y[ai][idx]))
    };

    let stream_idx_for_bomb_sec = |t: f64| -> usize {
        if n == 0 {
            return 0;
        }
        let mut lo = 0usize;
        let mut hi = n - 1;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if clock_by_sample[mid] < t {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    };

    let nearest_player_actor = |x: f64, y: f64, t: f64| -> i64 {
        let s_idx = stream_idx_for_bomb_sec(t) as i64;
        let mut best: i64 = -1;
        let mut best_d = f64::INFINITY;
        for &ai in &player_idxs {
            if let Some((px, py)) = actor_pos_at(ai, s_idx) {
                let d = (px - x).powi(2) + (py - y).powi(2);
                if d < best_d {
                    best_d = d;
                    best = ai as i64;
                }
            }
        }
        best
    };

    let mut out: Vec<Value> = Vec::new();
    let mut skipped = 0u32;
    let mut unknown_agent = 0u32;
    let mut unknown_cls = 0u32;
    let content = fs::read_to_string(channels_path).map_err(|e| e.to_string())?;
    for raw_line in content.split('\n') {
        let line = raw_line.trim_end_matches('\r');
        if !line.starts_with("{\"ev\":\"open\"") {
            continue;
        }
        let obj: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = obj.get("t").and_then(Value::as_f64).unwrap_or(0.0);
        let x = obj.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = obj.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        let Some(cls) = obj.get("cls").and_then(Value::as_str) else {
            continue;
        };
        if t == 0.0 {
            skipped += 1;
            continue;
        }
        if x == 0.0 && y == 0.0 {
            skipped += 1;
            continue;
        }
        let Some((_dev_name, agent)) = parse_class(cls, &agent_by_dev) else {
            unknown_agent += 1;
            continue;
        };
        let Some(classified) = classify_ability(cls, agent) else {
            unknown_cls += 1;
            continue;
        };
        let owner_actor = nearest_player_actor(x, y, t);
        let team = if owner_actor != -1 { team_of_actor[owner_actor as usize] } else { -1 };
        out.push(json!({
            "t": obj.get("t").cloned().unwrap_or(Value::Null),
            "x": obj.get("x").cloned().unwrap_or(Value::Null),
            "y": obj.get("y").cloned().unwrap_or(Value::Null),
            "cls": cls,
            "agent": agent.display_name,
            "ability": classified.ability,
            "type": classified.type_,
            "life": classified.life,
            "radius": classified.radius,
            "outerRadius": classified.outer_radius,
            "icon": classified.icon,
            "team": team,
            "ownerActor": owner_actor,
        }));
    }
    let _ = (skipped, unknown_agent, unknown_cls); // parity with TS's log-only counters

    fs::write(abilities_path, serde_json::to_string(&out).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Golden-file parity test. Feeds `build_abilities` the `positions.json`
    //! this crate's own `extract_records` produces (regenerated fresh by
    //! `extract::tests::run_and_check`'s logic, inlined here) plus the golden
    //! `channels.jsonl` (channel-open events aren't produced by this phase's
    //! code — see `extract.rs`'s module doc comment on why the golden file
    //! is used directly), hits the real `valorant-api.com` network endpoint
    //! (same as the TS sidecar), and asserts the output matches golden
    //! `abilities.json` exactly (no wall-clock fields to ignore here).

    use super::*;
    use crate::replay::test_support::{fixture_bytes, golden_dir, read_json};
    use crate::replay::ParseMode;

    fn map_url_and_name(header: &crate::replay::unreal::models::ReplayHeader) -> (String, String) {
        let map_url = header
            .LevelNamesAndTimes
            .iter()
            .find(|(level, _)| level.starts_with("/Game/Maps/"))
            .map(|(level, _)| level.clone())
            .unwrap_or_default();
        let map_name = map_url.rsplit('/').find(|s| !s.is_empty()).unwrap_or("").to_string();
        (map_url, map_name)
    }

    fn run_and_check(uuid: &str, version: &str) {
        let bytes = fixture_bytes(&format!("{uuid}.vrf"));
        let result = crate::replay::parse_replay_for_app(&bytes, Some(version.to_string()), Some(ParseMode::Full));
        let (map_url, map_name) = map_url_and_name(&result.header);

        let out_dir = std::env::temp_dir().join(format!("replay-rust-abilities-test-{uuid}"));
        std::fs::create_dir_all(&out_dir).unwrap();

        crate::replay::extract::extract_records(
            &result.export_records,
            &result.movement,
            result.movement_record_count,
            &out_dir,
            &format!("{uuid}.vrf"),
            &map_name,
            &map_url,
        )
        .unwrap_or_else(|e| panic!("extract_records failed for {uuid}: {e}"));

        let golden = golden_dir(uuid);
        let positions_path = out_dir.join("positions.json");
        let channels_path = golden.join("channels.jsonl");
        let abilities_path = out_dir.join("abilities.json");

        build_abilities(&channels_path, &positions_path, &abilities_path)
            .unwrap_or_else(|e| panic!("build_abilities failed for {uuid}: {e}"));

        let actual = read_json(&abilities_path);
        let expected = read_json(&golden.join("abilities.json"));
        crate::replay::test_support::assert_json_eq(&actual, &expected, "abilities.json");
    }

    #[test]
    fn matches_golden_9f8b32c5() {
        run_and_check("9f8b32c5-c243-41ec-bbbb-832582edf652", "12.10");
    }

    #[test]
    fn matches_golden_5c673443() {
        run_and_check("5c673443-5bdc-4576-b416-aab3f62471a5", "12.11");
    }
}
