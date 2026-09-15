use crate::store::ConfigStore;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, State, WebviewWindow};

const CONFIG_KEY: &str = "startupMonitor";

#[derive(Serialize)]
struct DisplayInfo {
    id: String,
    name: String,
    width: u32,
    height: u32,
    primary: bool,
}

fn describe_displays(monitors: &[Monitor], primary: Option<&Monitor>) -> Vec<DisplayInfo> {
    monitors
        .iter()
        .map(|monitor| {
            // Windows names (e.g. DISPLAY1) survive enumeration-order changes.
            // Coordinates are only a fallback for an unnamed monitor.
            let name = monitor.name().cloned().unwrap_or_default();
            let id = if name.is_empty() {
                format!("position:{},{}", monitor.position().x, monitor.position().y)
            } else {
                name.clone()
            };
            DisplayInfo {
                id,
                name: name.trim_start_matches(r"\\.\").to_string(),
                width: monitor.size().width,
                height: monitor.size().height,
                primary: primary.is_some_and(|primary| primary.position() == monitor.position()),
            }
        })
        .collect()
}

fn selected_display(monitors: &[DisplayInfo], selected: &str) -> Option<usize> {
    monitors
        .iter()
        .position(|monitor| !selected.is_empty() && monitor.id.eq_ignore_ascii_case(selected))
        .or_else(|| monitors.iter().position(|monitor| monitor.primary))
        .or_else(|| (!monitors.is_empty()).then_some(0))
}

fn centered_position(
    origin: PhysicalPosition<i32>,
    available: PhysicalSize<u32>,
    window: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    // Use signed desktop coordinates for monitors left of or above the primary,
    // and avoid centering an oversized title bar outside the work area.
    PhysicalPosition::new(
        origin
            .x
            .saturating_add((available.width.saturating_sub(window.width) / 2) as i32),
        origin
            .y
            .saturating_add((available.height.saturating_sub(window.height) / 2) as i32),
    )
}

pub fn position_on_startup(
    window: &WebviewWindow,
    store: &crate::store::Store,
) -> tauri::Result<()> {
    let monitors = window.available_monitors()?;
    let primary = window.primary_monitor()?;
    let displays = describe_displays(&monitors, primary.as_ref());
    let selected = store.get(CONFIG_KEY);
    let selected = selected
        .as_ref()
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(index) = selected_display(&displays, selected) else {
        return Ok(());
    };
    let area = monitors[index].work_area();
    // Moving first lets Windows apply the destination monitor's DPI. The
    // following outer_size read then includes the scaled window decorations.
    window.set_position(area.position)?;
    window.set_position(centered_position(
        area.position,
        area.size,
        window.outer_size()?,
    ))
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "The application window is unavailable.".into())
}

fn connected_displays(app: &AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let window = main_window(app)?;
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let primary = window
        .primary_monitor()
        .map_err(|error| error.to_string())?;
    Ok(describe_displays(&monitors, primary.as_ref()))
}

fn validate_selection(args: &[Value], monitors: &[DisplayInfo]) -> Result<String, String> {
    let selected = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| "A display selection is required.".to_string())?;
    if selected.is_empty() || monitors.iter().any(|monitor| monitor.id == selected) {
        Ok(selected.to_string())
    } else {
        Err("That display is no longer connected. Refresh the display list.".into())
    }
}

#[tauri::command]
pub fn display_get(app: AppHandle, store: State<ConfigStore>) -> String {
    match connected_displays(&app) {
        Ok(monitors) => json!({
            "success": true,
            "monitors": monitors,
            "selected": store.get(CONFIG_KEY).and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default(),
        }),
        Err(error) => json!({ "success": false, "error": error }),
    }.to_string()
}

#[tauri::command]
pub fn display_set(args: Vec<Value>, app: AppHandle, store: State<ConfigStore>) -> String {
    let result = connected_displays(&app).and_then(|monitors| {
        let selected = validate_selection(&args, &monitors)?;
        store.set(CONFIG_KEY, json!(selected));
        Ok(json!({ "success": true, "monitors": monitors, "selected": selected }))
    });
    result
        .unwrap_or_else(|error| json!({ "success": false, "error": error }))
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(id: &str, primary: bool) -> DisplayInfo {
        DisplayInfo {
            id: id.into(),
            name: id.into(),
            width: 1920,
            height: 1080,
            primary,
        }
    }

    #[test]
    fn display_selection_uses_saved_identity_after_list_order_changes() {
        let monitors = vec![display("DISPLAY2", false), display("DISPLAY1", true)];
        assert_eq!(selected_display(&monitors, "display2"), Some(0));
        assert_eq!(selected_display(&monitors, "DISPLAY1"), Some(1));
    }

    #[test]
    fn display_selection_falls_back_to_primary_when_saved_monitor_is_unplugged() {
        let monitors = vec![display("DISPLAY2", false), display("DISPLAY1", true)];
        assert_eq!(selected_display(&monitors, "disconnected"), Some(1));
        assert_eq!(selected_display(&monitors, ""), Some(1));
        assert_eq!(selected_display(&[display("only", false)], ""), Some(0));
        assert_eq!(selected_display(&[], ""), None);
    }

    #[test]
    fn display_center_handles_negative_coordinates_and_taskbar_space() {
        assert_eq!(
            centered_position(
                PhysicalPosition::new(-1920, -200),
                PhysicalSize::new(1920, 1040),
                PhysicalSize::new(1000, 720),
            ),
            PhysicalPosition::new(-1460, -40)
        );
        // Windows supplies physical pixels, including for a 200% display.
        assert_eq!(
            centered_position(
                PhysicalPosition::new(1920, 40),
                PhysicalSize::new(3840, 2120),
                PhysicalSize::new(2000, 1440),
            ),
            PhysicalPosition::new(2840, 380)
        );
    }

    #[test]
    fn display_center_keeps_an_oversized_windows_title_bar_reachable() {
        assert_eq!(
            centered_position(
                PhysicalPosition::new(0, -900),
                PhysicalSize::new(800, 600),
                PhysicalSize::new(1000, 720),
            ),
            PhysicalPosition::new(0, -900)
        );
    }

    #[test]
    fn display_preference_rejects_unknown_or_non_string_selections() {
        let monitors = vec![display("DISPLAY1", true)];
        assert_eq!(validate_selection(&[json!("")], &monitors).unwrap(), "");
        assert_eq!(
            validate_selection(&[json!("DISPLAY1")], &monitors).unwrap(),
            "DISPLAY1"
        );
        for args in [
            vec![],
            vec![Value::Null],
            vec![json!(1)],
            vec![json!("missing")],
        ] {
            assert!(validate_selection(&args, &monitors).is_err());
        }
    }
}
