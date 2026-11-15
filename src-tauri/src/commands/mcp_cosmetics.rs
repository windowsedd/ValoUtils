//! MCP tools for cosmetics and round timelines: the equipped loadout, owned
//! skins, and a match's rounds. Names come from the public valorant-api.com
//! catalogs (cached per session by `mcp::public_catalog`).

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use tauri::{AppHandle, Manager};

use super::bot_template::{content_names, fetch_public_json};
use super::mcp::{failure_message, party_failure, player_labels, players, public_catalog, scoreboard};
use crate::riot::client::RiotState;

/// Weapon order in the game's armory, by catalog category.
const CATEGORY_ORDER: [&str; 7] = ["Sidearm", "SMG", "Shotgun", "Rifle", "Sniper", "Heavy", "Melee"];

#[derive(Default)]
struct WeaponNames {
    /// Weapon name and armory rank, by weapon UUID.
    weapons: HashMap<String, (String, usize)>,
    skins: HashMap<String, String>,
    chromas: HashMap<String, String>,
    /// (weapon UUID, skin name) by skin-level UUID; owned skins are levels.
    levels: HashMap<String, (String, String)>,
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn lower(value: &str) -> String {
    value.to_ascii_lowercase()
}

fn weapon_names(catalog: Option<&Value>) -> WeaponNames {
    let mut names = WeaponNames::default();
    for weapon in catalog.and_then(|c| c.get("data")).and_then(Value::as_array).into_iter().flatten() {
        let id = lower(text(weapon, "uuid"));
        let category = text(weapon, "category").rsplit("::").next().unwrap_or_default();
        let rank = CATEGORY_ORDER.iter().position(|c| *c == category).unwrap_or(CATEGORY_ORDER.len());
        names.weapons.insert(id.clone(), (text(weapon, "displayName").to_string(), rank));
        for skin in weapon.get("skins").and_then(Value::as_array).into_iter().flatten() {
            let skin_name = text(skin, "displayName").to_string();
            names.skins.insert(lower(text(skin, "uuid")), skin_name.clone());
            for chroma in skin.get("chromas").and_then(Value::as_array).into_iter().flatten() {
                names.chromas.insert(lower(text(chroma, "uuid")), text(chroma, "displayName").to_string());
            }
            for level in skin.get("levels").and_then(Value::as_array).into_iter().flatten() {
                names.levels.insert(lower(text(level, "uuid")), (id.clone(), skin_name.clone()));
            }
        }
    }
    names
}

/// `(weapon name, armory rank)` by weapon UUID and skin name by skin UUID, for
/// the live match's equipped-skins table. `None` when the catalog is unreachable.
pub(crate) async fn skin_names() -> Option<(HashMap<String, (String, usize)>, HashMap<String, String>)> {
    let catalog = public_catalog("weapons").await?;
    let names = weapon_names(Some(&catalog));
    Some((names.weapons, names.skins))
}

/// A player's non-default skins in armory order, e.g. "Reaver Vandal, Prime Phantom".
pub(crate) fn equipped_skins(
    weapons_by_id: &serde_json::Map<String, Value>,
    weapons: &HashMap<String, (String, usize)>,
    skins: &HashMap<String, String>,
) -> String {
    let mut equipped: Vec<(usize, String)> = weapons_by_id
        .iter()
        .filter_map(|(weapon_id, skin_id)| {
            let (weapon, rank) = weapons.get(&lower(weapon_id))?;
            let skin = skins.get(&lower(skin_id.as_str()?))?;
            // Default skins ("Standard Vandal", the "Melee" knife) say nothing.
            let default = skin.starts_with("Standard") || skin == weapon || skin.starts_with("Random Favorite");
            (!default).then(|| (*rank, skin.clone()))
        })
        .collect();
    equipped.sort();
    if equipped.is_empty() {
        return "default skins".into();
    }
    equipped.into_iter().map(|(_, skin)| skin).collect::<Vec<_>>().join(", ")
}

/// Display names by UUID, including nested levels (buddies, sprays).
pub(super) fn catalog_names(catalog: Option<&Value>) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for item in catalog.and_then(|c| c.get("data")).and_then(Value::as_array).into_iter().flatten() {
        let name = text(item, "displayName").to_string();
        names.insert(lower(text(item, "uuid")), name.clone());
        for level in item.get("levels").and_then(Value::as_array).into_iter().flatten() {
            names.insert(lower(text(level, "uuid")), name.clone());
        }
    }
    names
}

