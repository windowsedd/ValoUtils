use crate::riot::api::{self};
use crate::riot::client::RiotState;
use serde_json::json;
use tauri::State;

#[tauri::command]
pub async fn career_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    let api = match api::create_api(&riot).await {
        Ok(api) => api,
        Err(_) => return Ok(json!({ "success": false, "code": "loginRequired" }).to_string()),
    };

    let mmr = api.get_mmr(&api.puuid).await;
    let competitive_updates = api.get_competitive_history(&api.puuid, 0, 15).await;

    match (mmr, competitive_updates) {
        (Ok(mmr), Ok(competitive_updates)) => Ok(json!({
            "success": true,
            "mmr": mmr,
            "competitiveUpdates": competitive_updates,
        })
        .to_string()),
        (Err(e), _) | (_, Err(e)) => Ok(json!({ "success": false, "error": e }).to_string()),
    }
}
