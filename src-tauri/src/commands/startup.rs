use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::Path;

fn startup_command(executable: &Path) -> OsString {
    let mut command = OsString::from("\"");
    command.push(executable);
    command.push("\"");
    command
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::io::ErrorKind;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const ENTRY: &str = "ValoUtils";

    pub fn is_enabled() -> Result<bool, String> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let key = match user.open_subkey_with_flags(RUN_KEY, KEY_READ) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        match key.get_value::<OsString, _>(ENTRY) {
            Ok(command) => Ok(!command.is_empty()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        if enabled {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let (key, _) = user
                .create_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
                .map_err(|error| error.to_string())?;
            key.set_value(ENTRY, &startup_command(&executable))
                .map_err(|error| error.to_string())
        } else {
            let key = match user.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE) {
                Ok(key) => key,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.to_string()),
            };
            match key.delete_value(ENTRY) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn is_enabled() -> Result<bool, String> {
        Err("Opening at startup is only supported on Windows.".into())
    }

    pub fn set_enabled(_: bool) -> Result<(), String> {
        Err("Opening at startup is only supported on Windows.".into())
    }
}

fn set_startup(args: &[Value], apply: impl FnOnce(bool) -> Result<(), String>) -> Value {
    let Some(enabled) = args.first().and_then(Value::as_bool) else {
        return json!({ "success": false, "error": "Startup requires a boolean value." });
    };
    match apply(enabled) {
        Ok(()) => {
            log::info!(
                "Open at startup: {}",
                if enabled { "enabled" } else { "disabled" }
            );
            json!({ "success": true, "enabled": enabled })
        }
        Err(error) => json!({ "success": false, "error": error }),
    }
}

#[tauri::command]
pub fn startup_get() -> String {
    match platform::is_enabled() {
        Ok(enabled) => json!({ "success": true, "enabled": enabled }),
        Err(error) => json!({ "success": false, "error": error }),
    }
    .to_string()
}

#[tauri::command]
pub fn startup_set(args: Vec<Value>) -> String {
    set_startup(&args, platform::set_enabled).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_command_quotes_paths_with_spaces_and_unicode() {
        assert_eq!(
            startup_command(Path::new(r"C:\Users\玩家\My Apps\ValoUtils.exe")),
            OsString::from(r#""C:\Users\玩家\My Apps\ValoUtils.exe""#)
        );
    }

    #[test]
    fn startup_set_applies_both_enable_and_disable() {
        for enabled in [true, false] {
            let mut applied = None;
            let response = set_startup(&[json!(enabled)], |value| {
                applied = Some(value);
                Ok(())
            });
            assert_eq!(applied, Some(enabled));
            assert_eq!(response, json!({ "success": true, "enabled": enabled }));
        }
    }

    #[test]
    fn startup_set_rejects_invalid_values_without_changing_windows() {
        for args in [
            vec![],
            vec![Value::Null],
            vec![json!("true")],
            vec![json!(1)],
        ] {
            let response = set_startup(&args, |_| panic!("must not change startup"));
            assert_eq!(response["success"], false);
            assert!(response["error"].is_string());
        }
    }

    #[test]
    fn startup_set_returns_registration_errors_instead_of_success() {
        let response = set_startup(&[json!(true)], |_| Err("Access denied".into()));
        assert_eq!(
            response,
            json!({ "success": false, "error": "Access denied" })
        );
        assert!(response.get("enabled").is_none());
    }
}
