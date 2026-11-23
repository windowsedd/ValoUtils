use crate::commands::live::{extract_competitive_seasons, extract_rank};
use crate::commands::rank_shields::remaining_rank_shields;
use crate::riot::api::{self};
use crate::riot::client::RiotState;
use crate::store::CacheStore;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

use super::store::{cache_entry, cached_reply, now_ms, signed_in_puuid};

/// How long a saved career counts as current. Rank and history only change
/// after a match, and a match ending while ValoUtils runs ends it sooner.
const CAREER_FRESH_MS: u64 = 10 * 60 * 1000;
/// Riot needs a moment to add a finished match to history, so a career fetched
/// this soon after a match ended may still miss it.
const MATCH_SETTLE_MS: u64 = 2 * 60 * 1000;

/// When ValoUtils last saw a match end (Unix ms, 0 = not this session).
static LAST_MATCH_ENDED_MS: AtomicU64 = AtomicU64::new(0);

/// Called by the chat poller when a match ends, so the saved career is refetched.
pub fn note_match_ended() {
    LAST_MATCH_ENDED_MS.store(now_ms(), Ordering::Relaxed);
}

fn career_cache_key(puuid: &str) -> String {
    format!("career:{}", puuid.to_ascii_lowercase())
}

fn career_is_fresh(fetched_at: u64, now: u64, match_ended_at: u64) -> bool {
    now.saturating_sub(fetched_at) < CAREER_FRESH_MS
        && (match_ended_at == 0 || fetched_at >= match_ended_at + MATCH_SETTLE_MS)
}

/// The last career fetched for the signed-in account, from `cache.json`, with
/// `fresh` saying whether it can be shown without asking Riot again. Only the
/// local Riot Client is asked who is signed in; no PD request is made.
#[tauri::command]
pub async fn career_cached(
    riot: State<'_, RiotState>,
    cache: State<'_, CacheStore>,
) -> Result<Value, ()> {
    let reply = signed_in_puuid(&riot)
        .await
        .and_then(|puuid| cached_reply(cache.get(&career_cache_key(&puuid))));
    let Some(mut reply) = reply else {
        return Ok(json!({ "success": false, "code": "empty" }));
    };
    let fetched_at = reply.get("fetchedAt").and_then(Value::as_u64).unwrap_or(0);
    let fresh = career_is_fresh(fetched_at, now_ms(), LAST_MATCH_ENDED_MS.load(Ordering::Relaxed));
    reply["fresh"] = json!(fresh);
    Ok(reply)
}

fn account_status_result(
    result: Result<(String, Value), crate::riot::error::RiotError>,
    expected: &str,
    collection: &str,
) -> Value {
    match result {
        Ok((owner, data)) => {
            if !owner.eq_ignore_ascii_case(expected)
                || data
                    .get("Subject")
                    .and_then(Value::as_str)
                    .is_some_and(|subject| !subject.eq_ignore_ascii_case(expected))
            {
                return json!({"success": false, "code": "accountChanged"});
            }
            if !data.get(collection).is_some_and(Value::is_array) {
                return json!({"success": false, "code": "unavailable"});
            }
            json!({"success": true, "data": data})
        }
        Err(error) => json!({"success": false, "code": error.code()}),
    }
}

#[tauri::command]
pub async fn career_account_status(
    args: Vec<Value>,
    riot: State<'_, RiotState>,
) -> Result<Value, ()> {
    let Some(expected) = args
        .first()
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(json!({"success": false, "code": "unavailable"}));
    };
    // Independent requests retain independent auth retries and failure states.
    let (penalties, interventions) = tokio::join!(
        bounded_account_check(api::with_api(&riot, |api| async move {
            let data = api.get_penalties().await?;
            Ok((api.puuid, data))
        })),
        bounded_account_check(api::with_api(&riot, |api| async move {
            let data = api.get_player_interventions().await?;
            Ok((api.puuid, data))
        })),
    );
    Ok(json!({"success": true,
        "penalties": account_status_result(penalties, expected, "Penalties"),
        "interventions": account_status_result(interventions, expected, "InterventionsByCategory")}))
}

