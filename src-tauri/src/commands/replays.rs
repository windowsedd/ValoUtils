use crate::riot::api;
use crate::riot::client::RiotState;
use crate::store::user_data_dir;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

fn arg(args: &[Value], index: usize) -> Option<String> {
    args.get(index).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn demos_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let userprofile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".into());
            PathBuf::from(userprofile).join("AppData").join("Local")
        });
    base.join("VALORANT").join("Saved").join("Demos")
}

fn output_dir(vrf_path: &str) -> PathBuf {
    let name = Path::new(vrf_path).file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    user_data_dir().join("replay-output").join(name)
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

const CACHE_FILES: [&str; 4] = ["positions.json", "events.json", "meta.json", "abilities.json"];

/// A degenerate `positions.json` (zero samples) is a few hundred bytes; a real
/// one is tens of MB. The cheap check below uses this as a stand-in for "has
/// samples" so it doesn't have to parse the file just to render the list.
const MIN_POSITIONS_BYTES: u64 = 4096;

fn cache_files_exist(out_dir: &Path) -> bool {
    CACHE_FILES.iter().all(|name| out_dir.join(name).exists())
}

/// Cheap "is this cached?" check for `replay_list`.
///
/// The strict check below parses `positions.json`, which is routinely 70+ MB —
/// far too expensive to run for every replay just to draw a "cached" badge.
/// This one only stats `positions.json` and parses the ~100-byte `meta.json`.
/// A false positive is self-correcting: `replay_process` re-runs the strict
/// check and reprocesses the replay if the cache turns out to be unusable.
fn is_processed_quick(out_dir: &Path) -> bool {
    if !cache_files_exist(out_dir) {
        return false;
    }
    let big_enough = std::fs::metadata(out_dir.join("positions.json"))
        .map(|m| m.len() >= MIN_POSITIONS_BYTES)
        .unwrap_or(false);
    let has_map_url = read_json(&out_dir.join("meta.json"))
        .and_then(|meta| meta.get("mapUrl").and_then(|v| v.as_str()).map(|s| !s.is_empty()))
        .unwrap_or(false);
    big_enough && has_map_url
}

/// Strict check — parses `positions.json`. Only call this when about to read the
/// cache anyway (`replay_process`, `replay_export_raw`), never in a loop.
fn is_already_processed(out_dir: &Path) -> bool {
    if !cache_files_exist(out_dir) {
        return false;
    }
    let Some(positions) = read_json(&out_dir.join("positions.json")) else { return false };
    let Some(meta) = read_json(&out_dir.join("meta.json")) else { return false };
    let has_samples = positions.get("samples").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
    let has_map_url = meta.get("mapUrl").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
    has_samples && has_map_url
}

/// Async so Tauri runs it on the async runtime instead of the main (UI) thread,
/// and the directory walk itself goes to the blocking pool — scanning the demos
/// folder plus stat-ing each replay's cache is enough I/O to stutter the WebView.
#[tauri::command]
pub async fn replay_list() -> String {
    tokio::task::spawn_blocking(list_replays_blocking)
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }).to_string())
}

fn list_replays_blocking() -> String {
    let dir = demos_dir();
    if !dir.exists() {
        return json!({ "success": true, "files": [], "demosDir": dir.to_string_lossy() }).to_string();
    }

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return json!({ "success": true, "files": [], "demosDir": dir.to_string_lossy() }).to_string();
    };

    let mut files: Vec<Value> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file() && e.file_name().to_string_lossy().to_lowercase().ends_with(".vrf"))
        .filter_map(|e| {
            let path = e.path();
            let metadata = std::fs::metadata(&path).ok()?;
            let modified = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
            Some(json!({
                "name": e.file_name().to_string_lossy(),
                "path": path.to_string_lossy(),
                "size": metadata.len(),
                "modified": modified,
                "processed": is_processed_quick(&output_dir(&path.to_string_lossy())),
            }))
        })
        .collect();
    files.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));

    json!({ "success": true, "files": files, "demosDir": dir.to_string_lossy() }).to_string()
}

/// Async for the same reason as `replay_list`: deleting a replay also removes its
/// cache directory, which can be 70+ MB and stalls the UI thread if done inline.
#[tauri::command]
pub async fn replay_delete(args: Vec<Value>) -> String {
    tokio::task::spawn_blocking(move || delete_replay_blocking(args))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }).to_string())
}

fn delete_replay_blocking(args: Vec<Value>) -> String {
    let Some(vrf_path) = arg(&args, 0) else { return json!({ "success": false }).to_string() };
    if let Err(e) = std::fs::remove_file(&vrf_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return json!({ "success": false, "error": e.to_string() }).to_string();
        }
    }
    let out_dir = output_dir(&vrf_path);
    if out_dir.exists() {
        let _ = std::fs::remove_dir_all(&out_dir);
    }
    json!({ "success": true, "path": vrf_path }).to_string()
}

