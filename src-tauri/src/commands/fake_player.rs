use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;

#[tauri::command]
pub async fn fake_player_state() -> Result<Value, ()> {
    Ok(json!({
        "success": true,
        "puuid": crate::fake_player::PUUID,
        "displayName": format!("{}#{}", crate::fake_player::GAME_NAME, crate::fake_player::TAG_LINE),
        "messages": crate::fake_player::transcript(),
        "presence": crate::presence_proxy::controller().snapshot(),
    }))
}

/// Talks to the Dummy Bot from inside the app, without the game: the line runs
/// exactly as a whisper would (`$` presence commands, `.` chat commands) and
/// both sides land in the bot transcript the Dummy Bot page and Chat share.
#[tauri::command]
pub async fn fake_player_send(args: Vec<Value>, app: AppHandle) -> Result<Value, ()> {
    let body = args
        .first()
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if body.is_empty() {
        return Ok(json!({ "success": false, "error": "Message is empty." }));
    }
    crate::fake_player::record_message(&body, true);
    let reply = if body.starts_with('.') {
        match super::riot_chat::run_composer_command(&body, &app, true).await {
            Ok(reply) => reply,
            Err(error) => error,
        }
    } else {
        crate::presence_proxy::apply_command(crate::fake_player::parse_command(&body))
    };
    crate::fake_player::record_message(&reply, false);
    Ok(json!({
        "success": true,
        "reply": reply,
        "messages": crate::fake_player::transcript(),
    }))
}
