use crate::presence_proxy::PresenceMode;
use crate::store::ConfigStore;
use serde_json::json;
use serde_json::Value;
use tauri::{AppHandle, State};

fn mode_arg(args: &[Value]) -> Result<PresenceMode, String> {
    args.first()
        .and_then(Value::as_str)
        .and_then(PresenceMode::parse)
        .ok_or_else(|| "Presence mode must be online, offline, or mobile.".to_string())
}

fn response() -> String {
    json!({
        "success": true,
        "configRunning": crate::client_config::is_running(),
        "presence": crate::presence_proxy::controller().snapshot(),
    })
    .to_string()
}

#[tauri::command]
pub async fn presence_status_get() -> Result<String, ()> {
    Ok(response())
}

#[tauri::command]
pub async fn presence_status_set(
    args: Vec<Value>,
    config: State<'_, ConfigStore>,
) -> Result<String, ()> {
    let action = args
        .first()
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let result = match action.as_str() {
        "online" | "offline" | "mobile" => {
            crate::presence_proxy::change_mode(mode_arg(&args).unwrap());
            Ok(())
        }
        "enable" => {
            crate::presence_proxy::change_enabled(true);
            Ok(())
        }
        "disable" => {
            crate::presence_proxy::change_enabled(false);
            Ok(())
        }
        "muc" => args
            .get(1)
            .and_then(Value::as_bool)
            .map(|value| crate::presence_proxy::change_connect_to_muc(value))
            .ok_or_else(|| "MUC requires a boolean second argument.".to_string()),
        "startup" => {
            let value = args
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if value == "last" || PresenceMode::parse(&value).is_some() {
                config.set("presenceStartup", json!(value));
                Ok(())
            } else {
                Err("Startup must be online, offline, mobile, or last.".into())
            }
        }
        "cert" => {
            let id = args
                .get(1)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            crate::presence_proxy::change_cert(&id).await
        }
        _ => Err(
            "Presence action must be online, offline, mobile, enable, disable, muc, startup, or cert."
                .into(),
        ),
    };
    if let Err(error) = result {
        return Ok(json!({ "success": false, "error": error }).to_string());
    }
    Ok(response())
}

/// Opens a native file picker, validates the chosen PFX against the requested
/// identity's chat host, and installs it as that identity's cached
/// certificate. Reports the leaf expiry (Unix seconds) on success. When the
/// imported identity is the selected one, a running relay is restarted so the
/// new certificate goes live.
#[tauri::command]
pub async fn presence_cert_import(args: Vec<Value>, app: AppHandle) -> Result<String, ()> {
    use tauri_plugin_dialog::DialogExt;

    let id = args.first().and_then(Value::as_str).unwrap_or("");
    let identity = crate::chat_certs::by_id(id)
        .unwrap_or_else(|| crate::presence_proxy::controller().cert());

    let picked = app
        .dialog()
        .file()
        .set_title("Import chat certificate (PFX)")
        .add_filter("PFX certificate", &["pfx"])
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(json!({ "success": false, "cancelled": true }).to_string());
    };
    let Some(path) = file_path.as_path() else {
        return Ok(
            json!({ "success": false, "error": "The selected file path is not usable." })
                .to_string(),
        );
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Ok(json!({
                "success": false,
                "error": format!("Could not read the PFX file: {error}"),
            })
            .to_string())
        }
    };

    match crate::presence_proxy::import_pfx(&bytes, identity) {
        Ok(expires_at) => {
            if crate::presence_proxy::controller().cert().id == identity.id {
                if let Err(error) = crate::presence_proxy::reload_relay_certificate().await {
                    crate::presence_proxy::controller().set_warning(Some(error));
                }
            }
            crate::presence_proxy::notify_status_changed();
            Ok(json!({
                "success": true,
                "certId": identity.id,
                "certHost": identity.host,
                "expiresAt": expires_at,
            })
            .to_string())
        }
        Err(error) => Ok(json!({ "success": false, "error": error }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_a_supported_mode_from_command_args() {
        assert_eq!(mode_arg(&[json!("mobile")]), Ok(PresenceMode::Mobile));
    }

    #[test]
    fn rejects_missing_or_unknown_modes() {
        assert!(mode_arg(&[]).is_err());
        assert!(mode_arg(&[json!("away")]).is_err());
    }
}
