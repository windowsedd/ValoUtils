//! Relaunching the Riot Client against the local client-config server.
//!
//! `--client-config-url` is only read at process start, so a client that is
//! already running cannot be repointed — it has to be closed first. Launching
//! the exe while one is alive just focuses the existing window and silently
//! drops the flags, which looks like the feature doing nothing.

use crate::riot::client::RiotState;
use crate::store::ConfigStore;
use crate::{client_config, presence_proxy};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

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
const RIOT_CLIENT_IMAGE: &str = "riotclientservices.exe";
/// The game itself; the Riot Client alone doesn't mean anyone is playing.
const VALORANT_IMAGE: &str = "valorant-win64-shipping.exe";

/// Every running process's image name, lowercased, from one `tasklist` call.
fn running_images() -> String {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = Command::new("tasklist");
    command.args(["/NH", "/FO", "CSV"]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_ascii_lowercase())
        .unwrap_or_default()
}

/// Whether `image` (lowercase) appears as a process name in `tasklist` CSV.
fn image_listed(images: &str, image: &str) -> bool {
    images.contains(&format!("\"{image}\""))
}

fn riot_client_running() -> bool {
    image_listed(&running_images(), RIOT_CLIENT_IMAGE)
}

pub(crate) fn valorant_running() -> bool {
    image_listed(&running_images(), VALORANT_IMAGE)
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

/// Splits the Settings → Launch arguments text like a command line:
/// whitespace separates arguments and double quotes keep spaces inside one.
pub(crate) fn split_launch_args(text: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for ch in text.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            ch if ch.is_whitespace() && !quoted => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            ch => {
                current.push(ch);
                started = true;
            }
        }
    }
    if started {
        args.push(current);
    }
    args
}

/// The user's extra launch arguments (`riotLaunchArgs`).
fn configured_extra_args(config: &ConfigStore) -> Vec<String> {
    config
        .get("riotLaunchArgs")
        .and_then(|value| value.as_str().map(split_launch_args))
        .unwrap_or_default()
}

/// The product and patchline a launch really asks for, after Launch arguments
/// had their say (`--launch-patchline=pbe` replaces "live").
fn effective_target(args: &[String]) -> (String, String) {
    let value = |flag: &str, fallback: &str| {
        args.iter()
            .rev()
            .find_map(|arg| arg.strip_prefix(flag))
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    (value("--launch-product=", "valorant"), value("--launch-patchline=", "live"))
}

/// How long a launch is looked after; signing in can take a while.
const LAUNCH_WATCH: Duration = Duration::from_secs(180);
const LAUNCH_POLL: Duration = Duration::from_secs(3);
/// After sign-in, how long the Riot Client gets to start the game by itself.
const SELF_START_GRACE: Duration = Duration::from_secs(8);

/// The Riot Client only sometimes acts on `--launch-product`; after a sign-in
/// it often stops on the game's Play page. Once the client is signed in and
/// has had a moment to start the game itself, ask its local API to launch it
/// (what the Play button does). Stops as soon as the game process appears.
fn watch_game_start(app: AppHandle, product: String, patchline: String) {
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut signed_in_at: Option<Instant> = None;
        while started.elapsed() < LAUNCH_WATCH {
            tokio::time::sleep(LAUNCH_POLL).await;
            if valorant_running() {
                log::info!("launch: {product} is running");
                return;
            }
            let riot = app.state::<RiotState>();
            let Some(signed_in) = signed_in_at else {
                if crate::riot::client::get_tokens(&riot, true).await.is_ok() {
                    log::info!("launch: Riot Client signed in; giving it a moment to start {product}");
                    signed_in_at = Some(Instant::now());
                }
                continue;
            };
            if signed_in.elapsed() < SELF_START_GRACE {
                continue;
            }
            let path = format!("/product-launcher/v1/products/{product}/patchlines/{patchline}");
            match crate::riot::client::send_internal_request(&riot, &path, reqwest::Method::POST, None).await {
                Ok(_) => log::info!("launch: asked Riot Client to start {product} ({patchline})"),
                Err(error) => log::warn!("launch: Riot Client did not start {product} ({patchline}): {error}"),
            }
            return;
        }
        log::info!("launch: stopped waiting for {product} after {} s", LAUNCH_WATCH.as_secs());
    });
}

