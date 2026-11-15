//! "Played with before": who from a lobby or a finished match was also in the
//! signed-in player's recent games, and on which side.
//!
//! The source is the player's own last [`RECENT_MATCHES`] matches: one
//! match-history request (reused for [`LIST_TTL`]) and the reduced scoreboards
//! the Matches page caches, fetched one at a time through the shared PD client
//! and rate budget only when missing. Nothing is saved to disk.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::riot::client::RiotState;

/// How many of your matches are searched.
pub(crate) const RECENT_MATCHES: u32 = 10;
/// How long the match list is reused before asking Riot again.
const LIST_TTL: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Encounter {
    /// Matches where they were on your team.
    pub with: u32,
    /// Matches where they were on the other side (every opponent in Deathmatch).
    pub against: u32,
    /// Your most recent match they were in.
    pub last_match_id: String,
    pub last_start_millis: u64,
}

struct Recent {
    owner: String,
    listed_at: Instant,
    ids: Vec<String>,
    boards: HashMap<String, Value>,
}

fn recent() -> &'static Mutex<Option<Recent>> {
    static RECENT: OnceLock<Mutex<Option<Recent>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(None))
}

/// The signed-in player's PUUID and the scoreboards of their recent matches,
/// newest first. `Err` carries the failed reply (`loginRequired`, rate limit…).
pub(crate) async fn recent_boards(app: &AppHandle) -> Result<(String, Vec<Value>), Value> {
    let riot = app.state::<RiotState>();
    let owner = crate::riot::client::get_tokens(&riot, false)
        .await
        .ok()
        .and_then(|tokens| tokens.get("subject").and_then(Value::as_str).map(str::to_ascii_lowercase))
        .ok_or_else(|| json!({ "success": false, "code": "loginRequired" }))?;

    // Held for the whole call, so concurrent callers share one set of requests.
    let mut guard = recent().lock().await;
    let fresh = guard
        .as_ref()
        .is_some_and(|recent| recent.owner == owner && recent.listed_at.elapsed() < LIST_TTL);
    if !fresh {
        let list = super::matches::match_list(vec![json!(0), json!(RECENT_MATCHES)], riot.clone())
            .await
            .unwrap_or(Value::Null);
        if list.get("success") != Some(&json!(true)) {
            return Err(list);
        }
        let ids: Vec<String> = list
            .get("matches")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("matchId").and_then(Value::as_str))
            .filter(|id| !id.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        // Keep scoreboards already read for this account; matches never change.
        let boards = match guard.take() {
            Some(old) if old.owner == owner => old.boards,
            _ => HashMap::new(),
        };
        *guard = Some(Recent { owner: owner.clone(), listed_at: Instant::now(), ids, boards });
    }
    let recent = guard.as_mut().expect("set above");
    for id in recent.ids.clone() {
        if recent.boards.contains_key(&id) {
            continue;
        }
        // Served from the Matches cache when it's there; otherwise one request.
        // Stored as each arrives, so a caller that gives up keeps what was read.
        match super::mcp::scoreboard(app, &id).await {
            Ok(board) => {
                recent.boards.insert(id, board);
            }
            Err(error) => log::info!("encounters: match {id} skipped: {error}"),
        }
    }
    let boards = recent.ids.iter().filter_map(|id| recent.boards.get(id).cloned()).collect();
    Ok((owner, boards))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Everyone who shared one of `boards` with `owner`, by lowercase PUUID.
/// `exclude` (the match being viewed) is left out so it doesn't count itself.
pub(crate) fn tally(owner: &str, boards: &[Value], exclude: Option<&str>) -> BTreeMap<String, Encounter> {
    let mut seen: BTreeMap<String, Encounter> = BTreeMap::new();
    for board in boards {
        let match_id = text(board, "matchId").to_ascii_lowercase();
        if exclude.is_some_and(|exclude| exclude.eq_ignore_ascii_case(&match_id)) {
            continue;
        }
        let players: Vec<&Value> = board.get("players").and_then(Value::as_array).into_iter().flatten().collect();
        let Some(me) = players.iter().find(|player| text(player, "subject").eq_ignore_ascii_case(owner)) else {
            continue;
        };
        let my_team = text(me, "teamId");
        let start = board.get("startMillis").and_then(Value::as_u64).unwrap_or(0);
        for player in players {
            let puuid = text(player, "subject").to_ascii_lowercase();
            if puuid.is_empty() || puuid == owner || text(player, "role") == "coach" {
                continue;
            }
            let entry = seen.entry(puuid).or_default();
            if !my_team.is_empty() && text(player, "teamId") == my_team {
                entry.with += 1;
            } else {
                entry.against += 1;
            }
            if start >= entry.last_start_millis {
                entry.last_start_millis = start;
                entry.last_match_id = match_id.clone();
            }
        }
    }
    seen
}

/// `args: [excludeMatchId?]`. Everyone from your last [`RECENT_MATCHES`]
/// matches: `{ success, recentMatches, players: { puuid: Encounter } }`.
#[tauri::command]
pub async fn encounters_get(args: Vec<Value>, app: AppHandle) -> Result<Value, ()> {
    let exclude = args.first().and_then(Value::as_str).filter(|id| !id.is_empty());
    Ok(match recent_boards(&app).await {
        Ok((owner, boards)) => json!({
            "success": true,
            "recentMatches": boards.len(),
            "players": tally(&owner, &boards, exclude),
        }),
        Err(reply) => reply,
    })
}

/// "With you 2× · against you 1×", for MCP rows; `None` when never met.
pub(crate) fn describe(encounter: Option<&Encounter>) -> Option<String> {
    let encounter = encounter?;
    let mut parts = Vec::new();
    if encounter.with > 0 {
        parts.push(format!("with you {}×", encounter.with));
    }
    if encounter.against > 0 {
        parts.push(format!("against you {}×", encounter.against));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(id: &str, start: u64, players: &[(&str, &str)]) -> Value {
        json!({
            "matchId": id,
            "startMillis": start,
            "players": players.iter().map(|(puuid, team)| json!({ "subject": puuid, "teamId": team, "role": "player" })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn counts_sides_across_matches_and_skips_the_viewed_one() {
        let boards = [
            board("M2", 200, &[("ME", "Blue"), ("duo", "Blue"), ("rival", "Red")]),
            board("m1", 100, &[("me", "Red"), ("duo", "Red"), ("rival", "Red")]),
            board("m0", 50, &[("other", "Blue"), ("duo", "Blue")]),
        ];
        let seen = tally("me", &boards, None);
        assert_eq!(seen["duo"], Encounter { with: 2, against: 0, last_match_id: "m2".into(), last_start_millis: 200 });
        assert_eq!((seen["rival"].with, seen["rival"].against), (1, 1));
        assert!(!seen.contains_key("me") && !seen.contains_key("other"));

        let without_latest = tally("me", &boards, Some("m2"));
        assert_eq!(without_latest["duo"].with, 1);
        assert_eq!(without_latest["duo"].last_match_id, "m1");
    }

    #[test]
    fn coaches_are_not_encounters_and_descriptions_read_naturally() {
        let mut coached = board("m", 1, &[("me", "Blue"), ("coach", "Blue")]);
        coached["players"][1]["role"] = json!("coach");
        assert!(tally("me", &[coached], None).is_empty());
        let met = Encounter { with: 2, against: 1, ..Encounter::default() };
        assert_eq!(describe(Some(&met)).as_deref(), Some("with you 2× · against you 1×"));
        assert_eq!(describe(None), None);
    }
}
