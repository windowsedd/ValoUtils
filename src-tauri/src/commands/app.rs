use crate::aptabase;
use crate::store::ConfigStore;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

fn arg(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn open_url(args: Vec<Value>, app: AppHandle) -> String {
    let Some(url) = arg(&args, 0) else {
        return String::new();
    };
    aptabase::track_event(
        "open_url".into(),
        json!({ "url": url }),
        app.package_info().version.to_string(),
    );
    let _ = app.opener().open_url(&url, None::<&str>);
    String::new()
}

#[tauri::command]
pub fn version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn clipboard_get(app: AppHandle) -> String {
    let text = app.clipboard().read_text().unwrap_or_default();
    json!({ "text": text }).to_string()
}

#[tauri::command]
pub fn clipboard_set(args: Vec<Value>, app: AppHandle) -> String {
    let text = arg(&args, 0).unwrap_or_default();
    let _ = app.clipboard().write_text(text);
    let text = app.clipboard().read_text().unwrap_or_default();
    json!({ "text": text }).to_string()
}

#[tauri::command]
pub async fn debug_save_json(args: Vec<Value>, app: AppHandle) -> String {
    use tauri_plugin_dialog::DialogExt;

    let filename = arg(&args, 0).unwrap_or_else(|| "debug.json".into());
    let json_str = arg(&args, 1).unwrap_or_default();

    let file_path = app
        .dialog()
        .file()
        .set_title("Save JSON")
        .set_file_name(&filename)
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    let Some(file_path) = file_path else {
        return json!({ "success": false }).to_string();
    };
    let Some(path) = file_path.as_path() else {
        return json!({ "success": false }).to_string();
    };

    match std::fs::write(path, json_str) {
        Ok(_) => json!({ "success": true, "filePath": path.to_string_lossy() }).to_string(),
        Err(_) => json!({ "success": false }).to_string(),
    }
}

#[tauri::command]
pub fn analytics_track(args: Vec<Value>, app: AppHandle) -> String {
    let Some(event) = arg(&args, 0) else {
        return String::new();
    };
    let data = args
        .get(1)
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or(Value::Null);
    aptabase::track_event(event, data, app.package_info().version.to_string());
    String::new()
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> String {
    crate::updater::check_for_updates(&app, false).await;
    String::new()
}

#[tauri::command]
pub fn config_get_all(store: State<ConfigStore>) -> String {
    let get_or = |key: &str, default: Value| store.get(key).unwrap_or(default);
    json!({
        "autoUpdate": get_or("autoUpdate", json!(true)),
        "openDevTools": get_or("openDevTools", json!(false)),
        // Every key the frontend reads has to be listed here — this is an
        // allowlist, not a passthrough of the whole store.
        "presenceEnabled": get_or("presenceEnabled", json!(true)),
        "presenceMode": get_or("presenceMode", json!("offline")),
        "presenceStartup": get_or("presenceStartup", json!("last")),
        "presenceMucEnabled": get_or("presenceMucEnabled", json!(true)),
        "translatorProvider": get_or("translatorProvider", json!("google")),
        "translatorTargetLanguage": get_or("translatorTargetLanguage", json!("en")),
        "deeplApiKey": get_or("deeplApiKey", json!("")),
    })
    .to_string()
}

#[tauri::command]
pub fn config_set(args: Vec<Value>, store: State<ConfigStore>) -> String {
    let Some(key) = arg(&args, 0) else {
        return json!({ "success": false }).to_string();
    };
    let value = args.get(1).cloned().unwrap_or(Value::Null);
    store.set(&key, value);
    json!({ "success": true, "key": key }).to_string()
}