/// Starts the game from a Riot Client that is already open, through its local
/// API (what its Play button does), rather than refusing and making the player
/// restart it. Signed in, the game starts now; otherwise once sign-in finishes.
/// `relayActive` says whether that client is connected through the XMPP relay,
/// which chat, presence and the bot need; a client opened without ValoUtils
/// still starts the game, and Restart through relay can add the relay later.
async fn launch_in_running_client(
    app: &AppHandle,
    product: String,
    patchline: String,
) -> Result<Value, String> {
    if valorant_running() {
        return Err("VALORANT is already running.".into());
    }
    let riot = app.state::<RiotState>();
    let signed_in = crate::riot::client::get_tokens(&riot, true).await.is_ok();
    if signed_in {
        let path = format!("/product-launcher/v1/products/{product}/patchlines/{patchline}");
        crate::riot::client::send_internal_request(&riot, &path, reqwest::Method::POST, None)
            .await
            .map_err(|error| format!("The Riot Client did not start {product}: {error}"))?;
        log::info!("launch: asked the open Riot Client to start {product} ({patchline})");
    } else {
        log::info!("launch: Riot Client is open but signed out; starting {product} after sign-in");
        watch_game_start(app.clone(), product.clone(), patchline.clone());
    }
    Ok(json!({
        "success": true,
        "runningClient": true,
        "waitingForSignIn": !signed_in,
        "relayActive": presence_proxy::controller().snapshot().active_connections > 0,
        "product": product,
        "patchline": patchline,
    }))
}

/// Riot Client arguments: the relay's config URL, the product and patchline,
/// then the user's extra arguments. An extra `--launch-product` or
/// `--launch-patchline` replaces the default one; an extra
/// `--client-config-url` is dropped because the relay launch sets its own.
fn launch_args(
    product: &str,
    patchline: &str,
    config_url: Option<&str>,
    extra: &[String],
) -> Vec<String> {
    let extra: Vec<&String> = extra
        .iter()
        .filter(|arg| !arg.starts_with("--client-config-url"))
        .collect();
    let overridden = |flag: &str| extra.iter().any(|arg| arg.starts_with(flag));
    let mut args = Vec::with_capacity(3 + extra.len());
    if let Some(url) = config_url {
        args.push(format!("--client-config-url={url}"));
    }
    if !overridden("--launch-product") {
        args.push(format!("--launch-product={product}"));
    }
    if !overridden("--launch-patchline") {
        args.push(format!("--launch-patchline={patchline}"));
    }
    args.extend(extra.into_iter().cloned());
    args
}

fn spawn_riot(exe: &PathBuf, args: &[String]) -> Result<(), String> {
    log::info!("launch: {} {}", exe.display(), args.join(" "));
    Command::new(exe)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to launch the Riot Client: {error}"))
}

fn command_result(result: Result<Value, String>) -> Result<Value, ()> {
    Ok(match result {
        Ok(value) => value,
        Err(error) => json!({ "success": false, "error": error }),
    })
}

#[tauri::command]
pub async fn client_config_status() -> Result<Value, ()> {
    let port = client_config::port();
    let running = client_config::is_running() && client_config::verify_ready(port).await.is_ok();
    let presence = presence_proxy::controller().snapshot();
    let images = running_images();
    Ok(json!({
        "success": true,
        "running": running,
        "port": port,
        "url": format!("http://127.0.0.1:{port}"),
        "riotClientRunning": image_listed(&images, RIOT_CLIENT_IMAGE),
        "valorantRunning": image_listed(&images, VALORANT_IMAGE),
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
    }))
}

async fn start_config_and_relay() -> Result<u16, String> {
    let relay_was_running = presence_proxy::controller().snapshot().relay_running;
    let relay_port = presence_proxy::start().await?;
    if let Err(error) = client_config::start_verified(client_config::port()).await {
        if !relay_was_running {
            presence_proxy::stop().await;
        }
        return Err(error);
    }
    Ok(relay_port)
}

/// Background startup shares the command lock so early Launch clicks are safe.
pub async fn autostart() {
    let _launch_guard = launch_lock().lock().await;
    if let Err(error) = start_config_and_relay().await {
        log::warn!("Could not automatically start the client-config server: {error}");
        presence_proxy::controller().set_warning(Some(error));
    }
}

/// Wake the local services without launching or restarting the Riot Client.
#[tauri::command]
pub async fn client_config_start() -> Result<Value, ()> {
    let _launch_guard = launch_lock().lock().await;
    if let Err(error) = start_config_and_relay().await {
        return command_result(Err(error));
    }
    client_config_status().await
}

