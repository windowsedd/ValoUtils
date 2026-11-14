//! Valorant crosshair share codes (`0;P;c;5;h;0;...`) from the crosshair
//! profiles Riot saves in `SavedCrosshairProfileData`.
//!
//! The code lists only values that differ from the game's defaults, the way
//! the game exports them. Only the primary crosshair (`P` section) is encoded:
//! that is the code players share, and its keys and defaults match the
//! decoder in `src/components/crosshair-svg-generator.tsx`
//! (`DEFAULT_PRIMARY_SETTINGS`) and the field mapping in
//! `src/util/crosshair-mapper.ts`.

use serde_json::{json, Value};

/// The game's preset colors, by their code index (`c;0`..`c;7`).
const PRESETS: [(u64, u64, u64); 8] = [
    (255, 255, 255), // white
    (0, 255, 0),     // green
    (127, 255, 0),   // yellow green
    (223, 255, 0),   // green yellow
    (255, 255, 0),   // yellow
    (0, 255, 255),   // cyan
    (255, 0, 255),   // pink
    (255, 0, 0),     // red
];

struct LineDefaults {
    show: bool,
    thickness: f64,
    length: f64,
    vertical: f64,
    offset: f64,
    opacity: f64,
    movement_error: bool,
    movement_scale: f64,
    firing_error: bool,
    firing_scale: f64,
}

const INNER: LineDefaults = LineDefaults {
    show: true,
    thickness: 2.0,
    length: 6.0,
    vertical: 6.0,
    offset: 3.0,
    opacity: 0.8,
    movement_error: false,
    movement_scale: 1.0,
    firing_error: true,
    firing_scale: 1.0,
};

const OUTER: LineDefaults = LineDefaults {
    show: true,
    thickness: 2.0,
    length: 2.0,
    vertical: 2.0,
    offset: 10.0,
    opacity: 0.35,
    movement_error: true,
    movement_scale: 1.0,
    firing_error: true,
    firing_scale: 1.0,
};

