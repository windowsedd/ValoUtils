//! `.rr` and `.last`: short private answers from data the app already keeps,
//! for the Dummy Bot, the Chat composer and group rooms (`.who` lives in
//! `bot_template`, next to the Live Game roster it reads).
//!
//! Replies are lists of short plain lines: whispers send one message per line
//! because Valorant collapses newlines and wraps long lines over each other,
//! and its chat font has no emoji.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::bot_template::{clip_line, WHISPER_LINE_LIMIT};
use crate::riot::chat_command::QuickCommand;
use crate::riot::client::RiotState;
use crate::store::CacheStore;

/// RR changes listed by `.rr`, newest first.
const RR_HISTORY: usize = 5;

/// The lines answering `command`.
pub(crate) async fn reply_lines(command: QuickCommand, app: Option<&AppHandle>) -> Vec<String> {
    let Some(app) = app else {
        return vec!["ValoUtils isn't ready yet.".into()];
    };
    let lines = match command {
        QuickCommand::Who => super::bot_template::who_lines(app).await,
        QuickCommand::Rr => rr_lines(app).await,
        QuickCommand::Last => last_lines(app).await,
        QuickCommand::Met => super::bot_template::met_lines(app).await,
    };
    lines.iter().map(|line| clip_line(line, WHISPER_LINE_LIMIT)).collect()
}

/// The saved career when it is current, otherwise a fresh one (falling back to
/// the saved one if Riot can't be reached).
async fn career(app: &AppHandle) -> Result<Value, String> {
    let saved = super::career::career_cached(app.state::<RiotState>(), app.state::<CacheStore>())
        .await
        .unwrap_or(Value::Null);
    let has_saved = saved.get("success") == Some(&json!(true));
    if has_saved && saved.get("fresh") == Some(&json!(true)) {
        return Ok(saved);
    }
    let fetched = super::career::career_get(app.state::<RiotState>(), app.state::<CacheStore>())
        .await
        .unwrap_or(Value::Null);
    match super::mcp::failure_message(&fetched) {
        None => Ok(fetched),
        Some(_) if has_saved => Ok(saved),
        Some(message) => Err(message),
    }
}