async fn bounded_account_check(
    request: impl std::future::Future<Output = Result<(String, Value), crate::riot::error::RiotError>>,
) -> Result<(String, Value), crate::riot::error::RiotError> {
    tokio::time::timeout(std::time::Duration::from_secs(20), request)
        .await
        .unwrap_or(Err(crate::riot::error::RiotError::Timeout))
}

fn career_match_history_indices() -> (u32, u32) {
    (0, 25)
}

fn career_act_rank(mmr: &Value) -> (Option<String>, Vec<Value>) {
    extract_competitive_seasons(Some(mmr))
}

/// Account level is optional: a failed or malformed account-xp reply hides it
/// rather than blocking rank and history.
fn career_account_level(account_xp: &Value) -> Option<Value> {
    let level = account_xp.pointer("/Progress/Level")?.as_u64()?;
    let xp = account_xp
        .pointer("/Progress/XP")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(json!({"level": level, "xp": xp}))
}

/// The signed-in player's Riot ID from a name-service reply, when it has one.
fn career_riot_id(names: &Value, puuid: &str) -> Option<String> {
    let entry = names.as_array()?.iter().find(|entry| {
        entry
            .get("Subject")
            .and_then(Value::as_str)
            .is_some_and(|subject| subject.eq_ignore_ascii_case(puuid))
    })?;
    let name = entry.get("GameName").and_then(Value::as_str)?.trim();
    let tag = entry.get("TagLine").and_then(Value::as_str).unwrap_or("").trim();
    match (name.is_empty(), tag.is_empty()) {
        (true, _) => None,
        (false, true) => Some(name.to_string()),
        (false, false) => Some(format!("{name}#{tag}")),
    }
}

fn career_rank_shields(mmr: &Value, competitive_updates: &Value) -> Option<u8> {
    let (current_tier, _, _, _) = extract_rank(Some(mmr));
    let current_season_id = mmr
        .pointer("/LatestCompetitiveUpdate/SeasonID")
        .and_then(Value::as_str);
    remaining_rank_shields(current_tier, current_season_id, competitive_updates)
}

