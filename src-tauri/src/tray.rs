//! System tray icon, and closing the window to the tray.
//!
//! The XMPP relay, config server, MCP and remote chat servers live in this
//! process. Quitting while the Riot Client is connected through the relay
//! drops its chat (the player shows offline and chat commands stop), so the
//! window's close button hides to the tray unless `closeToTray` is false.
//! Quit from the tray menu exits for real.

use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Window, WindowEvent};

use crate::store::ConfigStore;

const OPEN_ID: &str = "tray-open";
const QUIT_ID: &str = "tray-quit";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open ValoUtils", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit ValoUtils", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("ValoUtils")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => crate::focus_main_window(app),
            QUIT_ID => app.exit(0),
            _ => {}
        })
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
    Ok(())
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
