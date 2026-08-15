use crate::presence_proxy::PresenceMode;
use crate::store::ConfigStore;
use serde_json::json;
use serde_json::Value;
use tauri::State;

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
        _ => Err(
            "Presence action must be online, offline, mobile, enable, disable, muc, or startup."
                .into(),
        ),
    };
    if let Err(error) = result {
        return Ok(json!({ "success": false, "error": error }).to_string());
    }
    Ok(response())
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
