use crate::commands::live::{extract_competitive_seasons, extract_rank};
use crate::riot::api;
use crate::riot::client::RiotState;
use serde_json::{json, Value};
use tauri::State;

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

fn normalize_friend_profile(mmr: &Value, competitive_updates: Value) -> Value {
    let (current_tier, current_rr, peak_tier, peak_season_id) = extract_rank(Some(mmr));
    let (current_season_id, competitive_seasons) = extract_competitive_seasons(Some(mmr));
    json!({
        "currentTier": current_tier,
        "currentRR": current_rr,
        "peakTier": peak_tier,
        "peakSeasonId": peak_season_id,
        "currentSeasonId": current_season_id,
        "competitiveSeasons": competitive_seasons,
        "competitiveUpdates": competitive_updates,
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

    let result = api::with_api(&riot, |api| {
        let puuid = puuid.clone();
        async move {
            let (mmr, competitive_updates) = tokio::try_join!(
                api.get_mmr(&puuid),
                api.get_competitive_history(&puuid, 0, 15),
            )?;
            Ok(normalize_friend_profile(&mmr, competitive_updates))
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

        let result = normalize_friend_profile(&mmr, json!({"Matches": []}));
        assert_eq!(result["currentTier"], 22);
        assert_eq!(result["currentRR"], 64);
        assert_eq!(result["currentSeasonId"], "act-current");
        assert_eq!(result["competitiveSeasons"].as_array().unwrap().len(), 2);
        assert_eq!(result["competitiveUpdates"], json!({"Matches": []}));
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