/// Starts the local config server (if needed) and launches the Riot Client
/// pointed at it:
///
/// ```text
/// RiotClientServices.exe --client-config-url="http://127.0.0.1:<selected-port>"
///   --launch-product=valorant --launch-patchline=live
/// ```
#[tauri::command]
pub async fn riot_launch_with_config(
    args: Vec<Value>,
    app: AppHandle,
    config: tauri::State<'_, ConfigStore>,
) -> Result<Value, ()> {
    let _launch_guard = launch_lock().lock().await;
    let (product, patchline) = parse_launch_target(&args);
    let extra = configured_extra_args(&config);
    command_result(launch_relay(&app, product, patchline, extra).await)
}

/// The relay launch, for callers already holding the launch lock.
async fn launch_relay(
    app: &AppHandle,
    product: String,
    patchline: String,
    extra: Vec<String>,
) -> Result<Value, String> {
    {
        if riot_client_running() {
            // Launch arguments can't reach a running client, but a patchline
            // override still picks what it starts.
            let (product, patchline) = effective_target(&launch_args(&product, &patchline, None, &extra));
            return launch_in_running_client(app, product, patchline).await;
        }

        let exe = riot_client_exe()?;

        // The config response needs the relay port, so bring the relay up before
        // the client can make its first config request.
        let relay_port = start_config_and_relay().await?;

        let config_url = format!("http://127.0.0.1:{}", client_config::port());
        let args = launch_args(&product, &patchline, Some(&config_url), &extra);
        if let Err(error) = spawn_riot(&exe, &args) {
            client_config::stop().await;
            presence_proxy::stop().await;
            return Err(error);
        }
        let (target_product, target_patchline) = effective_target(&args);
        watch_game_start(app.clone(), target_product, target_patchline);

        Ok(json!({
            "success": true,
            "exe": exe.to_string_lossy(),
            "configUrl": config_url,
            "product": product,
            "patchline": patchline,
            "relayPort": relay_port,
            "extraArgs": extra,
        }))
    }
}

/// Riot Client arguments for opening the client alone: the relay's config URL
/// and the user's extra arguments, without a product to launch.
fn client_only_args(config_url: &str, extra: &[String]) -> Vec<String> {
    let mut args = vec![format!("--client-config-url={config_url}")];
    args.extend(
        extra
            .iter()
            .filter(|arg| {
                !arg.starts_with("--client-config-url")
                    && !arg.starts_with("--launch-product")
                    && !arg.starts_with("--launch-patchline")
            })
            .cloned(),
    );
    args
}

/// Opens the Riot Client through the local config server and XMPP relay
/// without launching a game, so chat, presence and the bot work out of game.
#[tauri::command]
pub async fn riot_open_client_with_config(
    #[allow(unused_variables)] args: Vec<Value>,
    config: tauri::State<'_, ConfigStore>,
) -> Result<Value, ()> {
    let _launch_guard = launch_lock().lock().await;
    let extra = configured_extra_args(&config);
    command_result(open_client_relay(extra).await)
}

/// Opens the client alone through the relay, for callers holding the launch lock.
async fn open_client_relay(extra: Vec<String>) -> Result<Value, String> {
    {
        if riot_client_running() {
            return Err("The Riot Client is already running. Close it completely (including the tray icon), then open it again.".into());
        }
        let exe = riot_client_exe()?;
        let relay_port = start_config_and_relay().await?;
        let config_url = format!("http://127.0.0.1:{}", client_config::port());
        let args = client_only_args(&config_url, &extra);
        if let Err(error) = spawn_riot(&exe, &args) {
            client_config::stop().await;
            presence_proxy::stop().await;
            return Err(error);
        }
        Ok(json!({
            "success": true,
            "exe": exe.to_string_lossy(),
            "configUrl": config_url,
            "relayPort": relay_port,
            "extraArgs": extra,
        }))
    }
}

#[tauri::command]
pub async fn riot_launch_normal(
    args: Vec<Value>,
    app: AppHandle,
    config: tauri::State<'_, ConfigStore>,
) -> Result<Value, ()> {
    let _launch_guard = launch_lock().lock().await;
    let (product, patchline) = parse_launch_target(&args);
    let extra = configured_extra_args(&config);
    let result = if riot_client_running() {
        let (product, patchline) = effective_target(&launch_args(&product, &patchline, None, &extra));
        launch_in_running_client(&app, product, patchline).await
    } else {
        riot_client_exe().and_then(|exe| {
            let args = launch_args(&product, &patchline, None, &extra);
            spawn_riot(&exe, &args)?;
            let (target_product, target_patchline) = effective_target(&args);
            watch_game_start(app.clone(), target_product, target_patchline);
            Ok(json!({
                "success": true,
                "exe": exe.to_string_lossy(),
                "product": product,
                "patchline": patchline,
                "proxied": false,
                "extraArgs": extra,
            }))
        })
    };
    command_result(result)
}

