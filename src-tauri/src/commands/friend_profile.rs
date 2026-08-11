use crate::commands::live::{extract_competitive_seasons, extract_rank};
use crate::riot::api;
use crate::riot::client::RiotState;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;

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

fn normalize_friend_profile(mmr: &Value, competitive_updates: &Value, history: &Value) -> Value {
    let (current_tier, current_rr, peak_tier, peak_season_id) = extract_rank(Some(mmr));
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
            Ok(normalize_friend_profile(
                &mmr,
                &competitive_updates,
                &history,
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
        let result = normalize_friend_profile(&mmr, &updates, &history);
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
    fn validates_friend_puuid_before_requesting_riot_data() {
        assert!(validated_puuid(None).is_err());
        assert!(validated_puuid(Some("../bad id")).is_err());
        assert_eq!(
            validated_puuid(Some("player-id_123")).unwrap(),
            "player-id_123"
        );
    }
}
