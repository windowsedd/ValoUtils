use crate::commands::live::{extract_competitive_seasons, extract_rank};
use crate::riot::api;
use crate::riot::client::RiotState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;

#[derive(Clone, Debug, PartialEq, Eq)]
struct LeaderboardThresholds {
    immortal_two: i64,
    immortal_three: i64,
    radiant: i64,
}

#[derive(Clone)]
struct CachedLeaderboardThresholds {
    thresholds: LeaderboardThresholds,
    fetched_at: Instant,
}

const LEADERBOARD_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

fn leaderboard_cache() -> &'static Mutex<HashMap<String, CachedLeaderboardThresholds>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedLeaderboardThresholds>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn non_negative_integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).filter(|value| *value >= 0)
}

fn parse_leaderboard_thresholds(value: &Value) -> Option<LeaderboardThresholds> {
    let details = value.get("tierDetails")?.as_object()?;
    let threshold = |tier: &str| {
        non_negative_integer(
            details
                .get(tier)
                .and_then(|detail| detail.get("rankedRatingThreshold")),
        )
    };
    let immortal_two = threshold("25")?;
    let immortal_three = threshold("26")?;
    let configured_radiant = threshold("27")?;
    let top_tier = non_negative_integer(value.get("topTierRRThreshold"))?;
    let radiant = configured_radiant.max(top_tier);
    (immortal_two <= immortal_three && immortal_three <= radiant).then_some(LeaderboardThresholds {
        immortal_two,
        immortal_three,
        radiant,
    })
}

fn resolve_current_tier(raw_tier: i64, rr: i64, thresholds: Option<&LeaderboardThresholds>) -> i64 {
    if !(24..=27).contains(&raw_tier) {
        return raw_tier;
    }
    let Some(thresholds) = thresholds else {
        return raw_tier;
    };
    if rr >= thresholds.radiant {
        27
    } else if rr >= thresholds.immortal_three {
        26
    } else if rr >= thresholds.immortal_two {
        25
    } else {
        24
    }
}

async fn current_leaderboard_thresholds(
    api: &api::RiotApiClient,
    season_id: &str,
) -> Option<LeaderboardThresholds> {
    let cache_key = format!(
        "{}:{}",
        api.region.to_ascii_lowercase(),
        season_id.to_ascii_lowercase()
    );
    let now = Instant::now();
    if let Ok(cache) = leaderboard_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            if now.saturating_duration_since(cached.fetched_at) < LEADERBOARD_CACHE_TTL {
                return Some(cached.thresholds.clone());
            }
        }
    }

    let response = api.get_competitive_leaderboard(season_id).await.ok()?;
    let thresholds = parse_leaderboard_thresholds(&response)?;
    if let Ok(mut cache) = leaderboard_cache().lock() {
        cache.insert(
            cache_key,
            CachedLeaderboardThresholds {
                thresholds: thresholds.clone(),
                fetched_at: now,
            },
        );
    }
    Some(thresholds)
}

fn friend_match_history_indices() -> (u32, u32) {
    (0, 25)
}

fn local_friend_profile(puuid: &str) -> Option<Value> {
    puuid
        .eq_ignore_ascii_case(crate::fake_player::PUUID)
        .then(|| {
            json!({
                "currentTier": 0,
                "currentRR": 0,
                "peakTier": 0,
                "peakSeasonId": null,
                "currentSeasonId": null,
                "competitiveSeasons": [],
                "matches": [],
            })
        })
}

fn validated_puuid(value: Option<&str>) -> Result<String, String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    let Some(value) = value else {
        return Err("Friend PUUID is required.".into());
    };
    if value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Friend PUUID is invalid.".into());
    }
    Ok(value.to_owned())
}

fn normalize_friend_matches(history: &Value, competitive_updates: &Value) -> Vec<Value> {
    let updates: HashMap<&str, &Value> = competitive_updates
        .get("Matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|update| Some((update.get("MatchID")?.as_str()?, update)))
        .collect();

    history
        .get("History")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let match_id = entry.get("MatchID")?.as_str()?;
            if match_id.is_empty() {
                return None;
            }
            let update = updates.get(match_id).copied();
            let ranked = |key: &str| {
                update
                    .and_then(|value| value.get(key))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            Some(json!({
                "matchId": match_id,
                "startMillis": entry.get("GameStartTime").and_then(Value::as_u64).unwrap_or(0),
                "queueId": entry.get("QueueID").and_then(Value::as_str).unwrap_or_default(),
                "tierBefore": ranked("TierBeforeUpdate"),
                "tierAfter": ranked("TierAfterUpdate"),
                "rankedRatingAfter": ranked("RankedRatingAfterUpdate"),
                "rrEarned": ranked("RankedRatingEarned"),
            }))
        })
        .collect()
}