/// RR earned in each recent competitive game, newest first.
fn rr_changes(career: &Value) -> Vec<i64> {
    career
        .pointer("/competitiveUpdates/Matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|game| game.get("RankedRatingEarned").and_then(Value::as_i64))
        .collect()
}

async fn rr_lines(app: &AppHandle) -> Vec<String> {
    match career(app).await {
        Ok(career) => {
            let changes = rr_changes(&career);
            format_rr(&super::mcp::player_overview(career, None), &changes)
        }
        Err(message) => vec![message],
    }
}

fn signed(value: i64) -> String {
    if value > 0 {
        format!("+{value}")
    } else {
        value.to_string()
    }
}

/// `.rr` from a [`super::mcp::player_overview`] and the recent RR changes.
fn format_rr(overview: &Value, changes: &[i64]) -> Vec<String> {
    let name = |value: Option<&Value>| value.and_then(|rank| rank.get("name")).and_then(Value::as_str).map(str::to_owned);
    let act = overview.get("currentAct").filter(|act| !act.is_null());
    let rank = name(overview.get("currentRank")).or_else(|| name(act.and_then(|act| act.get("rank"))));
    let mut first = match rank {
        Some(rank) => {
            let rr = overview
                .get("currentRr")
                .and_then(Value::as_u64)
                .or_else(|| act.and_then(|act| act.get("rr")).and_then(Value::as_u64))
                .unwrap_or(0);
            format!("{rank} {rr}RR")
        }
        None => "Unrated this act".to_string(),
    };
    if let Some(position) = act.and_then(|act| act.get("leaderboardRank")).and_then(Value::as_u64) {
        first.push_str(&format!(" (#{position})"));
    }
    if let Some(peak) = name(overview.get("peakRank")) {
        first.push_str(&format!(", peak {peak}"));
    }
    let mut lines = vec![first];
    if let Some(act) = act {
        let games = act.get("games").and_then(Value::as_u64).unwrap_or(0);
        if games > 0 {
            let wins = act.get("wins").and_then(Value::as_u64).unwrap_or(0);
            let rate = act.get("winRatePercent").and_then(Value::as_f64).unwrap_or(0.0);
            lines.push(format!("This act: {wins}W {}L ({rate:.0}% win)", games.saturating_sub(wins)));
        }
    }
    if !changes.is_empty() {
        let net: i64 = changes.iter().sum();
        let shown: Vec<String> = changes.iter().take(RR_HISTORY).map(|rr| signed(*rr)).collect();
        lines.push(format!("Last {} games: {} RR ({})", changes.len(), signed(net), shown.join(" ")));
    }
    lines
}

async fn last_lines(app: &AppHandle) -> Vec<String> {
    let list = super::matches::match_list(vec![json!(0), json!(1)], app.state::<RiotState>())
        .await
        .unwrap_or(Value::Null);
    if let Some(message) = super::mcp::failure_message(&list) {
        return vec![message];
    }
    let Some(match_id) = list
        .pointer("/matches/0/matchId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
    else {
        return vec!["No recent matches.".into()];
    };
    let reduced = match super::mcp::scoreboard(app, &match_id).await {
        Ok(reduced) => reduced,
        Err(message) => return vec![message],
    };
    let (agents, maps) = super::bot_template::content_names().await;
    let summary = super::mcp::own_match_summary(&reduced, &agents, &maps);
    // RR only from the saved career: `.last` should not cost a career fetch.
    let saved = super::career::career_cached(app.state::<RiotState>(), app.state::<CacheStore>())
        .await
        .unwrap_or(Value::Null);
    let rr = saved
        .pointer("/competitiveUpdates/Matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|game| game.get("MatchID").and_then(Value::as_str).is_some_and(|id| id.eq_ignore_ascii_case(&match_id)))
        .and_then(|game| game.get("RankedRatingEarned").and_then(Value::as_i64));
    format_last(&summary, rr, super::store::now_ms())
}

pub(super) fn ago(started_ms: u64, now_ms: u64) -> Option<String> {
    let minutes = now_ms.checked_sub(started_ms)? / 60_000;
    Some(match minutes {
        0..=59 => format!("{minutes} min ago"),
        60..=1439 => format!("{} h ago", minutes / 60),
        _ => format!("{} d ago", minutes / 1440),
    })
}

/// `.last` from [`super::mcp::own_match_summary`] and the RR it earned.
fn format_last(summary: &Value, rr: Option<i64>, now_ms: u64) -> Vec<String> {
    let text = |key: &str| summary.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
    // The summary's result carries a coloured marker for MCP ("🟢 Win").
    let result = text("result").and_then(|result| result.split_whitespace().last());
    let mut first = String::from("Last match:");
    if let Some(result) = result {
        first.push_str(&format!(" {result}"));
        if let Some(score) = text("score") {
            first.push_str(&format!(" {score}"));
        }
        first.push_str(" on");
    }
    first.push_str(&format!(" {}", text("map").unwrap_or("?")));
    if let Some(mode) = text("mode") {
        first.push_str(&format!(", {}", super::bot_template::mode_label_public(mode)));
    }
    if let Some(when) = summary.get("startedAtMillis").and_then(Value::as_u64).and_then(|started| ago(started, now_ms)) {
        first.push_str(&format!(", {when}"));
    }
    let number = |key: &str| summary.get(key).and_then(Value::as_f64);
    let mut second = format!("You: {}", text("agent").unwrap_or("?"));
    if let (Some(kills), Some(deaths), Some(assists)) = (number("kills"), number("deaths"), number("assists")) {
        second.push_str(&format!(" {kills:.0}/{deaths:.0}/{assists:.0}"));
    }
    if let Some(acs) = number("acs") {
        second.push_str(&format!(", ACS {acs:.0}"));
    }
    if let Some(headshots) = number("headshotPercent") {
        second.push_str(&format!(", HS {headshots:.0}%"));
    }
    if let Some(rr) = rr {
        second.push_str(&format!(", {} RR", signed(rr)));
    }
    vec![first, second]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overview() -> Value {
        json!({
            "currentRank": { "tier": 18, "name": "Diamond 1" },
            "currentRr": 45,
            "peakRank": { "tier": 21, "name": "Ascendant 1" },
            "currentAct": { "rank": { "tier": 18, "name": "Diamond 1" }, "rr": 45, "wins": 24, "games": 41, "winRatePercent": 58.5, "leaderboardRank": null },
        })
    }

    #[test]
    fn rr_shows_rank_act_record_and_recent_changes() {
        let lines = format_rr(&overview(), &[18, -15, 21, 0, -20, 19]);
        assert_eq!(lines[0], "Diamond 1 45RR, peak Ascendant 1");
        assert_eq!(lines[1], "This act: 24W 17L (58% win)");
        assert_eq!(lines[2], "Last 6 games: +23 RR (+18 -15 +21 0 -20)");
    }

    #[test]
    fn rr_without_a_rank_says_unrated() {
        let lines = format_rr(&json!({ "currentRank": null, "currentAct": null, "peakRank": null }), &[]);
        assert_eq!(lines, ["Unrated this act"]);
    }

    #[test]
    fn last_shows_result_score_map_and_own_line() {
        let summary = json!({
            "result": "🟢 Win", "score": "13-9", "map": "Ascent", "mode": "competitive",
            "startedAtMillis": 1_000_000, "agent": "Jett",
            "kills": 22, "deaths": 14, "assists": 5, "acs": 265.4, "headshotPercent": 28.2,
        });
        let lines = format_last(&summary, Some(21), 1_000_000 + 2 * 3_600_000);
        assert_eq!(lines[0], "Last match: Win 13-9 on Ascent, Competitive, 2 h ago");
        assert_eq!(lines[1], "You: Jett 22/14/5, ACS 265, HS 28%, +21 RR");
    }

    #[test]
    fn last_without_a_result_or_rr_leaves_them_out() {
        let summary = json!({ "map": "Range", "mode": "", "agent": "Sage" });
        assert_eq!(format_last(&summary, None, 0), ["Last match: Range", "You: Sage"]);
    }

    #[test]
    fn ago_reads_minutes_hours_and_days() {
        assert_eq!(ago(0, 5 * 60_000).as_deref(), Some("5 min ago"));
        assert_eq!(ago(0, 3 * 3_600_000).as_deref(), Some("3 h ago"));
        assert_eq!(ago(0, 2 * 86_400_000).as_deref(), Some("2 d ago"));
        assert_eq!(ago(10, 0), None);
    }
}