#[tauri::command]
pub async fn career_get(
    riot: State<'_, RiotState>,
    cache: State<'_, CacheStore>,
) -> Result<Value, ()> {
    // `with_api` retries once with fresh tokens if the cached one has been
    // invalidated (expired, or the player switched accounts).
    let result = api::with_api(&riot, |api| async move {
        let puuid = api.puuid.clone();
        let (history_start, history_end) = career_match_history_indices();
        let names_request = [puuid.clone()];
        let (career, account_xp, names) = tokio::join!(
            async {
                tokio::try_join!(
                    api.get_mmr(&puuid),
                    api.get_competitive_history(&puuid, 0, 15),
                    api.get_match_history(&puuid, history_start, history_end),
                )
            },
            api.get_account_xp(&puuid),
            api.get_names(&names_request),
        );
        let (mmr, competitive_updates, match_history) = career?;
        let riot_id = names.ok().and_then(|names| career_riot_id(&names, &puuid));
        Ok((puuid, riot_id, mmr, competitive_updates, match_history, account_xp.ok()))
    })
    .await;

    Ok(match result {
        Ok((puuid, riot_id, mmr, competitive_updates, match_history, account_xp)) => {
            let (current_season_id, competitive_seasons) = career_act_rank(&mmr);
            let rank_shields = career_rank_shields(&mmr, &competitive_updates);
            let account_level = account_xp.as_ref().and_then(career_account_level);
            let fetched_at = now_ms();
            let reply = json!({
                "success": true,
                "fetchedAt": fetched_at,
                "puuid": puuid,
                "riotId": riot_id,
                "mmr": mmr,
                "competitiveUpdates": competitive_updates,
                "matchHistory": match_history,
                "currentSeasonId": current_season_id,
                "competitiveSeasons": competitive_seasons,
                "rankShields": rank_shields,
                "accountLevel": account_level,
            });
            cache.set(&career_cache_key(&puuid), cache_entry(&reply, fetched_at));
            reply
        }
        Err(e) if e.is_login_required() => {
            json!({ "success": false, "code": "loginRequired" })
        }
        Err(e) => match super::rate_limited_reply(&e.to_string()).await {
            Some(reply) => reply,
            None => json!({ "success": false, "code": e.code(), "error": e }),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn account_checks_reject_other_accounts_and_missing_collections() {
        let mismatch = account_status_result(
            Ok(("alt".into(), json!({"Subject":"alt", "Penalties":[]}))),
            "main",
            "Penalties",
        );
        assert_eq!(mismatch["success"], false);
        assert_eq!(mismatch["code"], "accountChanged");
        let empty = account_status_result(
            Ok(("main".into(), json!({"Subject":"main", "Penalties":[]}))),
            "main",
            "Penalties",
        );
        assert_eq!(empty["success"], true);
        let missing = account_status_result(Ok(("main".into(), json!({}))), "main", "Penalties");
        assert_eq!(missing["success"], false);
        let failure = account_status_result(
            Err(crate::riot::error::RiotError::LoginRequired),
            "main",
            "Penalties",
        );
        assert_eq!(failure["success"], false);
    }

    #[test]
    fn saved_career_goes_stale_with_age_or_a_finished_match() {
        let minute = 60 * 1000;
        let now = 100 * minute;
        assert!(career_is_fresh(now - 9 * minute, now, 0));
        assert!(!career_is_fresh(now - 11 * minute, now, 0));
        // Saved before the match ended, or before Riot had time to add it.
        assert!(!career_is_fresh(now - 5 * minute, now, now - 4 * minute));
        assert!(!career_is_fresh(now - minute, now, now - 2 * minute));
        assert!(career_is_fresh(now - minute, now, now - 4 * minute));
    }

    #[test]
    fn reads_account_level_progress() {
        let level = career_account_level(&json!({"Progress": {"Level": 142, "XP": 2300}}));
        assert_eq!(level, Some(json!({"level": 142, "xp": 2300})));
        assert_eq!(career_account_level(&json!({})), None);
    }

    #[test]
    fn reads_the_players_riot_id() {
        let names = json!([
            {"Subject": "other", "GameName": "Someone", "TagLine": "1"},
            {"Subject": "main", "GameName": "Player", "TagLine": "NA1"}
        ]);
        assert_eq!(career_riot_id(&names, "main").as_deref(), Some("Player#NA1"));
        assert_eq!(career_riot_id(&names, "missing"), None);
        assert_eq!(career_riot_id(&json!([{"Subject": "main", "GameName": ""}]), "main"), None);
    }

    #[test]
    fn limits_career_history_to_riot_page_size() {
        assert_eq!(career_match_history_indices(), (0, 25));
    }

    #[test]
    fn includes_normalized_act_rank_history() {
        let mmr = json!({
            "QueueSkills": {"competitive": {"SeasonalInfoBySeasonID": {
                "act-current": {
                    "CompetitiveTier": 21,
                    "RankedRating": 44,
                    "NumberOfWins": 8,
                    "NumberOfGames": 12,
                    "WinsByTier": {"20": 3, "21": 5}
                }
            }}},
            "LatestCompetitiveUpdate": {"SeasonID": "act-current"}
        });

        let (current, seasons) = career_act_rank(&mmr);
        assert_eq!(current.as_deref(), Some("act-current"));
        assert_eq!(seasons.len(), 1);
        assert_eq!(seasons[0]["wins"], 8);
    }

    #[test]
    fn includes_rank_shields_for_the_current_competitive_tier() {
        let mmr = json!({
            "LatestCompetitiveUpdate": {
                "SeasonID": "act-current",
                "TierAfterUpdate": 12,
                "RankedRatingAfterUpdate": 10
            }
        });
        let updates = json!({"Matches": [{
            "SeasonID": "act-current",
            "TierBeforeUpdate": 11,
            "TierAfterUpdate": 12,
            "RankedRatingBeforeUpdate": 90,
            "RankedRatingAfterUpdate": 10,
            "RankedRatingEarned": 20
        }]});

        assert_eq!(career_rank_shields(&mmr, &updates), Some(2));
        assert_eq!(career_rank_shields(&json!({}), &updates), None);
    }
}
