use serde_json::Value;
use std::io::Read;

/// Decodes the base64+raw-deflate blob stored in `Ares.PlayerSettings` /
/// `profile.data` into the underlying settings JSON. Mirrors
/// electron/util/settings-decoder.ts's use of Node's `zlib.inflateRawSync`.
pub fn decode_profile_data(data: &str) -> Result<Value, String> {
    use base64::Engine;
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;

    let mut decoder = flate2::read::DeflateDecoder::new(&compressed[..]);
    let mut inflated = String::new();
    decoder.read_to_string(&mut inflated).map_err(|e| e.to_string())?;

    serde_json::from_str(&inflated).map_err(|e| e.to_string())
}

/// Pulls the `SavedCrosshairProfileData` string setting out of a decoded
/// settings object and parses its embedded JSON.
pub fn extract_crosshair_profiles(decoded: &Value) -> Option<Value> {
    let entry = decoded
        .get("stringSettings")?
        .as_array()?
        .iter()
        .find(|s| s.get("settingEnum").and_then(|v| v.as_str()) == Some("EAresStringSettingName::SavedCrosshairProfileData"))?;

    let value_str = entry.get("value")?.as_str()?;
    serde_json::from_str(value_str).ok()
}
