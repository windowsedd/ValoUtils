//! Relaunching the Riot Client against the local client-config server.
//!
//! `--client-config-url` is only read at process start, so a client that is
//! already running cannot be repointed — it has to be closed first. Launching
//! the exe while one is alive just focuses the existing window and silently
//! drops the flags, which looks like the feature doing nothing.

use crate::{client_config, presence_proxy};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

const INSTALLS_JSON: &str = r"C:\ProgramData\Riot Games\RiotClientInstalls.json";
const FALLBACK_EXE: &str = r"C:\Riot Games\Riot Client\RiotClientServices.exe";

fn launch_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Resolves RiotClientServices.exe from Riot's own install manifest, falling
/// back to the default location. Riot writes forward slashes in this file;
/// `PathBuf` handles them fine on Windows.
fn riot_client_exe() -> Result<PathBuf, String> {
    let manifest = std::fs::read_to_string(INSTALLS_JSON)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());

    if let Some(manifest) = manifest {
        for key in ["rc_live", "rc_default"] {
            if let Some(path) = manifest.get(key).and_then(|v| v.as_str()) {
                let candidate = PathBuf::from(path);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    let fallback = PathBuf::from(FALLBACK_EXE);
    if fallback.is_file() {
        return Ok(fallback);
    }
    Err("Could not find RiotClientServices.exe. Is the Riot Client installed?".into())
}

/// True if any Riot Client process is alive. Uses `tasklist` rather than a
/// Windows API crate to avoid pulling in a dependency for one check.
fn riot_client_running() -> bool {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = Command::new("tasklist");
    command.args(["/FI", "IMAGENAME eq RiotClientServices.exe", "/NH"]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("RiotClientServices"))
        .unwrap_or(false)
}

fn parse_launch_target(args: &[Value]) -> (String, String) {
    let value = |index: usize, fallback: &str| {
        args.get(index)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    (value(0, "valorant"), value(1, "live"))
}

fn launch_args(product: &str, patchline: &str, config_url: Option<&str>) -> Vec<String> {
    let mut args = Vec::with_capacity(if config_url.is_some() { 3 } else { 2 });
    if let Some(url) = config_url {
        args.push(format!("--client-config-url={url}"));
    }
    args.push(format!("--launch-product={product}"));
    args.push(format!("--launch-patchline={patchline}"));
    args
}

fn spawn_riot(exe: &PathBuf, args: &[String]) -> Result<(), String> {
    Command::new(exe)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to launch the Riot Client: {error}"))
}

fn command_result(result: Result<Value, String>) -> Result<String, ()> {
    Ok(match result {
        Ok(value) => value.to_string(),
        Err(error) => json!({ "success": false, "error": error }).to_string(),
    })
}

#[tauri::command]
pub async fn client_config_status() -> Result<String, ()> {
    let presence = presence_proxy::controller().snapshot();
    Ok(json!({
        "success": true,
        "running": client_config::is_running(),
        "port": client_config::DEFAULT_PORT,
        "url": format!("http://127.0.0.1:{}", client_config::DEFAULT_PORT),
        "riotClientRunning": riot_client_running(),
        "relayRunning": presence.relay_running,
        "relayPort": presence.relay_port,
        "activeConnections": presence.active_connections,
        "upstreamReady": presence.upstream_ready,
        "presenceMode": presence.mode,
        "presenceEnabled": presence.enabled,
        "presenceMucEnabled": presence.connect_to_muc,
        "certId": presence.cert_id,
        "certHost": presence.cert_host,
        "lastWarning": presence.last_warning,
    })
    .to_string())
}

/// Starts the local config server (if needed) and launches the Riot Client
/// pointed at it:
///
/// ```text
/// RiotClientServices.exe --client-config-url="http://127.0.0.1:8000"
///   --launch-product=valorant --launch-patchline=live
/// ```
#[tauri::command]
pub async fn riot_launch_with_config(args: Vec<Value>) -> Result<String, ()> {
    let _launch_guard = launch_lock().lock().await;
    let (product, patchline) = parse_launch_target(&args);

    let result: Result<Value, String> = async {
        if riot_client_running() {
            return Err("The Riot Client is already running. Close it completely (including the tray icon), then launch again.".into());
        }

        let exe = riot_client_exe()?;

        // The config response needs the relay port, so bring the relay up before
        // the client can make its first config request.
        let relay_port = presence_proxy::start().await?;
        if let Err(error) = client_config::start(client_config::DEFAULT_PORT).await {
            presence_proxy::stop().await;
            return Err(error);
        }
        if let Err(error) = client_config::verify_ready(client_config::DEFAULT_PORT).await {
            client_config::stop();
            presence_proxy::stop().await;
            return Err(error);
        }

        let config_url = format!("http://127.0.0.1:{}", client_config::DEFAULT_PORT);
        let args = launch_args(&product, &patchline, Some(&config_url));
        if let Err(error) = spawn_riot(&exe, &args) {
            client_config::stop();
            presence_proxy::stop().await;
            return Err(error);
        }

        Ok(json!({
            "success": true,
            "exe": exe.to_string_lossy(),
            "configUrl": config_url,
            "product": product,
            "patchline": patchline,
            "relayPort": relay_port,
        }))
    }
    .await;

    command_result(result)
}

#[tauri::command]
pub async fn riot_launch_normal(args: Vec<Value>) -> Result<String, ()> {
    let _launch_guard = launch_lock().lock().await;
    let (product, patchline) = parse_launch_target(&args);
    let result = if riot_client_running() {
        Err("The Riot Client is already running. Close it completely (including the tray icon), then launch again.".into())
    } else {
        riot_client_exe().and_then(|exe| {
            let args = launch_args(&product, &patchline, None);
            spawn_riot(&exe, &args)?;
            Ok(json!({
                "success": true,
                "exe": exe.to_string_lossy(),
                "product": product,
                "patchline": patchline,
                "proxied": false,
            }))
        })
    };
    command_result(result)
}

#[tauri::command]
pub async fn client_config_stop() -> Result<String, ()> {
    client_config::stop();
    presence_proxy::stop().await;
    Ok(json!({ "success": true, "running": false, "relayRunning": false }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn launch_lock_serializes_requests() {
        let first = launch_lock().lock().await;
        assert!(launch_lock().try_lock().is_err());
        drop(first);
        assert!(launch_lock().try_lock().is_ok());
    }

    #[test]
    fn normal_launch_arguments_omit_client_config() {
        let args = launch_args("valorant", "live", None);
        assert_eq!(
            args,
            ["--launch-product=valorant", "--launch-patchline=live"]
        );
        assert!(!args
            .iter()
            .any(|arg| arg.starts_with("--client-config-url=")));
    }

    #[test]
    fn proxied_launch_arguments_include_client_config() {
        let args = launch_args("valorant", "live", Some("http://127.0.0.1:8000"));
        assert_eq!(
            args,
            [
                "--client-config-url=http://127.0.0.1:8000",
                "--launch-product=valorant",
                "--launch-patchline=live",
            ]
        );
    }
}
