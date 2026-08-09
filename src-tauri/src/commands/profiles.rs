use crate::riot::client::RiotState;
use crate::riot::settings;
use crate::settings_decoder;
use crate::share;
use crate::store::{ProfilesStore, Store};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

fn arg(args: &[Value], index: usize) -> Option<String> {
    args.get(index)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn get_profiles(store: &Store) -> Vec<Value> {
    store
        .get("profiles")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn set_profiles(store: &Store, profiles: &[Value]) {
    store.set("profiles", json!(profiles));
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn profile_list_payload(profiles: &[Value]) -> String {
    json!({ "profiles": profiles, "success": true }).to_string()
}

/// Every profile-mutating command also refreshes any `settings:profile:list`
/// listeners, matching the Electron IPC handlers which pushed to both the
/// mutation's own channel and the list channel on every change.
fn emit_profile_list(app: &AppHandle, profiles: &[Value]) {
    let _ = app.emit("settings:profile:list", profile_list_payload(profiles));
}

#[tauri::command]
pub async fn settings_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    let tokens = match crate::riot::client::get_tokens(&riot, false).await {
        Ok(t) => t,
        Err(e) => return Ok(json!({ "error": e }).to_string()),
    };
    Ok(match settings::get_preferences(&tokens).await {
        Ok(prefs) => prefs.to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    })
}

#[tauri::command]
pub fn settings_profile_list(store: State<ProfilesStore>) -> String {
    profile_list_payload(&get_profiles(&store))
}

#[tauri::command]
pub async fn settings_profile_add(
    args: Vec<Value>,
    app: AppHandle,
    store: State<'_, ProfilesStore>,
    riot: State<'_, RiotState>,
) -> Result<String, ()> {
    let profile_source = arg(&args, 0).unwrap_or_default();
    let name = format!("Profile {}", chrono_like_now());

    let mut profiles = get_profiles(&store);
    let data =
        if profile_source == "current" {
            let tokens = match crate::riot::client::get_tokens(&riot, false).await {
                Ok(t) => t,
                Err(e) => {
                    return Ok(json!({ "error": e, "profiles": profiles }).to_string());
                }
            };
            match settings::get_preferences(&tokens).await {
                Ok(prefs) => match prefs.get("data").and_then(|v| v.as_str()) {
                    Some(d) => d.to_string(),
                    None => return Ok(
                        json!({ "error": "malformed preferences response", "profiles": profiles })
                            .to_string(),
                    ),
                },
                Err(e) => return Ok(json!({ "error": e, "profiles": profiles }).to_string()),
            }
        } else if profile_source == "clipboard" {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            app.clipboard().read_text().unwrap_or_default()
        } else {
            profile_source
        };

    let created = now_millis();
    profiles.push(json!({ "name": name, "data": data, "created": created, "updated": created }));
    set_profiles(&store, &profiles);
    emit_profile_list(&app, &profiles);
    Ok(profile_list_payload(&profiles))
}

#[tauri::command]
pub fn settings_profile_remove(
    args: Vec<Value>,
    app: AppHandle,
    store: State<ProfilesStore>,
) -> String {
    let name = arg(&args, 0).unwrap_or_default();
    let profiles = get_profiles(&store);
    let new_profiles: Vec<Value> = profiles
        .into_iter()
        .filter(|p| p.get("name").and_then(|v| v.as_str()) != Some(name.as_str()))
        .collect();
    set_profiles(&store, &new_profiles);
    emit_profile_list(&app, &new_profiles);
    profile_list_payload(&new_profiles)
}

#[tauri::command]
pub fn settings_profile_rename(
    args: Vec<Value>,
    app: AppHandle,
    store: State<ProfilesStore>,
) -> String {
    let name = arg(&args, 0).unwrap_or_default();
    let new_name = arg(&args, 1).unwrap_or_default();
    let mut profiles = get_profiles(&store);

    for p in profiles.iter_mut() {
        if p.get("name").and_then(|v| v.as_str()) == Some(name.as_str()) {
            p["name"] = json!(new_name);
            p["updated"] = json!(now_millis());
        }
    }

    let names: Vec<&str> = profiles
        .iter()
        .filter_map(|p| p.get("name").and_then(|v| v.as_str()))
        .collect();
    let has_duplicates = names
        .iter()
        .enumerate()
        .any(|(i, n)| names[..i].contains(n));
    if has_duplicates {
        return json!({ "error": "Duplicate names", "profiles": profiles, "success": false })
            .to_string();
    }

    set_profiles(&store, &profiles);
    emit_profile_list(&app, &profiles);
    profile_list_payload(&profiles)
}

#[tauri::command]
pub fn settings_profile_duplicate(
    args: Vec<Value>,
    app: AppHandle,
    store: State<ProfilesStore>,
) -> String {
    let name = arg(&args, 0).unwrap_or_default();
    let mut profiles = get_profiles(&store);
    let Some(profile) = profiles
        .iter()
        .find(|p| p.get("name").and_then(|v| v.as_str()) == Some(name.as_str()))
        .cloned()
    else {
        return json!({ "error": "Profile not found", "success": false }).to_string();
    };

    let existing_names: Vec<String> = profiles
        .iter()
        .filter_map(|p| {
            p.get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();
    let mut new_name = format!("{name} (copy)");
    let mut copy_index = 2;
    while existing_names.contains(&new_name) {
        new_name = format!("{name} (copy {copy_index})");
        copy_index += 1;
    }

    let now = now_millis();
    profiles.push(json!({
        "name": new_name,
        "data": profile.get("data").cloned().unwrap_or(Value::Null),
        "created": now,
        "updated": now,
    }));
    set_profiles(&store, &profiles);
    emit_profile_list(&app, &profiles);
    profile_list_payload(&profiles)
}

#[tauri::command]
pub async fn settings_profile_load(
    args: Vec<Value>,
    store: State<'_, ProfilesStore>,
    riot: State<'_, RiotState>,
) -> Result<String, ()> {
    let name = arg(&args, 0).unwrap_or_default();
    let profiles = get_profiles(&store);
    let Some(profile) = profiles
        .iter()
        .find(|p| p.get("name").and_then(|v| v.as_str()) == Some(name.as_str()))
    else {
        return Ok(json!({ "error": "Profile not found", "success": false }).to_string());
    };
    let data = profile
        .get("data")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let tokens = match crate::riot::client::get_tokens(&riot, false).await {
        Ok(t) => t,
        Err(e) => return Ok(json!({ "error": e, "success": false }).to_string()),
    };
    match settings::load_settings(&tokens, data).await {
        Ok(res) => Ok(json!({ "success": true, "data": res }).to_string()),
        Err(e) => Ok(json!({ "error": e, "success": false }).to_string()),
    }
}

#[tauri::command]
pub fn settings_profile_view(args: Vec<Value>, store: State<ProfilesStore>) -> String {
    let name = arg(&args, 0).unwrap_or_default();
    let profiles = get_profiles(&store);
    let Some(profile) = profiles
        .iter()
        .find(|p| p.get("name").and_then(|v| v.as_str()) == Some(name.as_str()))
    else {
        return json!({ "error": "Profile not found", "success": false }).to_string();
    };
    let data = profile
        .get("data")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    view_settings_blob(data)
}

#[tauri::command]
pub async fn settings_current_view(riot: State<'_, RiotState>) -> Result<String, ()> {
    let tokens = match crate::riot::client::get_tokens(&riot, false).await {
        Ok(t) => t,
        Err(e) => return Ok(json!({ "error": e, "success": false }).to_string()),
    };
    let prefs = match settings::get_preferences(&tokens).await {
        Ok(p) => p,
        Err(e) => return Ok(json!({ "error": e, "success": false }).to_string()),
    };
    let data = prefs
        .get("data")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    Ok(view_settings_blob(data))
}

fn view_settings_blob(data: &str) -> String {
    match settings_decoder::decode_profile_data(data) {
        Ok(decoded) => {
            let crosshairs = settings_decoder::extract_crosshair_profiles(&decoded);
            json!({ "success": true, "settings": decoded, "crosshairs": crosshairs }).to_string()
        }
        Err(e) => json!({ "error": e, "success": false }).to_string(),
    }
}

#[tauri::command]
pub async fn settings_profile_share(
    args: Vec<Value>,
    store: State<'_, ProfilesStore>,
) -> Result<String, ()> {
    let name = arg(&args, 0).unwrap_or_default();
    let profiles = get_profiles(&store);
    let Some(profile) = profiles
        .iter()
        .find(|p| p.get("name").and_then(|v| v.as_str()) == Some(name.as_str()))
    else {
        return Ok(json!({ "error": "Profile not found", "success": false }).to_string());
    };
    let data = profile
        .get("data")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    match share::save_data(data).await {
        Ok(code) => Ok(json!({ "code": code, "success": true }).to_string()),
        Err(e) => Ok(json!({ "error": e, "success": false }).to_string()),
    }
}

/// Fetch a shared profile blob by its pastes.dev code. Called directly by
/// the renderer (SettingsProfiles.tsx "import from share code" flow), which
/// previously imported the Electron share util straight into the bundle.
#[tauri::command]
pub async fn share_get_data(args: Vec<Value>) -> Result<String, String> {
    let id = arg(&args, 0).ok_or("missing share code")?;
    share::get_data(&id).await
}

/// `"Profile " + new Date().toLocaleString()` used a locale-formatted
/// timestamp only to generate a unique-ish default name; an ISO-like
/// stand-in is fine here since it's never parsed back.
fn chrono_like_now() -> String {
    let (y, m, d, h, mi, s) = crate::util_time::civil_from_unix_secs(now_millis() / 1000);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}
