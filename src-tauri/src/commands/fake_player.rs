use serde_json::json;

#[tauri::command]
pub async fn fake_player_state() -> Result<String, ()> {
    Ok(json!({
        "success": true,
        "puuid": crate::fake_player::PUUID,
        "displayName": format!("{}#{}", crate::fake_player::GAME_NAME, crate::fake_player::TAG_LINE),
        "messages": crate::fake_player::transcript(),
        "presence": crate::presence_proxy::controller().snapshot(),
    }).to_string())
}
