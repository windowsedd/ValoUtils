use crate::riot::client::{self, RiotState};
use base64::Engine;
use serde_json::Value;
use std::sync::OnceLock;

fn region_to_shard(region: &str) -> String {
    match region.to_uppercase().as_str() {
        "NA" => "na",
        "LATAM" => "latam",
        "BR" => "br",
        "EU" => "eu",
        "AP" => "ap",
        "KR" => "kr",
        "TW2" | "SG2" | "JP" | "VN2" => "ap",
        "PBE" => "na",
        other => return other.to_lowercase(),
    }
    .to_string()
}

fn client_platform_header() -> &'static str {
    static HEADER: OnceLock<String> = OnceLock::new();
    HEADER.get_or_init(|| {
        // Raw string (not the json! macro) so the key order and byte-exact
        // value match what the Electron app sent — serde_json sorts object
        // keys alphabetically, and Riot's glz endpoints validate this header.
        let json = r#"{"platformType":"PC","platformOS":"Windows","platformOSVersion":"10.0.19042.1.256.64bit","platformChipset":"Unknown"}"#;
        base64::engine::general_purpose::STANDARD.encode(json)
    })
}


fn public_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// glz endpoints reject requests without X-Riot-ClientVersion
/// (400 INVALID_HEADERS), so when the local product-session lookup comes back
/// empty (Valorant not running), fall back to the community version API.
async fn fallback_client_version() -> Option<String> {
    let response = public_client().get("https://valorant-api.com/v1/version").send().await.ok()?;
    let body: Value = response.json().await.ok()?;
    body.pointer("/data/riotClientVersion").and_then(|v| v.as_str()).map(|s| s.to_string())
}

enum Target {
    Pd,
    Glz,
}

/// Authenticated client for Riot's `pd`/`glz` game APIs, built from local
/// Riot Client tokens. Mirrors electron/util/riot/create-api.ts.
pub struct RiotApiClient {
    pub puuid: String,
    pub region: String,
    pub client_version: String,
    access_token: String,
    entitlement_token: String,
}

impl RiotApiClient {
    fn base_url(&self, target: &Target) -> String {
        match target {
            Target::Glz => format!("https://glz-{}-1.{}.a.pvp.net", self.region, self.region),
            Target::Pd => format!("https://pd.{}.a.pvp.net", self.region),
        }
    }

    async fn request(&self, target: Target, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url(&target), path);
        let mut req = public_client()
            .request(method, &url)
            .bearer_auth(&self.access_token)
            .header("X-Riot-Entitlements-JWT", &self.entitlement_token)
            .header("X-Riot-ClientPlatform", client_platform_header());
        if !self.client_version.is_empty() {
            req = req.header("X-Riot-ClientVersion", &self.client_version);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }

        let response = req.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{{\"status\":{},\"path\":{:?},\"message\":{:?}}}", status.as_u16(), path, text));
        }
        serde_json::from_str(&text).or(Ok(Value::String(text)))
    }

    pub async fn get_names(&self, puuids: &[String]) -> Result<Value, String> {
        self.request(Target::Pd, reqwest::Method::PUT, "/nameservice/v2/players", Some(serde_json::json!(puuids))).await
    }
    pub async fn get_mmr(&self, puuid: &str) -> Result<Value, String> {
        self.request(Target::Pd, reqwest::Method::GET, &format!("/mmr/v1/players/{puuid}"), None).await
    }
    pub async fn get_competitive_history(&self, puuid: &str, start_index: u32, end_index: u32) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!("/mmr/v1/players/{puuid}/competitiveupdates?startIndex={start_index}&endIndex={end_index}&queue=competitive"),
            None,
        )
        .await
    }
    pub async fn get_match_details(&self, match_id: &str) -> Result<Value, String> {
        self.request(Target::Pd, reqwest::Method::GET, &format!("/match-details/v1/matches/{match_id}"), None).await
    }
    pub async fn party_get_by_player(&self, puuid: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/parties/v1/players/{puuid}"), None).await
    }
    pub async fn party_get(&self, party_id: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/parties/v1/parties/{party_id}"), None).await
    }
    pub async fn party_get_chat_token(&self, party_id: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/parties/v1/parties/{party_id}/muctoken"), None).await
    }
    pub async fn party_invite(&self, party_id: &str, name: &str, tagline: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::POST,
            &format!("/parties/v1/parties/{party_id}/invites/name/{}/tag/{}", crate::riot::client::urlencoding_encode(name), crate::riot::client::urlencoding_encode(tagline)),
            None,
        )
        .await
    }
    pub async fn party_request(&self, party_id: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::POST, &format!("/parties/v1/parties/{party_id}/request"), None).await
    }
    pub async fn pregame_get_player(&self, puuid: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/pregame/v1/players/{puuid}"), None).await
    }
    pub async fn pregame_get_match(&self, match_id: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/pregame/v1/matches/{match_id}"), None).await
    }
    pub async fn pregame_get_loadouts(&self, match_id: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/pregame/v1/matches/{match_id}/loadouts"), None).await
    }
    pub async fn coregame_get_player(&self, puuid: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/core-game/v1/players/{puuid}"), None).await
    }
    pub async fn coregame_get_match(&self, match_id: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/core-game/v1/matches/{match_id}"), None).await
    }
    pub async fn coregame_get_loadouts(&self, match_id: &str) -> Result<Value, String> {
        self.request(Target::Glz, reqwest::Method::GET, &format!("/core-game/v1/matches/{match_id}/loadouts"), None).await
    }
}

/// Builds an authenticated Riot API client from the local Riot Client
/// tokens. Errors when the lockfile is missing or Riot Client isn't signed in.
pub async fn create_api(state: &RiotState) -> Result<RiotApiClient, String> {
    let tokens = client::get_tokens(state, false).await?;
    let locale = client::get_region_locale(state).await?;
    let mut client_version = client::get_valorant_client_version(state).await.unwrap_or_default();
    if client_version.is_empty() {
        client_version = fallback_client_version().await.unwrap_or_default();
    }

    let region_raw = locale.get("region").and_then(|v| v.as_str()).unwrap_or("na");
    let region = region_to_shard(region_raw);

    Ok(RiotApiClient {
        puuid: tokens.get("subject").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        region,
        client_version,
        access_token: tokens.get("accessToken").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        entitlement_token: tokens.get("token").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
    })
}
