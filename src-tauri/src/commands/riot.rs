use serde_json::Value;
use crate::riot::client::{self, RiotState};
use serde_json::json;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn client_info_get(riot: State<RiotState>) -> Value {
    match client::get_riot_client_info(&riot) {
        Ok(info) => json!(info),
        Err(e) => json!({ "error": e, "code": e.code() }),
    }
}

#[tauri::command]
pub async fn tokens_get(riot: State<'_, RiotState>) -> Result<Value, ()> {
    Ok(match client::get_tokens(&riot, false).await {
        Ok(tokens) => tokens,
        Err(e) => json!({ "error": e, "code": e.code() }),
    })
}

#[tauri::command]
pub async fn tokens_refresh(riot: State<'_, RiotState>) -> Result<Value, ()> {
    Ok(match client::get_tokens(&riot, true).await {
        Ok(tokens) => tokens,
        Err(e) => json!({ "error": e, "code": e.code() }),
    })
}

#[tauri::command]
pub async fn userinfo_get(riot: State<'_, RiotState>) -> Result<Value, ()> {
    Ok(match client::get_user_info(&riot).await {
        Ok(info) => info,
        Err(e) => json!({ "error": e, "code": e.code() }),
    })
}

#[tauri::command]
pub async fn swagger_spec_get(riot: State<'_, RiotState>) -> Result<Value, ()> {
    Ok(match client::swagger_spec(&riot).await {
        Ok(spec) => json!({ "success": true, "spec": spec }),
        Err(e) => json!({ "success": false, "error": e }),
    })
}

/// Start the localhost docs host (see `api_docs`) if needed and open it in the
/// system browser. The spec is served from `/openapi.json` rather than written
/// into a temp file, so the browser refetches it live on every reload.
#[tauri::command]
pub async fn swagger_open(app: AppHandle) -> Result<Value, ()> {
    // Fail early with a useful message if the Riot Client isn't up, instead of
    // opening a browser onto a page that can only render an error.
    {
        let riot = app.state::<RiotState>();
        if let Err(e) = client::swagger_spec(&riot).await {
            return Ok(json!({ "success": false, "error": e }));
        }
    }

    let base_url = match crate::api_docs::ensure_running(&app).await {
        Ok(url) => url,
        Err(e) => return Ok(json!({ "success": false, "error": e })),
    };
    let _ = app.opener().open_url(&base_url, None::<&str>);
    Ok(json!({ "success": true, "url": base_url }))
}