fn normalize_friend_profile(
    mmr: &Value,
    competitive_updates: &Value,
    history: &Value,
    thresholds: Option<&LeaderboardThresholds>,
) -> Value {
    let (raw_current_tier, current_rr, peak_tier, peak_season_id) = extract_rank(Some(mmr));
    let current_tier = resolve_current_tier(raw_current_tier, current_rr, thresholds);
    let (current_season_id, competitive_seasons) = extract_competitive_seasons(Some(mmr));
    json!({
        "currentTier": current_tier,
        "currentRR": current_rr,
        "peakTier": peak_tier,
        "peakSeasonId": peak_season_id,
        "currentSeasonId": current_season_id,
        "competitiveSeasons": competitive_seasons,
        "matches": normalize_friend_matches(history, competitive_updates),
    })
}

#[tauri::command]
pub async fn friend_profile_get(
    args: Vec<Value>,
    riot: State<'_, RiotState>,
) -> Result<String, ()> {
    let puuid = match validated_puuid(args.first().and_then(Value::as_str)) {
        Ok(puuid) => puuid,
        Err(error) => {
            return Ok(
                json!({ "success": false, "code": "invalidPlayer", "error": error }).to_string(),
            )
        }
    };

    if let Some(profile) = local_friend_profile(&puuid) {
        return Ok(json!({ "success": true, "puuid": puuid, "profile": profile }).to_string());
    }

    let result = api::with_api(&riot, |api| {
        let puuid = puuid.clone();
        async move {
            let (history_start, history_end) = friend_match_history_indices();
            let (mmr, competitive_updates, history) = tokio::try_join!(
                api.get_mmr(&puuid),
                api.get_competitive_history(&puuid, 0, 15),
                api.get_match_history(&puuid, history_start, history_end),
            )?;
            let raw_current_tier = extract_rank(Some(&mmr)).0;
            let current_season_id = mmr
                .pointer("/LatestCompetitiveUpdate/SeasonID")
                .and_then(Value::as_str)
                .filter(|season_id| !season_id.is_empty());
            let thresholds = if (24..=27).contains(&raw_current_tier) {
                match current_season_id {
                    Some(season_id) => current_leaderboard_thresholds(&api, season_id).await,
                    None => None,
                }
            } else {
                None
            };
            Ok(normalize_friend_profile(
                &mmr,
                &competitive_updates,
                &history,
                thresholds.as_ref(),
            ))
        }
    })
    .await;

    Ok(match result {
        Ok(profile) => json!({ "success": true, "puuid": puuid, "profile": profile }).to_string(),
        Err(error) if error.contains("lockfile") => {
            json!({ "success": false, "code": "loginRequired" }).to_string()
        }
        Err(error) => {
            json!({ "success": false, "code": "unavailable", "error": error }).to_string()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn leaderboard_thresholds_fixture(
        immortal_two: i64,
        immortal_three: i64,
        radiant: i64,
        top_tier: i64,
    ) -> Value {
        json!({
            "tierDetails": {
                "25": {"rankedRatingThreshold": immortal_two},
                "26": {"rankedRatingThreshold": immortal_three},
                "27": {"rankedRatingThreshold": radiant}
            },
            "topTierRRThreshold": top_tier
        })
    }

    #[test]
    fn parses_monotonic_leaderboard_thresholds_and_uses_the_live_radiant_cutoff() {
        let parsed =
            parse_leaderboard_thresholds(&leaderboard_thresholds_fixture(90, 200, 450, 478))
                .expect("valid thresholds");
        assert_eq!(parsed.immortal_two, 90);
        assert_eq!(parsed.immortal_three, 200);
        assert_eq!(parsed.radiant, 478);

        let configured_radiant =
            parse_leaderboard_thresholds(&leaderboard_thresholds_fixture(90, 200, 500, 478))
                .expect("valid thresholds");
        assert_eq!(configured_radiant.radiant, 500);
    }

    #[test]
    fn rejects_missing_negative_and_non_monotonic_leaderboard_thresholds() {
        assert!(parse_leaderboard_thresholds(&json!({})).is_none());
        assert!(
            parse_leaderboard_thresholds(&leaderboard_thresholds_fixture(-1, 200, 450, 478,))
                .is_none()
        );
        assert!(
            parse_leaderboard_thresholds(&leaderboard_thresholds_fixture(220, 200, 450, 478,))
                .is_none()
        );
        assert!(
            parse_leaderboard_thresholds(&leaderboard_thresholds_fixture(90, 500, 450, 478,))
                .is_none()
        );
    }

    #[test]
    fn resolves_only_current_immortal_and_radiant_tiers_from_rr() {
        let thresholds = LeaderboardThresholds {
            immortal_two: 90,
            immortal_three: 200,
            radiant: 450,
        };
        assert_eq!(resolve_current_tier(24, 89, Some(&thresholds)), 24);
        assert_eq!(resolve_current_tier(24, 90, Some(&thresholds)), 25);
        assert_eq!(resolve_current_tier(24, 200, Some(&thresholds)), 26);
        assert_eq!(resolve_current_tier(24, 450, Some(&thresholds)), 27);
        assert_eq!(resolve_current_tier(23, 999, Some(&thresholds)), 23);
        assert_eq!(resolve_current_tier(24, 999, None), 24);
        assert_eq!(resolve_current_tier(27, 0, None), 27);
    }

    #[test]
    fn limits_friend_match_history_to_riot_page_size() {
        assert_eq!(friend_match_history_indices(), (0, 25));
    }

    #[test]
    fn resolves_the_local_fake_player_without_riot_data() {
        let profile = local_friend_profile(crate::fake_player::PUUID)
            .expect("the local fake player must have a local profile");
        assert_eq!(profile["currentTier"], 0);
        assert_eq!(profile["competitiveSeasons"], json!([]));
        assert_eq!(profile["matches"], json!([]));
        assert!(local_friend_profile("real-riot-player").is_none());
    }

    #[test]
    fn normalizes_current_rank_and_competitive_seasons() {
        let mmr = json!({
            "LatestCompetitiveUpdate": {
                "SeasonID": "act-current",
                "TierAfterUpdate": 22,
                "RankedRatingAfterUpdate": 64
            },
            "QueueSkills": {"competitive": {"SeasonalInfoBySeasonID": {
                "act-current": {
                    "CompetitiveTier": 22,
                    "RankedRating": 64,
                    "NumberOfWins": 12,
                    "NumberOfGames": 20,
                    "WinsByTier": {"22": 8, "21": 4}
                },
                "act-old": {
                    "CompetitiveTier": 19,
                    "RankedRating": 31,
                    "NumberOfWins": 7,
                    "NumberOfGames": 15,
                    "WinsByTier": {"18": 2, "19": 5}
                }
            }}}
        });

        let history = json!({"History": [
            {"MatchID": "u1", "GameStartTime": 300, "QueueID": "unrated"},
            {"MatchID": "c1", "GameStartTime": 200, "QueueID": "competitive"},
            {"MatchID": "d1", "GameStartTime": 100, "QueueID": "deathmatch"}
        ]});
        let updates = json!({"Matches": [{
            "MatchID": "c1",
            "TierBeforeUpdate": 21,
            "TierAfterUpdate": 22,
            "RankedRatingAfterUpdate": 64,
            "RankedRatingEarned": 18
        }]});
        let result = normalize_friend_profile(&mmr, &updates, &history, None);
        assert_eq!(result["currentTier"], 22);
        assert_eq!(result["currentRR"], 64);
        assert_eq!(result["currentSeasonId"], "act-current");
        assert_eq!(result["competitiveSeasons"].as_array().unwrap().len(), 2);
        assert_eq!(result["matches"].as_array().unwrap().len(), 3);
        assert_eq!(result["matches"][0]["queueId"], "unrated");
        assert_eq!(result["matches"][1]["rrEarned"], 18);
        assert_eq!(result["matches"][2]["queueId"], "deathmatch");
    }

    #[test]
    fn enriches_only_current_immortal_rank_from_leaderboard_thresholds() {
        let mmr = json!({
            "LatestCompetitiveUpdate": {
                "SeasonID": "act-current",
                "TierAfterUpdate": 24,
                "RankedRatingAfterUpdate": 117
            },
            "QueueSkills": {"competitive": {"SeasonalInfoBySeasonID": {
                "act-current": {
                    "CompetitiveTier": 24,
                    "RankedRating": 117,
                    "NumberOfWins": 20,
                    "NumberOfGames": 30,
                    "WinsByTier": {"26": 1, "24": 19}
                }
            }}}
        });
        let thresholds = LeaderboardThresholds {
            immortal_two: 80,
            immortal_three: 200,
            radiant: 400,
        };
        let enriched = normalize_friend_profile(
            &mmr,
            &json!({"Matches": []}),
            &json!({"History": []}),
            Some(&thresholds),
        );
        assert_eq!(enriched["currentTier"], 25);
        assert_eq!(enriched["currentRR"], 117);
        assert_eq!(enriched["peakTier"], 26);
        assert_eq!(enriched["peakSeasonId"], "act-current");

        let fallback =
            normalize_friend_profile(&mmr, &json!({"Matches": []}), &json!({"History": []}), None);
        assert_eq!(fallback["currentTier"], 24);
        assert_eq!(fallback["peakTier"], 26);
    }

    #[test]
    fn validates_friend_puuid_before_requesting_riot_data() {
        assert!(validated_puuid(None).is_err());
        assert!(validated_puuid(Some("../bad id")).is_err());
        assert_eq!(
            validated_puuid(Some("player-id_123")).unwrap(),
            "player-id_123"
        );
    }
}
