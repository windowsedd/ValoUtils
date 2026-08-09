use serde_json::{json, Value};

const PREFERENCES_URL: &str = "https://player-preferences-usw2.pp.sgp.pvp.net/playerPref/v3/getPreference/Ares.PlayerSettings";
const SAVE_PREFERENCES_URL: &str =
    "https://player-preferences-usw2.pp.sgp.pvp.net/playerPref/v3/savePreference";

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// `tokens` is the raw JSON returned by riot::client::get_tokens (accessToken/token fields).
pub async fn get_preferences(tokens: &Value) -> Result<Value, String> {
    let access_token = tokens
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let entitlement = tokens
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let response = client()
        .get(PREFERENCES_URL)
        .bearer_auth(access_token)
        .header("X-Riot-Entitlements-JWT", entitlement)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    response.json::<Value>().await.map_err(|e| e.to_string())
}

pub async fn load_settings(tokens: &Value, profile_data: &str) -> Result<Value, String> {
    let access_token = tokens
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let entitlement = tokens
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let response = client()
        .put(SAVE_PREFERENCES_URL)
        .bearer_auth(access_token)
        .header("X-Riot-Entitlements-JWT", entitlement)
        .json(&json!({
            "type": "Ares.PlayerSettings",
            "data": profile_data,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    response.json::<Value>().await.map_err(|e| e.to_string())
}
