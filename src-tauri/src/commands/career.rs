use crate::riot::api::{self};
use crate::riot::client::RiotState;
use serde_json::json;
use tauri::State;

#[tauri::command]
pub async fn career_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    // `with_api` retries once with fresh tokens if the cached one has been
    // invalidated (expired, or the player switched accounts).
    let result = api::with_api(&riot, |api| async move {
        let mmr = api.get_mmr(&api.puuid).await?;
        let competitive_updates = api.get_competitive_history(&api.puuid, 0, 15).await?;
        Ok((mmr, competitive_updates))
    })
    .await;

    Ok(match result {
        Ok((mmr, competitive_updates)) => json!({
            "success": true,
            "mmr": mmr,
            "competitiveUpdates": competitive_updates,
        })
        .to_string(),
        Err(e) if e.contains("lockfile") => json!({ "success": false, "code": "loginRequired" }).to_string(),
        Err(e) => json!({ "success": false, "error": e }).to_string(),
    })
}