fn name_or(names: &HashMap<String, String>, id: &str) -> Value {
    if id.is_empty() {
        return Value::Null;
    }
    names.get(&lower(id)).map(|name| json!(name)).unwrap_or(json!(id))
}

/// The equipped loadout reduced to names.
fn loadout_summary(
    loadout: &Value,
    weapons: &WeaponNames,
    buddies: &HashMap<String, String>,
) -> Vec<Value> {
    let mut guns: Vec<(usize, String, Value)> = loadout
        .get("Guns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|gun| {
            let weapon_id = lower(text(gun, "ID"));
            let (weapon, rank) = weapons.weapons.get(&weapon_id).cloned().unwrap_or((weapon_id.clone(), usize::MAX));
            let skin = weapons.skins.get(&lower(text(gun, "SkinID"))).cloned().unwrap_or_default();
            // Only name a chroma when it says more than the skin name does.
            let chroma = weapons
                .chromas
                .get(&lower(text(gun, "ChromaID")))
                .filter(|chroma| **chroma != skin && !chroma.starts_with("Standard"))
                .cloned();
            let buddy = Some(text(gun, "CharmID")).filter(|id| !id.is_empty()).map(|id| name_or(buddies, id));
            let row = json!({
                "weapon": weapon,
                "skin": if skin.is_empty() { Value::Null } else { json!(skin) },
                "chroma": chroma,
                "buddy": buddy,
            });
            (rank, weapon, row)
        })
        .collect();
    guns.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    guns.into_iter().map(|(_, _, row)| row).collect()
}

