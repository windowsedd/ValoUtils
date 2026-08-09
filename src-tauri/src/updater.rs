use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Mirrors electron/main.ts's autoUpdater event wiring
/// (checking/available/not-available/error/download-progress/downloaded),
/// re-emitted as the same `update:*` channel names plus `alert:info` toasts
/// so the existing renderer code (About.tsx, alert-container.tsx) needs no
/// changes.
/// `silent` suppresses the progress chatter ("Checking for updates…", "No
/// updates available.") for the automatic startup + hourly checks — those fire
/// regardless of what the user is doing, and a toast that pops over the UI to
/// report that nothing happened is pure noise. The manual check from About
/// passes `false`, since there the user asked and expects feedback.
/// Toasts about an update actually being found are always shown.
pub async fn check_for_updates(app: &AppHandle, silent: bool) {
    let _ = app.emit("update:checking", ());
    if !silent {
        let _ = app.emit("alert:info", "Checking for updates...");
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            let _ = app.emit("update:error", e.to_string());
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let _ = app.emit(
                "update:available",
                json!({ "version": update.version }).to_string(),
            );
            let _ = app.emit("alert:info", "Update available, downloading...");
            crate::aptabase::track_event(
                "update_downloading".into(),
                json!({}),
                app.package_info().version.to_string(),
            );

            let app_progress = app.clone();
            let result = update
                .download_and_install(
                    move |_chunk_len, _content_len| {
                        let _ = app_progress.emit("update:download-progress", ());
                    },
                    || {},
                )
                .await;

            match result {
                Ok(_) => {
                    let _ = app.emit("update:downloaded", ());
                    let _ = app.emit(
                        "alert:info",
                        "Successfully downloaded update. Restarting...",
                    );
                    app.request_restart();
                }
                Err(e) => {
                    let _ = app.emit("update:error", e.to_string());
                }
            }
        }
        Ok(None) => {
            let _ = app.emit("update:not-available", ());
            if !silent {
                let _ = app.emit("alert:info", "No updates available.");
            }
        }
        Err(e) => {
            let _ = app.emit("update:error", e.to_string());
        }
    }
}
