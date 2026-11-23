//! System tray icon, and closing the window to the tray.
//!
//! The XMPP relay, config server, MCP and remote chat servers live in this
//! process. Quitting while the Riot Client is connected through the relay
//! drops its chat (the player shows offline and chat commands stop), so the
//! window's close button hides to the tray unless `closeToTray` is false.
//! Quit from the tray menu exits for real.
//!
//! The menu also switches presence, launches VALORANT through the relay and
//! shows whether chat is connected; [`refresh`] keeps that current.

use serde_json::json;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Window, WindowEvent, Wry};

use crate::presence_proxy::{self, PresenceMode};
use crate::store::ConfigStore;

const TRAY_ID: &str = "main";
const OPEN_ID: &str = "tray-open";
const LAUNCH_ID: &str = "tray-launch";
const QUIT_ID: &str = "tray-quit";
const STATUS_ID: &str = "tray-status";
const PRESENCE_IDS: [(&str, PresenceMode, &str); 3] = [
    ("tray-presence-online", PresenceMode::Online, "Online"),
    ("tray-presence-offline", PresenceMode::Offline, "Appear offline"),
    ("tray-presence-mobile", PresenceMode::Mobile, "Mobile"),
];
/// How often the status line and presence checks are brought up to date. Only
/// in-memory relay state is read, so this costs nothing outside the process.
const REFRESH_EVERY: Duration = Duration::from_secs(3);

/// Menu items whose text or check state follows the relay.
struct TrayItems {
    status: MenuItem<Wry>,
    presence: Vec<(PresenceMode, CheckMenuItem<Wry>)>,
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, STATUS_ID, status_text(&presence_proxy::controller().snapshot()), false, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN_ID, "Open ValoUtils", true, None::<&str>)?;
    let launch = MenuItem::with_id(app, LAUNCH_ID, "Launch VALORANT", true, None::<&str>)?;
    let presence = PRESENCE_IDS
        .iter()
        .map(|(id, mode, label)| Ok((*mode, CheckMenuItem::with_id(app, *id, *label, true, false, None::<&str>)?)))
        .collect::<tauri::Result<Vec<_>>>()?;
    let presence_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        presence.iter().map(|(_, item)| item as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let presence_menu = Submenu::with_items(app, "Presence", true, &presence_refs)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit ValoUtils", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &launch,
            &presence_menu,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ValoUtils")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::focus_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayItems { status, presence });
    refresh(app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(REFRESH_EVERY);
        loop {
            tick.tick().await;
            refresh(&handle);
        }
    });
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        OPEN_ID => crate::focus_main_window(app),
        LAUNCH_ID => launch_valorant(app),
        QUIT_ID => app.exit(0),
        _ => {
            if let Some((_, mode, _)) = PRESENCE_IDS.iter().find(|(item, _, _)| *item == id) {
                presence_proxy::change_mode(*mode);
                refresh(app);
            }
        }
    }
}

/// Starts VALORANT the way the login panel's Launch button does (through the
/// relay), and reports the outcome as a Windows notification because the
/// window may be hidden.
fn launch_valorant(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // `tasklist` blocks; menu events arrive on the UI thread.
        let running = tauri::async_runtime::spawn_blocking(crate::commands::riot_launch::valorant_running)
            .await
            .unwrap_or(false);
        if running {
            notify(&app, "VALORANT is already running.");
            return;
        }
        let target = vec![json!("valorant"), json!("live")];
        let reply = crate::commands::riot_launch::riot_launch_with_config(target, app.clone(), app.state::<ConfigStore>())
            .await
            .unwrap_or_default();
        let message = if reply.get("success") == Some(&json!(true)) {
            if reply.get("waitingForSignIn") == Some(&json!(true)) {
                "Sign in to the Riot Client and VALORANT will start.".to_string()
            } else {
                "VALORANT is launching.".to_string()
            }
        } else {
            reply
                .get("error")
                .and_then(|error| error.as_str())
                .unwrap_or("VALORANT could not be launched.")
                .to_string()
        };
        notify(&app, &message);
    });
}

fn notify(app: &AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app.notification().builder().title("ValoUtils").body(body).show() {
        log::warn!("Could not show a tray notification: {error}");
    }
}

fn mode_label(mode: PresenceMode) -> &'static str {
    PRESENCE_IDS
        .iter()
        .find(|(_, item, _)| *item == mode)
        .map_or("Online", |(_, _, label)| label)
}

/// The menu's first line: whether Riot chat is going through the relay.
fn status_text(snapshot: &presence_proxy::PresenceSnapshot) -> String {
    let chat = if !snapshot.relay_running {
        "Relay off"
    } else if snapshot.active_connections > 0 {
        "Chat connected"
    } else {
        "Relay waiting for Riot Client"
    };
    let presence = if snapshot.enabled { mode_label(snapshot.mode) } else { "masking off" };
    format!("{chat} · {presence}")
}

/// Brings the status line, tooltip and presence checks up to date.
fn refresh(app: &AppHandle) {
    let Some(items) = app.try_state::<TrayItems>() else {
        return;
    };
    let snapshot = presence_proxy::controller().snapshot();
    let text = status_text(&snapshot);
    if items.status.text().ok().as_deref() != Some(text.as_str()) {
        if let Err(error) = items.status.set_text(&text) {
            log::debug!("Could not update the tray status: {error}");
        }
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(format!("ValoUtils — {text}")));
        }
    }
    for (mode, item) in &items.presence {
        let checked = snapshot.enabled && snapshot.mode == *mode;
        if item.is_checked().ok() != Some(checked) {
            let _ = item.set_checked(checked);
        }
    }
}

/// The main window's close button hides it to the tray (default on).
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let config = app.state::<ConfigStore>();
    if config.get("closeToTray") == Some(json!(false)) {
        return;
    }
    api.prevent_close();
    if let Err(error) = window.hide() {
        log::warn!("Could not hide the window to the tray: {error}");
        return;
    }
    // Say where the window went, once.
    if config.get("trayHintShown") != Some(json!(true)) {
        config.set("trayHintShown", json!(true));
        use tauri_plugin_notification::NotificationExt;
        if let Err(error) = app
            .notification()
            .builder()
            .title("ValoUtils is still running")
            .body("Chat, the relay and your commands keep working. Open or quit ValoUtils from the tray icon.")
            .show()
        {
            log::warn!("Could not show the tray notification: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(relay_running: bool, connections: usize, enabled: bool, mode: PresenceMode) -> presence_proxy::PresenceSnapshot {
        presence_proxy::PresenceSnapshot {
            enabled,
            mode,
            connect_to_muc: true,
            relay_running,
            relay_port: relay_running.then_some(4000),
            active_connections: connections,
            upstream_ready: true,
            last_warning: None,
            cert_id: "deceive",
            cert_host: "localhost",
            cert_configured: true,
        }
    }

    #[test]
    fn status_text_reports_connected_chat_and_presence() {
        assert_eq!(status_text(&snapshot(true, 1, true, PresenceMode::Online)), "Chat connected · Online");
    }

    #[test]
    fn status_text_reports_a_waiting_relay() {
        assert_eq!(
            status_text(&snapshot(true, 0, true, PresenceMode::Offline)),
            "Relay waiting for Riot Client · Appear offline"
        );
    }

    #[test]
    fn status_text_reports_relay_off_and_masking_off() {
        assert_eq!(status_text(&snapshot(false, 0, false, PresenceMode::Mobile)), "Relay off · masking off");
    }
}