#[tauri::command]
pub async fn replay_export_json(args: Vec<Value>, app: AppHandle) -> Result<String, ()> {
    use tauri_plugin_dialog::DialogExt;
    let json_str = arg(&args, 0).unwrap_or_default();
    let default_name = arg(&args, 1).unwrap_or_else(|| "replay.json".into());

    let file_path = app
        .dialog()
        .file()
        .set_title("Export Replay JSON")
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    let Some(path) = file_path.and_then(|p| p.as_path().map(|p| p.to_path_buf())) else {
        return Ok(json!({ "success": false, "canceled": true }).to_string());
    };
    Ok(match std::fs::write(&path, json_str) {
        Ok(_) => json!({ "success": true }).to_string(),
        Err(e) => json!({ "success": false, "error": e.to_string() }).to_string(),
    })
}

#[tauri::command]
pub async fn replay_export_raw(args: Vec<Value>, app: AppHandle) -> Result<String, ()> {
    use tauri_plugin_dialog::DialogExt;
    let Some(vrf_path) = arg(&args, 0) else { return Ok(json!({ "success": false }).to_string()) };
    let out_dir = output_dir(&vrf_path);
    if !is_already_processed(&out_dir) {
        return Ok(json!({ "success": false, "error": "Replay not processed yet — watch it first to generate the cache." }).to_string());
    }

    let base_name = Path::new(&vrf_path).file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    let data = json!({
        "id": base_name,
        "meta": read_json(&out_dir.join("meta.json")),
        "positions": read_json(&out_dir.join("positions.json")),
        "events": read_json(&out_dir.join("events.json")),
        "abilities": read_json(&out_dir.join("abilities.json")).unwrap_or(json!([])),
        "matchDetails": read_json(&out_dir.join("match-details.json")),
    });

    let file_path = app
        .dialog()
        .file()
        .set_title("Export Replay JSON")
        .set_file_name(format!("{base_name}.json"))
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    let Some(path) = file_path.and_then(|p| p.as_path().map(|p| p.to_path_buf())) else {
        return Ok(json!({ "success": false, "canceled": true }).to_string());
    };
    let json_str = serde_json::to_string_pretty(&data).unwrap_or_default();
    Ok(match std::fs::write(&path, json_str) {
        Ok(_) => json!({ "success": true }).to_string(),
        Err(e) => json!({ "success": false, "error": e.to_string() }).to_string(),
    })
}

/// Runs the in-process `replay` module (`src-tauri/src/replay/`, a Rust
/// port of `@windowsedd/valo-replay-parser` + `sidecar/replay/extract.ts` +
/// `abilities.ts` — see that module for the Oodle Kraken decompression and
/// Unreal replication parsing this replaces). This is CPU-heavy synchronous
/// work, so it runs on the blocking thread pool via `spawn_blocking` rather
/// than the sidecar subprocess the old `sidecar/replay-parser.ts` used.
/// Progress is coarse (5 phases) since there's no longer a subprocess stdout
/// stream to relay per-chunk updates from.
async fn run_replay_worker(app: &AppHandle, vrf_path: &str, out_dir: &Path) -> Result<(), String> {
    let bytes = std::fs::read(vrf_path).map_err(|e| e.to_string())?;
    let out_dir = out_dir.to_path_buf();
    let source_label = Path::new(vrf_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let app_clone = app.clone();
    let vrf_path_owned = vrf_path.to_string();

    let _ = app.emit(
        "replay:progress",
        json!({ "path": vrf_path, "status": "reading", "message": "Reading replay file..." }).to_string(),
    );

    tokio::task::spawn_blocking(move || {
        crate::replay::process_replay_file(&bytes, &out_dir, &source_label, |status, message| {
            let _ = app_clone.emit(
                "replay:progress",
                json!({ "path": vrf_path_owned, "status": status, "message": message }).to_string(),
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn read_or_fetch_match_details(riot: &RiotState, vrf_path: &str, out_dir: &Path) -> Option<Value> {
    let match_details_path = out_dir.join("match-details.json");
    if let Some(cached) = read_json(&match_details_path) {
        return Some(cached);
    }

    let match_id = Path::new(vrf_path).file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    let is_uuid_like = match_id.len() == 36 && match_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !is_uuid_like {
        return None;
    }

    let api = api::create_api(riot).await.ok()?;
    let details = api.get_match_details(match_id).await.ok()?;
    let _ = std::fs::write(&match_details_path, details.to_string());
    Some(details)
}

#[tauri::command]
pub async fn replay_process(args: Vec<Value>, app: AppHandle, riot: State<'_, RiotState>) -> Result<String, ()> {
    let Some(vrf_path) = arg(&args, 0) else { return Ok(json!({ "success": false }).to_string()) };
    let out_dir = output_dir(&vrf_path);

    if !is_already_processed(&out_dir) {
        if let Err(e) = run_replay_worker(&app, &vrf_path, &out_dir).await {
            return Ok(json!({ "success": false, "path": vrf_path, "error": e }).to_string());
        }
    }

    let positions = read_json(&out_dir.join("positions.json"));
    let events = read_json(&out_dir.join("events.json"));
    let meta = read_json(&out_dir.join("meta.json"));
    let abilities = read_json(&out_dir.join("abilities.json")).unwrap_or(json!([]));
    let match_details = read_or_fetch_match_details(&riot, &vrf_path, &out_dir).await;

    Ok(json!({
        "success": true,
        "path": vrf_path,
        "positions": positions,
        "events": events,
        "meta": meta,
        "abilities": abilities,
        "matchDetails": match_details,
    })
    .to_string())
}
