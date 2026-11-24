use crate::store::ConfigStore;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The rolling `beta` pre-release that `.github/workflows/beta.yml` replaces on
/// every push to the `beta` branch. `releases/latest` skips pre-releases, so
/// stable installs never see it.
const BETA_ENDPOINT: &str =
    "https://github.com/windowsedd/ValoUtils/releases/download/beta/latest.json";

/// With Beta updates on (`betaUpdates`), the beta release is checked first and
/// the stable one after it, so a stable release newer than the last beta
/// (1.0.18 > 1.0.18-beta.4) still arrives. Off, only the stable endpoint from
/// tauri.conf.json is read.
async fn find_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let beta = app
        .try_state::<ConfigStore>()
        .and_then(|store| store.get("betaUpdates"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if beta {
        match check_beta(app).await {
            Ok(Some(update)) => return Ok(Some(update)),
            Ok(None) => {}
            // No beta published yet (404) or a bad manifest: stable still works.
            Err(error) => log::warn!("updater: beta check failed: {error}"),
        }
    }
    let updater = app.updater().map_err(|error| error.to_string())?;
    updater.check().await.map_err(|error| error.to_string())
}

async fn check_beta(app: &AppHandle) -> Result<Option<Update>, String> {
    let endpoint = Url::parse(BETA_ENDPOINT).map_err(|error| error.to_string())?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

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

    match find_update(app).await {
        Ok(Some(update)) => {
            let _ = app.emit(
                "update:available",
                json!({ "version": update.version }),
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
            let _ = app.emit("update:error", e);
        }
    }
}