/// Your equipped skins, buddies, card, title and sprays.
pub(super) async fn get_loadout(app: &AppHandle) -> Result<Value, String> {
    let riot = app.state::<RiotState>();
    let loadout = crate::riot::api::with_api(&riot, |api| async move { api.get_player_loadout(&api.puuid).await })
    .await
    .map_err(|error| party_failure(&error))?;
    let (weapon_catalog, buddy_catalog, spray_catalog) =
        tokio::join!(public_catalog("weapons"), public_catalog("buddies"), public_catalog("sprays"));
    let weapons = weapon_names(weapon_catalog.as_deref());
    let buddies = catalog_names(buddy_catalog.as_deref());
    let sprays = catalog_names(spray_catalog.as_deref());

    let identity = loadout.get("Identity").cloned().unwrap_or(Value::Null);
    let card_id = lower(text(&identity, "PlayerCardID"));
    let title_id = lower(text(&identity, "PlayerTitleID"));
    let (card, title) = tokio::join!(
        async {
            if card_id.is_empty() {
                return None;
            }
            fetch_public_json(&format!("https://valorant-api.com/v1/playercards/{card_id}?language=en-US"))
                .await
                .and_then(|body| body.pointer("/data/displayName").and_then(Value::as_str).map(str::to_owned))
        },
        async {
            if title_id.is_empty() {
                return None;
            }
            fetch_public_json(&format!("https://valorant-api.com/v1/playertitles/{title_id}?language=en-US"))
                .await
                .and_then(|body| {
                    body.pointer("/data/titleText")
                        .or_else(|| body.pointer("/data/displayName"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
        },
    );
    let equipped_sprays: Vec<Value> = loadout
        .get("Sprays")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|spray| name_or(&sprays, text(spray, "SprayID")))
        .collect();
    let mut summary = json!({
        "playerCard": card,
        "title": title,
        "sprays": equipped_sprays,
        "weapons": loadout_summary(&loadout, &weapons, &buddies),
    });
    if weapon_catalog.is_none() {
        summary["note"] = json!("Weapon and skin names couldn't be loaded from valorant-api.com, so IDs are shown.");
    }
    Ok(summary)
}

/// Owned skins grouped by weapon, plus counts of other cosmetics.
fn owned_summary(items: &[Value], weapons: &WeaponNames) -> Value {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_weapon: HashMap<String, Vec<String>> = HashMap::new();
    for item in items {
        let kind = text(item, "kind").to_string();
        if kind != "skins" {
            *counts.entry(kind).or_default() += 1;
            continue;
        }
        if let Some((weapon_id, skin)) = weapons.levels.get(&lower(text(item, "itemId"))) {
            let skins = by_weapon.entry(weapon_id.clone()).or_default();
            if !skins.contains(skin) {
                skins.push(skin.clone());
            }
        }
    }
    let mut rows: Vec<(usize, String, Vec<String>)> = by_weapon
        .into_iter()
        .map(|(id, mut skins)| {
            skins.sort();
            let (name, rank) = weapons.weapons.get(&id).cloned().unwrap_or((id, usize::MAX));
            (rank, name, skins)
        })
        .collect();
    rows.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    let total: usize = rows.iter().map(|row| row.2.len()).sum();
    json!({
        "totalSkins": total,
        "buddies": counts.get("buddies").copied().unwrap_or(0),
        "sprays": counts.get("sprays").copied().unwrap_or(0),
        "playerCards": counts.get("cards").copied().unwrap_or(0),
        "titles": counts.get("titles").copied().unwrap_or(0),
        "skinsByWeapon": rows
            .into_iter()
            .map(|(_, weapon, skins)| json!({ "weapon": weapon, "count": skins.len(), "skins": skins.join(", ") }))
            .collect::<Vec<_>>(),
    })
}

pub(super) async fn get_owned_skins(app: &AppHandle) -> Result<Value, String> {
    let reply = super::inventory::inventory_get(app.state::<RiotState>()).await.unwrap_or(Value::Null);
    if let Some(message) = failure_message(&reply) {
        return Err(message);
    }
    let items: Vec<Value> = reply.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let catalog = public_catalog("weapons").await;
    Ok(owned_summary(&items, &weapon_names(catalog.as_deref())))
}

fn clock(millis: u64) -> String {
    let seconds = millis / 1000;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// A match's rounds: one summary row each, or every kill of one round. Players
/// are You / Ally N / Enemy N with their agent; no names or IDs.
fn timeline_summary(
    reduced: &Value,
    timeline: &Value,
    round: Option<u64>,
    agents: &HashMap<String, String>,
    weapons: &WeaponNames,
    names: bool,
) -> Value {
    let (labels, my_team) = player_labels(reduced, names);
    let agent_of: HashMap<String, String> = players(reduced)
        .into_iter()
        .map(|player| {
            let id = lower(text(player, "subject"));
            let agent = agents.get(&lower(text(player, "characterId"))).cloned().unwrap_or_default();
            (id, agent)
        })
        .collect();
    let who = |puuid: &str| {
        let id = lower(puuid);
        let label = labels.get(&id).cloned().unwrap_or_else(|| "Unknown".into());
        match agent_of.get(&id).filter(|agent| !agent.is_empty()) {
            Some(agent) => format!("{label} ({agent})"),
            None => label,
        }
    };
    let side = |team: &str| {
        if my_team.is_empty() {
            team.to_string()
        } else if team == my_team {
            "Your team".into()
        } else {
            "Enemy team".into()
        }
    };
    let weapon = |kill: &Value| {
        let item = lower(text(kill, "damageItem"));
        match weapons.weapons.get(&item) {
            Some((name, _)) => name.clone(),
            None => match text(kill, "damageType") {
                "" => "—".into(),
                kind => kind.to_string(),
            },
        }
    };
    let rounds: Vec<&Value> = timeline.get("rounds").and_then(Value::as_array).into_iter().flatten().collect();

    if let Some(number) = round {
        let Some(chosen) = rounds.iter().find(|r| r.get("round").and_then(Value::as_u64).map(|n| n + 1) == Some(number)) else {
            return json!(format!("This match has no round {number}; it has {}.", rounds.len()));
        };
        let mut kills: Vec<&Value> = chosen.get("kills").and_then(Value::as_array).into_iter().flatten().collect();
        kills.sort_by_key(|kill| kill.get("time").and_then(Value::as_u64).unwrap_or(0));
        return json!({
            "round": number,
            "winner": side(text(chosen, "winningTeam")),
            "result": text(chosen, "result"),
            "spikePlant": chosen.get("plant").filter(|p| p.is_object()).map(|plant| format!(
                "{} planted {} at {}", who(text(plant, "player")), text(chosen, "plantSite"),
                clock(plant.get("time").and_then(Value::as_u64).unwrap_or(0)))),
            "spikeDefuse": chosen.get("defuse").filter(|d| d.is_object()).map(|defuse| format!(
                "{} defused at {}", who(text(defuse, "player")),
                clock(defuse.get("time").and_then(Value::as_u64).unwrap_or(0)))),
            "kills": kills.iter().map(|kill| json!({
                "time": clock(kill.get("time").and_then(Value::as_u64).unwrap_or(0)),
                "killer": who(text(kill, "killer")),
                "victim": who(text(kill, "victim")),
                "weapon": weapon(kill),
            })).collect::<Vec<_>>(),
        });
    }

    let (mut mine, mut theirs) = (0u64, 0u64);
    let rows: Vec<Value> = rounds
        .iter()
        .map(|r| {
            let winner = text(r, "winningTeam");
            if !my_team.is_empty() {
                if winner == my_team { mine += 1 } else if !winner.is_empty() { theirs += 1 }
            }
            let mut kills: Vec<&Value> = r.get("kills").and_then(Value::as_array).into_iter().flatten().collect();
            kills.sort_by_key(|kill| kill.get("time").and_then(Value::as_u64).unwrap_or(0));
            let spike = match (r.get("plant").filter(|p| p.is_object()), r.get("defuse").filter(|d| d.is_object())) {
                (Some(_), Some(_)) => format!("planted {}, defused", text(r, "plantSite")),
                (Some(_), None) => format!("planted {}", text(r, "plantSite")),
                _ => "—".into(),
            };
            json!({
                "round": r.get("round").and_then(Value::as_u64).map(|n| n + 1),
                "winner": side(winner),
                "result": text(r, "result"),
                "score": if my_team.is_empty() { Value::Null } else { json!(format!("{mine}–{theirs}")) },
                "firstBlood": kills.first().map(|kill| format!("{} → {}", who(text(kill, "killer")), who(text(kill, "victim")))),
                "kills": kills.len(),
                "spike": spike,
            })
        })
        .collect();
    json!({ "rounds": rows })
}

pub(super) async fn get_match_timeline(app: &AppHandle, match_id: &str, round: Option<u64>) -> Result<Value, String> {
    let reduced = scoreboard(app, match_id).await?;
    let reply = super::matches::match_timeline(
        vec![json!(match_id)],
        app.state::<RiotState>(),
        app.state::<super::matches::MatchTimelineCache>(),
    )
    .await
    .unwrap_or(Value::Null);
    if let Some(message) = failure_message(&reply) {
        return Err(message);
    }
    let timeline = reply.get("timeline").cloned().unwrap_or(Value::Null);
    let ((agents, _), weapon_catalog) = tokio::join!(content_names(), public_catalog("weapons"));
    let names = super::mcp::show_names(app);
    Ok(timeline_summary(&reduced, &timeline, round, &agents, &weapon_names(weapon_catalog.as_deref()), names))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Value {
        json!({ "data": [
            { "uuid": "VANDAL", "displayName": "Vandal", "category": "EEquippableCategory::Rifle",
              "skins": [{ "uuid": "S1", "displayName": "Reaver Vandal",
                          "chromas": [{ "uuid": "C1", "displayName": "Reaver Vandal" }, { "uuid": "C2", "displayName": "Reaver Vandal Variant 2" }],
                          "levels": [{ "uuid": "L1" }, { "uuid": "L2" }] }] },
            { "uuid": "CLASSIC", "displayName": "Classic", "category": "EEquippableCategory::Sidearm",
              "skins": [{ "uuid": "S2", "displayName": "Standard Classic", "chromas": [], "levels": [{ "uuid": "L3" }] }] },
        ] })
    }

    #[test]
    fn loadout_names_weapons_in_armory_order() {
        let names = weapon_names(Some(&catalog()));
        let buddies = HashMap::from([("b1".to_string(), "Lucky Charm".to_string())]);
        let loadout = json!({ "Guns": [
            { "ID": "vandal", "SkinID": "s1", "ChromaID": "c2", "CharmID": "B1" },
            { "ID": "classic", "SkinID": "s2", "ChromaID": "" },
        ] });
        let rows = loadout_summary(&loadout, &names, &buddies);
        assert_eq!(rows[0]["weapon"], "Classic");
        assert_eq!(rows[1]["skin"], "Reaver Vandal");
        assert_eq!(rows[1]["chroma"], "Reaver Vandal Variant 2");
        assert_eq!(rows[1]["buddy"], "Lucky Charm");
        assert!(rows[0]["buddy"].is_null());
    }

    #[test]
    fn equipped_skins_skip_defaults_and_follow_the_armory() {
        let names = weapon_names(Some(&catalog()));
        let loadout = json!({ "vandal": "s1", "classic": "s2" });
        let text = equipped_skins(loadout.as_object().unwrap(), &names.weapons, &names.skins);
        assert_eq!(text, "Reaver Vandal");
        let plain = json!({ "classic": "s2" });
        assert_eq!(equipped_skins(plain.as_object().unwrap(), &names.weapons, &names.skins), "default skins");
    }

    #[test]
    fn owned_skins_group_levels_by_weapon() {
        let names = weapon_names(Some(&catalog()));
        let items = vec![
            json!({ "itemId": "L1", "kind": "skins" }),
            json!({ "itemId": "L2", "kind": "skins" }),
            json!({ "itemId": "x", "kind": "buddies" }),
            json!({ "itemId": "y", "kind": "sprays" }),
        ];
        let summary = owned_summary(&items, &names);
        assert_eq!(summary["totalSkins"], 1);
        assert_eq!(summary["skinsByWeapon"][0]["weapon"], "Vandal");
        assert_eq!(summary["skinsByWeapon"][0]["skins"], "Reaver Vandal");
        assert_eq!(summary["buddies"], 1);
        assert_eq!(summary["sprays"], 1);
    }

    #[test]
    fn timeline_labels_players_and_keeps_a_running_score() {
        let reduced = json!({ "players": [
            { "subject": "me", "teamId": "Blue", "isSelf": true, "acs": 200.0, "characterId": "jett", "role": "player" },
            { "subject": "foe", "teamId": "Red", "isSelf": false, "acs": 150.0, "characterId": "sage", "role": "player" },
        ] });
        let timeline = json!({ "rounds": [
            { "round": 0, "winningTeam": "Blue", "result": "Eliminated",
              "kills": [{ "time": 31000, "killer": "me", "victim": "foe", "damageItem": "VANDAL", "damageType": "Weapon" }] },
            { "round": 1, "winningTeam": "Red", "result": "Bomb detonated", "plantSite": "A",
              "plant": { "time": 65000, "player": "foe" }, "kills": [] },
        ] });
        let agents = HashMap::from([("jett".to_string(), "Jett".to_string()), ("sage".to_string(), "Sage".to_string())]);
        let names = weapon_names(Some(&catalog()));
        let summary = timeline_summary(&reduced, &timeline, None, &agents, &names, false);
        assert_eq!(summary["rounds"][0]["winner"], "Your team");
        assert_eq!(summary["rounds"][0]["firstBlood"], "You (Jett) → Enemy 1 (Sage)");
        assert_eq!(summary["rounds"][1]["score"], "1–1");
        assert_eq!(summary["rounds"][1]["spike"], "planted A");
        let detail = timeline_summary(&reduced, &timeline, Some(1), &agents, &names, false);
        assert_eq!(detail["kills"][0]["weapon"], "Vandal");
        assert_eq!(detail["kills"][0]["time"], "0:31");
        let plant = timeline_summary(&reduced, &timeline, Some(2), &agents, &names, false);
        assert_eq!(plant["spikePlant"], "Enemy 1 (Sage) planted A at 1:05");
        assert!(!summary.to_string().contains("foe"));
    }
}
