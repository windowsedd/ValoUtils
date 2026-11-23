//! Settings commands for remote chat (`crate::remote`).

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::store::ConfigStore;

/// An SVG QR code for `text`, or `None` if it doesn't fit a QR code.
fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(qrcode::render::svg::Color("#000000"))
            .light_color(qrcode::render::svg::Color("#ffffff"))
            .build(),
    )
}

fn status(config: &ConfigStore) -> Value {
    let port = crate::remote::running_port();
    let token = crate::remote::token(config);
    let addresses: Vec<Value> = match port {
        None => Vec::new(),
        Some(port) => crate::remote::addresses()
            .into_iter()
            .map(|(ip, kind)| {
                let url = crate::remote::page_url(ip, port, &token);
                json!({ "ip": ip.to_string(), "kind": kind, "url": url, "qr": qr_svg(&url) })
            })
            .collect(),
    };
    json!({
        "success": true,
        "enabled": config.get("remoteEnabled") == Some(json!(true)),
        "running": port.is_some(),
        "port": port,
        "addresses": addresses,
    })
}

#[tauri::command]
pub fn remote_status(config: State<'_, ConfigStore>) -> Value {
    status(&config)
}

/// `args: [enabled]`. Starting can fail (no free port); the flag then stays off.
#[tauri::command]
pub async fn remote_set_enabled(
    args: Vec<Value>,
    app: AppHandle,
    config: State<'_, ConfigStore>,
) -> Result<Value, ()> {
    let Some(enabled) = args.first().and_then(Value::as_bool) else {
        return Ok(json!({ "success": false, "error": "Expected a boolean." }));
    };
    if enabled {
        if let Err(error) = crate::remote::start(&app).await {
            return Ok(json!({ "success": false, "error": error }));
        }
    } else {
        crate::remote::stop();
    }
    if let Err(error) = config.try_set("remoteEnabled", json!(enabled)) {
        if enabled {
            crate::remote::stop();
        }
        return Ok(json!({ "success": false, "error": error }));
    }
    Ok(status(&config))
}

/// Replaces the token. Phones paired with the old one must scan again.
#[tauri::command]
pub fn remote_regenerate_token(config: State<'_, ConfigStore>) -> Value {
    if let Err(error) = config.try_set("remoteToken", json!(crate::mcp::new_token())) {
        return json!({ "success": false, "error": error });
    }
    status(&config)
}

#[cfg(test)]
mod tests {
    #[test]
    fn qr_codes_render_as_svg() {
        let svg = super::qr_svg("http://100.64.0.1:47824/#t=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG").unwrap();
        assert!(svg.contains("<svg"));
    }
}