/// Riot Client processes: the services host, its window and helpers.
const RIOT_CLIENT_IMAGES: &[&str] = &[
    RIOT_CLIENT_IMAGE,
    "riot client.exe",
    "riotclientux.exe",
    "riotclientuxrender.exe",
    "riotclientcrashhandler.exe",
];
/// The game's launcher stub and the game itself.
const GAME_IMAGES: &[&str] = &[VALORANT_IMAGE, "valorant.exe"];
/// How long closed processes get to disappear from `tasklist`.
const CLOSE_WAIT: Duration = Duration::from_secs(10);
const CLOSE_POLL: Duration = Duration::from_millis(300);

/// Which of `names` (lowercase image names) are in a `tasklist` listing.
fn listed_images<'a>(images: &str, names: &[&'a str]) -> Vec<&'a str> {
    names.iter().copied().filter(|name| image_listed(images, name)).collect()
}

/// Force-closes every running process in `names` (with its child processes)
/// and waits until none is left. Returns the images that were running.
async fn close_processes(names: &[&str], what: &str) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let running = listed_images(&running_images(), names);
    for image in &running {
        let mut command = Command::new("taskkill");
        command.args(["/F", "/T", "/IM", image]);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        // A process already ended by its parent's /T reports "not found"; the
        // wait below is what decides success.
        if let Err(error) = command.output() {
            return Err(format!("Could not run taskkill: {error}"));
        }
    }
    let started = Instant::now();
    while !listed_images(&running_images(), names).is_empty() {
        if started.elapsed() > CLOSE_WAIT {
            return Err(format!(
                "{what} is still running after {} seconds. Close it from Task Manager.",
                CLOSE_WAIT.as_secs()
            ));
        }
        tokio::time::sleep(CLOSE_POLL).await;
    }
    if !running.is_empty() {
        log::info!("closed {what}: {}", running.join(", "));
    }
    Ok(running.into_iter().map(str::to_owned).collect())
}

enum CloseOutcome {
    /// VALORANT is running and closing it wasn't confirmed; nothing was closed.
    GameRunning,
    Closed { game: bool, client: bool },
}

/// Closes VALORANT (only when `close_game`) and then the Riot Client.
async fn close_riot(close_game: bool, riot: &RiotState) -> Result<CloseOutcome, String> {
    let game = !listed_images(&running_images(), GAME_IMAGES).is_empty();
    if game && !close_game {
        return Ok(CloseOutcome::GameRunning);
    }
    if game {
        close_processes(GAME_IMAGES, "VALORANT").await?;
    }
    let client = !close_processes(RIOT_CLIENT_IMAGES, "The Riot Client").await?.is_empty();
    // The old session's tokens died with the client.
    crate::riot::client::invalidate_tokens(riot);
    Ok(CloseOutcome::Closed { game, client })
}

const GAME_RUNNING_ERROR: &str =
    "VALORANT is running. Confirm to close the game together with the Riot Client.";

fn game_running_reply() -> Value {
    json!({ "success": false, "code": "valorantRunning", "error": GAME_RUNNING_ERROR })
}

/// Whether the caller confirmed closing a running VALORANT (`args[0]`).
fn close_game_confirmed(args: &[Value]) -> bool {
    args.first().and_then(Value::as_bool).unwrap_or(false)
}

/// Force-closes the Riot Client. While VALORANT is running this replies
/// `code: "valorantRunning"` and closes nothing unless `args[0]` is true.
#[tauri::command]
pub async fn riot_client_close(args: Vec<Value>, riot: tauri::State<'_, RiotState>) -> Result<Value, ()> {
    let _launch_guard = launch_lock().lock().await;
    Ok(match close_riot(close_game_confirmed(&args), &riot).await {
        Ok(CloseOutcome::GameRunning) => game_running_reply(),
        Ok(CloseOutcome::Closed { game, client }) => {
            json!({ "success": true, "closedGame": game, "closedClient": client })
        }
        Err(error) => json!({ "success": false, "error": error }),
    })
}

/// A moment for the closed client to let go of its lockfile and ports.
const RESTART_PAUSE: Duration = Duration::from_millis(1500);