/// Riot stores floats like 0.800000011920929; the code uses 0.8.
fn number(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    let text = format!("{rounded:.3}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn float(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn flag(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

struct Code(Vec<String>);

impl Code {
    fn push(&mut self, key: &str, value: String) {
        self.0.push(key.to_string());
        self.0.push(value);
    }
    fn number(&mut self, key: &str, value: Option<f64>, default: f64) {
        if let Some(value) = value.filter(|value| (value - default).abs() > 0.0005) {
            self.push(key, number(value));
        }
    }
    fn flag(&mut self, key: &str, value: Option<bool>, default: bool) {
        if let Some(value) = value.filter(|value| *value != default) {
            self.push(key, if value { "1" } else { "0" }.into());
        }
    }
}

fn line(code: &mut Code, prefix: &str, line: Option<&Value>, defaults: &LineDefaults) {
    let Some(line) = line else { return };
    let key = |name: &str| format!("{prefix}{name}");
    code.number(&key("t"), float(line, "lineThickness"), defaults.thickness);
    code.number(&key("l"), float(line, "lineLength"), defaults.length);
    code.number(&key("v"), float(line, "lineLengthVertical"), defaults.vertical);
    code.flag(&key("g"), flag(line, "bAllowVertScaling"), false);
    code.number(&key("o"), float(line, "lineOffset"), defaults.offset);
    code.number(&key("a"), float(line, "opacity"), defaults.opacity);
    code.flag(&key("m"), flag(line, "bShowMovementError"), defaults.movement_error);
    code.number(&key("s"), float(line, "movementErrorScale"), defaults.movement_scale);
    code.flag(&key("f"), flag(line, "bShowShootingError"), defaults.firing_error);
    code.number(&key("e"), float(line, "firingErrorScale"), defaults.firing_scale);
    code.flag(&key("b"), flag(line, "bShowLines"), defaults.show);
}

fn channel(color: &Value, key: &str, default: u64) -> u64 {
    color.get(key).and_then(Value::as_f64).map(|value| value.round().clamp(0.0, 255.0) as u64).unwrap_or(default)
}

/// The share code for one saved profile's primary crosshair.
pub fn primary_code(profile: &Value) -> Option<String> {
    let primary = profile.get("primary")?;
    let mut code = Code(vec!["0".into(), "P".into()]);

    let custom = flag(primary, "bUseCustomColor").unwrap_or(false);
    let color = primary.get(if custom { "colorCustom" } else { "color" }).unwrap_or(&Value::Null);
    let rgb = (channel(color, "r", 255), channel(color, "g", 255), channel(color, "b", 255));
    match (!custom).then(|| PRESETS.iter().position(|preset| *preset == rgb)).flatten() {
        Some(0) => {}
        Some(index) => code.push("c", index.to_string()),
        None => {
            code.push("c", "8".into());
            code.push("u", format!("{:02X}{:02X}{:02X}{:02X}", rgb.0, rgb.1, rgb.2, channel(color, "a", 255)));
        }
    }
    code.flag("h", flag(primary, "bHasOutline"), true);
    code.number("t", float(primary, "outlineThickness"), 1.0);
    code.number("o", float(primary, "outlineOpacity"), 0.5);
    code.flag("d", flag(primary, "bDisplayCenterDot"), false);
    code.number("z", float(primary, "centerDotSize"), 2.0);
    code.number("a", float(primary, "centerDotOpacity"), 1.0);
    code.flag("f", flag(primary, "bFadeCrosshairWithFiringError"), true);
    code.flag("m", flag(primary, "bFixMinErrorAcrossWeapons"), false);
    line(&mut code, "0", primary.get("innerLines"), &INNER);
    line(&mut code, "1", primary.get("outerLines"), &OUTER);

    // Nothing differs from the default crosshair: the game's code is just "0".
    if code.0.len() == 2 {
        return Some("0".into());
    }
    Some(code.0.join(";"))
}

/// One entry per saved crosshair profile: name, code and whether it's active.
pub fn crosshair_codes(data: &Value) -> Vec<Value> {
    let current = data.get("currentProfile").and_then(Value::as_u64);
    data.get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, profile)| {
            let code = primary_code(profile)?;
            Some(json!({
                "name": profile.get("profileName").and_then(Value::as_str).filter(|name| !name.is_empty()),
                "code": code,
                "active": current == Some(index as u64),
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(show: bool, thickness: f64, length: f64, offset: f64, opacity: f64, movement: bool, firing: bool) -> Value {
        json!({
            "bShowLines": show, "lineThickness": thickness, "lineLength": length,
            "lineLengthVertical": length, "bAllowVertScaling": false, "lineOffset": offset,
            "opacity": opacity, "bShowMovementError": movement, "movementErrorScale": 1.0,
            "bShowShootingError": firing, "firingErrorScale": 1.0,
        })
    }

    fn profile(primary: Value) -> Value {
        json!({ "profileName": "Main", "primary": primary })
    }

    fn defaults() -> Value {
        json!({
            "color": { "r": 255, "g": 255, "b": 255, "a": 255 }, "bUseCustomColor": false,
            "colorCustom": { "r": 255, "g": 255, "b": 255, "a": 255 },
            "bHasOutline": true, "outlineThickness": 1.0, "outlineOpacity": 0.5,
            "bDisplayCenterDot": false, "centerDotSize": 2.0, "centerDotOpacity": 1.0,
            "bFadeCrosshairWithFiringError": true, "bFixMinErrorAcrossWeapons": false,
            "innerLines": line(true, 2.0, 6.0, 3.0, 0.800000011920929, false, true),
            "outerLines": line(true, 2.0, 2.0, 10.0, 0.3499999940395355, true, true),
        })
    }

    #[test]
    fn the_default_crosshair_is_code_zero() {
        assert_eq!(primary_code(&profile(defaults())).as_deref(), Some("0"));
    }

    #[test]
    fn rebuilds_the_documented_example_code() {
        // `0;P;c;5;h;0;0l;4;0o;2;0a;1;0f;0;1b;0`, the example in the decoder.
        let mut primary = defaults();
        primary["color"] = json!({ "r": 0, "g": 255, "b": 255, "a": 255 });
        primary["bHasOutline"] = json!(false);
        primary["innerLines"] = line(true, 2.0, 4.0, 2.0, 1.0, false, false);
        primary["innerLines"]["lineLengthVertical"] = json!(6.0);
        primary["outerLines"]["bShowLines"] = json!(false);
        assert_eq!(primary_code(&profile(primary)).as_deref(), Some("0;P;c;5;h;0;0l;4;0o;2;0a;1;0f;0;1b;0"));
    }

    #[test]
    fn custom_colors_use_c8_with_rgba_hex() {
        let mut primary = defaults();
        primary["bUseCustomColor"] = json!(true);
        primary["colorCustom"] = json!({ "r": 255, "g": 0, "b": 180, "a": 255 });
        primary["bDisplayCenterDot"] = json!(true);
        primary["centerDotSize"] = json!(3.0);
        assert_eq!(primary_code(&profile(primary)).as_deref(), Some("0;P;c;8;u;FF00B4FF;d;1;z;3"));
    }

    #[test]
    fn lists_every_profile_and_marks_the_active_one() {
        let data = json!({ "currentProfile": 1, "profiles": [profile(defaults()), { "profileName": "", "primary": defaults() }] });
        let codes = crosshair_codes(&data);
        assert_eq!(codes.len(), 2);
        assert_eq!(codes[0]["name"], "Main");
        assert_eq!(codes[1]["active"], true);
        assert!(codes[1]["name"].is_null());
    }
}

// ---------------------------------------------------------------------------
// Building a code from a plain description (MCP build_crosshair_code and the
// AI crosshair generator). Every value is clamped to the in-game slider range,
// so any description yields a valid code.
// ---------------------------------------------------------------------------

/// Preset names an agent or model may use, by code index.
const PRESET_NAMES: [&str; 8] = ["white", "green", "yellowgreen", "greenyellow", "yellow", "cyan", "pink", "red"];

/// The JSON schema of a crosshair description (shared by the MCP tool and the AI prompt).
pub fn spec_schema() -> Value {
    let line = |what: &str| {
        json!({
            "type": "object",
            "description": format!("{what} lines."),
            "properties": {
                "show": { "type": "boolean" },
                "length": { "type": "number", "minimum": 0, "maximum": 20 },
                "verticalLength": { "type": "number", "minimum": 0, "maximum": 20, "description": "Only when vertical lines differ from horizontal." },
                "thickness": { "type": "number", "minimum": 0, "maximum": 10 },
                "offset": { "type": "number", "minimum": 0, "maximum": 40 },
                "opacity": { "type": "number", "minimum": 0, "maximum": 1 },
                "movementError": { "type": "boolean", "description": "Lines spread while moving." },
                "firingError": { "type": "boolean", "description": "Lines spread while firing." },
            },
            "additionalProperties": false,
        })
    };
    json!({
        "type": "object",
        "properties": {
            "color": { "type": "string", "description": "white, green, yellowGreen, greenYellow, yellow, cyan, pink, red, or a hex color like #FF00B4." },
            "outlines": { "type": "boolean" },
            "outlineThickness": { "type": "number", "minimum": 1, "maximum": 6 },
            "outlineOpacity": { "type": "number", "minimum": 0, "maximum": 1 },
            "centerDot": { "type": "boolean" },
            "centerDotSize": { "type": "number", "minimum": 1, "maximum": 6 },
            "centerDotOpacity": { "type": "number", "minimum": 0, "maximum": 1 },
            "fadeWithFiringError": { "type": "boolean" },
            "innerLines": line("Inner"),
            "outerLines": line("Outer"),
        },
        "additionalProperties": false,
    })
}

fn clamp(value: Option<f64>, default: f64, min: f64, max: f64, step: f64) -> f64 {
    let value = value.filter(|value| value.is_finite()).unwrap_or(default).clamp(min, max);
    (value / step).round() * step
}

/// `(preset index, rgb)` for a color name or hex string.
fn parse_color(text: Option<&str>) -> (Option<usize>, (u64, u64, u64)) {
    let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) else {
        return (Some(0), PRESETS[0]);
    };
    let name: String = text.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    if let Some(index) = PRESET_NAMES.iter().position(|preset| *preset == name) {
        return (Some(index), PRESETS[index]);
    }
    let hex = text.trim_start_matches('#');
    if hex.len() >= 6 && hex[..6].chars().all(|c| c.is_ascii_hexdigit()) {
        let channel = |range: std::ops::Range<usize>| u64::from_str_radix(&hex[range], 16).unwrap_or(255);
        let rgb = (channel(0..2), channel(2..4), channel(4..6));
        return (PRESETS.iter().position(|preset| *preset == rgb), rgb);
    }
    (Some(0), PRESETS[0])
}

fn line_from_spec(spec: Option<&Value>, defaults: &LineDefaults, max_offset: f64) -> (Value, Value) {
    let empty = json!({});
    let spec = spec.filter(|spec| spec.is_object()).unwrap_or(&empty);
    let show = flag(spec, "show").unwrap_or(defaults.show);
    let length = clamp(float(spec, "length"), defaults.length, 0.0, 20.0, 1.0);
    let vertical = clamp(float(spec, "verticalLength"), length, 0.0, 20.0, 1.0);
    let thickness = clamp(float(spec, "thickness"), defaults.thickness, 0.0, 10.0, 1.0);
    let offset = clamp(float(spec, "offset"), defaults.offset, 0.0, max_offset, 1.0);
    let opacity = clamp(float(spec, "opacity"), defaults.opacity, 0.0, 1.0, 0.001);
    let movement = flag(spec, "movementError").unwrap_or(defaults.movement_error);
    let firing = flag(spec, "firingError").unwrap_or(defaults.firing_error);
    let riot = json!({
        "bShowLines": show, "lineThickness": thickness, "lineLength": length,
        "lineLengthVertical": vertical, "bAllowVertScaling": (vertical - length).abs() > 0.5,
        "lineOffset": offset, "opacity": opacity, "bShowMovementError": movement,
        "movementErrorScale": defaults.movement_scale, "bShowShootingError": firing,
        "firingErrorScale": defaults.firing_scale,
    });
    let normalized = json!({
        "show": show, "length": length, "verticalLength": vertical, "thickness": thickness,
        "offset": offset, "opacity": opacity, "movementError": movement, "firingError": firing,
    });
    (riot, normalized)
}

/// A share code from a plain crosshair description, plus the description as
/// applied (clamped, defaults filled in).
pub fn code_from_spec(spec: &Value) -> (String, Value) {
    let (preset, rgb) = parse_color(spec.get("color").and_then(Value::as_str));
    let color = json!({ "r": rgb.0, "g": rgb.1, "b": rgb.2, "a": 255 });
    let outlines = flag(spec, "outlines").unwrap_or(true);
    let outline_thickness = clamp(float(spec, "outlineThickness"), 1.0, 1.0, 6.0, 1.0);
    let outline_opacity = clamp(float(spec, "outlineOpacity"), 0.5, 0.0, 1.0, 0.001);
    let dot = flag(spec, "centerDot").unwrap_or(false);
    let dot_size = clamp(float(spec, "centerDotSize"), 2.0, 1.0, 6.0, 1.0);
    let dot_opacity = clamp(float(spec, "centerDotOpacity"), 1.0, 0.0, 1.0, 0.001);
    let fade = flag(spec, "fadeWithFiringError").unwrap_or(true);
    let (inner, inner_applied) = line_from_spec(spec.get("innerLines"), &INNER, 20.0);
    let (outer, outer_applied) = line_from_spec(spec.get("outerLines"), &OUTER, 40.0);
    let profile = json!({ "primary": {
        "color": color, "colorCustom": color, "bUseCustomColor": preset.is_none(),
        "bHasOutline": outlines, "outlineThickness": outline_thickness, "outlineOpacity": outline_opacity,
        "bDisplayCenterDot": dot, "centerDotSize": dot_size, "centerDotOpacity": dot_opacity,
        "bFadeCrosshairWithFiringError": fade, "bFixMinErrorAcrossWeapons": false,
        "innerLines": inner, "outerLines": outer,
    } });
    let applied = json!({
        "color": match preset {
            Some(index) => json!(PRESET_NAMES[index]),
            None => json!(format!("#{:02X}{:02X}{:02X}", rgb.0, rgb.1, rgb.2)),
        },
        "outlines": outlines, "outlineThickness": outline_thickness, "outlineOpacity": outline_opacity,
        "centerDot": dot, "centerDotSize": dot_size, "centerDotOpacity": dot_opacity,
        "fadeWithFiringError": fade, "innerLines": inner_applied, "outerLines": outer_applied,
    });
    (primary_code(&profile).unwrap_or_else(|| "0".into()), applied)
}

#[cfg(test)]
mod spec_tests {
    use super::*;

    #[test]
    fn an_empty_description_is_the_default_crosshair() {
        assert_eq!(code_from_spec(&json!({})).0, "0");
    }

    #[test]
    fn a_dot_only_crosshair() {
        let (code, applied) = code_from_spec(&json!({
            "color": "Cyan", "outlines": false, "centerDot": true, "centerDotSize": 2,
            "innerLines": { "show": false }, "outerLines": { "show": false },
        }));
        assert_eq!(code, "0;P;c;5;h;0;d;1;0b;0;1b;0");
        assert_eq!(applied["color"], "cyan");
    }

    #[test]
    fn values_are_clamped_and_hex_colors_match_presets() {
        let (code, applied) = code_from_spec(&json!({
            "color": "#ff0000", "innerLines": { "length": 99, "offset": -4, "opacity": 3 },
        }));
        assert_eq!(applied["color"], "red");
        assert_eq!(applied["innerLines"]["length"], 20.0);
        assert_eq!(code, "0;P;c;7;0l;20;0v;20;0o;0;0a;1");
        let (custom, _) = code_from_spec(&json!({ "color": "#FF00B4" }));
        assert_eq!(custom, "0;P;c;8;u;FF00B4FF");
    }
}
