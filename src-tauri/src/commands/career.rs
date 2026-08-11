use crate::commands::live::extract_competitive_seasons;
use crate::riot::api::{self};
use crate::riot::client::RiotState;
use serde_json::{json, Value};
use tauri::State;

fn career_match_history_indices() -> (u32, u32) {
    (0, 25)
}

fn career_act_rank(mmr: &Value) -> (Option<String>, Vec<Value>) {
    extract_competitive_seasons(Some(mmr))
}

#[tauri::command]
pub async fn career_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    // `with_api` retries once with fresh tokens if the cached one has been
    // invalidated (expired, or the player switched accounts).
    let result = api::with_api(&riot, |api| async move {
        let puuid = api.puuid.clone();
        let (history_start, history_end) = career_match_history_indices();
        let (mmr, competitive_updates, match_history) = tokio::try_join!(
            api.get_mmr(&puuid),
            api.get_competitive_history(&puuid, 0, 15),
            api.get_match_history(&puuid, history_start, history_end),
        )?;
        Ok((puuid, mmr, competitive_updates, match_history))
    })
    .await;

    Ok(match result {
        Ok((puuid, mmr, competitive_updates, match_history)) => {
            let (current_season_id, competitive_seasons) = career_act_rank(&mmr);
            json!({
                "success": true,
                "puuid": puuid,
                "mmr": mmr,
                "competitiveUpdates": competitive_updates,
                "matchHistory": match_history,
                "currentSeasonId": current_season_id,
                "competitiveSeasons": competitive_seasons,
            })
            .to_string()
        }
        Err(e) if e.contains("lockfile") => {
            json!({ "success": false, "code": "loginRequired" }).to_string()
        }
        Err(e) => json!({ "success": false, "error": e }).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