/// Closes the Riot Client (and VALORANT, when confirmed as for
/// [`riot_client_close`]) and opens it again through the config server and
/// XMPP relay. VALORANT is relaunched only if it was running.
#[tauri::command]
pub async fn riot_client_restart(
    args: Vec<Value>,
    app: AppHandle,
    riot: tauri::State<'_, RiotState>,
    config: tauri::State<'_, ConfigStore>,
) -> Result<Value, ()> {
    let _launch_guard = launch_lock().lock().await;
    let extra = configured_extra_args(&config);
    let game = match close_riot(close_game_confirmed(&args), &riot).await {
        Ok(CloseOutcome::GameRunning) => return Ok(game_running_reply()),
        Ok(CloseOutcome::Closed { game, .. }) => game,
        Err(error) => return command_result(Err(error)),
    };
    tokio::time::sleep(RESTART_PAUSE).await;
    let launched = if game {
        launch_relay(&app, "valorant".into(), "live".into(), extra).await
    } else {
        open_client_relay(extra).await
    };
    command_result(launched.map(|mut reply| {
        reply["relaunchedGame"] = json!(game);
        reply
    }))
}

#[tauri::command]
pub async fn client_config_stop() -> Result<Value, ()> {
    let _launch_guard = launch_lock().lock().await;
    client_config::stop().await;
    presence_proxy::stop().await;
    Ok(json!({ "success": true, "running": false, "relayRunning": false }))
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
        let args = launch_args("valorant", "live", None, &[]);
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
        let args = launch_args("valorant", "live", Some("http://127.0.0.1:8000"), &[]);
        assert_eq!(
            args,
            [
                "--client-config-url=http://127.0.0.1:8000",
                "--launch-product=valorant",
                "--launch-patchline=live",
            ]
        );
    }

    #[test]
    fn extra_arguments_split_like_a_command_line() {
        assert_eq!(
            split_launch_args("  --a=1  \"--b=two words\" --c  "),
            ["--a=1", "--b=two words", "--c"]
        );
        assert!(split_launch_args("   ").is_empty());
    }

    #[test]
    fn extra_arguments_follow_and_can_replace_the_patchline() {
        let extra = split_launch_args("--launch-patchline=pbe --allow-multiple-clients");
        assert_eq!(
            launch_args("valorant", "live", None, &extra),
            [
                "--launch-product=valorant",
                "--launch-patchline=pbe",
                "--allow-multiple-clients",
            ]
        );
    }

    #[test]
    fn extra_client_config_urls_cannot_redirect_the_relay() {
        let extra = split_launch_args("--client-config-url=http://elsewhere --x");
        assert_eq!(
            launch_args("valorant", "live", Some("http://127.0.0.1:8000"), &extra),
            [
                "--client-config-url=http://127.0.0.1:8000",
                "--launch-product=valorant",
                "--launch-patchline=live",
                "--x",
            ]
        );
    }

    #[test]
    fn process_names_match_whole_csv_fields() {
        let images = "\"riotclientservices.exe\",\"1\"\r\n\"valorant-win64-shipping.exe\",\"2\"\r\n"
            .to_string();
        assert!(image_listed(&images, RIOT_CLIENT_IMAGE));
        assert!(image_listed(&images, VALORANT_IMAGE));
        assert!(!image_listed("\"notvalorant-win64-shipping.exe.bak\"", VALORANT_IMAGE));
        assert!(!image_listed("", RIOT_CLIENT_IMAGE));
    }

    #[test]
    fn the_watched_target_follows_launch_argument_overrides() {
        let default = launch_args("valorant", "live", None, &[]);
        assert_eq!(effective_target(&default), ("valorant".to_string(), "live".to_string()));
        let pbe = launch_args("valorant", "live", None, &split_launch_args("--launch-patchline=pbe"));
        assert_eq!(effective_target(&pbe), ("valorant".to_string(), "pbe".to_string()));
    }

    #[test]
    fn closing_lists_only_running_riot_and_game_images() {
        let images = "\"riot client.exe\",\"1\"\r\n\"riotclientservices.exe\",\"2\"\r\n\"vgtray.exe\",\"3\"\r\n";
        assert_eq!(listed_images(images, RIOT_CLIENT_IMAGES), [RIOT_CLIENT_IMAGE, "riot client.exe"]);
        assert!(listed_images(images, GAME_IMAGES).is_empty());
        assert!(close_game_confirmed(&[Value::Bool(true)]));
        assert!(!close_game_confirmed(&[]));
        assert_eq!(game_running_reply()["code"], "valorantRunning");
    }

    #[test]
    fn opening_the_client_alone_launches_no_product() {
        let extra = split_launch_args("--launch-patchline=pbe --x --client-config-url=http://elsewhere");
        assert_eq!(
            client_only_args("http://127.0.0.1:8000", &extra),
            ["--client-config-url=http://127.0.0.1:8000", "--x"]
        );
    }
}
