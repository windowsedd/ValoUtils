use crate::riot::client::{self, RiotState};
use base64::Engine;
use serde_json::Value;
use std::sync::OnceLock;

pub(crate) fn region_to_shard(region: &str) -> String {
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

/// Riot expects `X-Riot-ClientVersion` to look like
/// `release-13.02-shipping-10-5229475`. The local product-session lookup reports
/// a build hash instead (e.g. `0127606AA79E4164`), and sending that gets a
/// **500 INTERNAL_UNHANDLED_SERVER_ERROR** back from `pd` — omitting the header
/// entirely gets a cleaner 400 INVALID_HEADERS. So anything that isn't shaped
/// like a real version string is rejected here in favour of the community API.
fn looks_like_client_version(version: &str) -> bool {
    version.starts_with("release-") && version.contains("-shipping-")
}

/// Cached because `create_api` runs on every command — including the ~5s Live
/// Game poll — and the local lookup essentially never yields a usable version,
/// so this fallback is the normal path rather than the exception.
async fn fallback_client_version() -> Option<String> {
    static CACHE: OnceLock<String> = OnceLock::new();
    if let Some(cached) = CACHE.get() {
        return Some(cached.clone());
    }
    let response = public_client()
        .get("https://valorant-api.com/v1/version")
        .send()
        .await
        .ok()?;
    let body: Value = response.json().await.ok()?;
    let version = body
        .pointer("/data/riotClientVersion")
        .and_then(|v| v.as_str())?
        .to_string();
    let _ = CACHE.set(version.clone());
    Some(version)
}

enum Target {
    Pd,
    Glz,
}

fn competitive_leaderboard_path(region: &str, season_id: &str) -> String {
    format!(
        "/mmr/v1/leaderboards/affinity/{region}/queue/competitive/season/{}?startIndex=0&size=1",
        client::urlencoding_encode(season_id)
    )
}

/// Live party MUC when the local conversation listing has not caught up yet.
pub async fn active_party_muc(
    access_token: &str,
    entitlement_token: &str,
    puuid: &str,
    region: &str,
) -> Option<String> {
    if access_token.is_empty() || puuid.is_empty() {
        return None;
    }
    let client_version = fallback_client_version().await.unwrap_or_default();
    let api = RiotApiClient {
        puuid: puuid.to_string(),
        region: region_to_shard(region),
        client_version,
        access_token: access_token.to_string(),
        entitlement_token: entitlement_token.to_string(),
    };
    let player = api.party_get_by_player(puuid).await.ok()?;
    let party_id = player
        .get("CurrentPartyID")
        .or_else(|| player.get("PartyID"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let details = api.party_get(party_id).await.ok()?;
    party_muc_name(&details)
        .filter(|cid| crate::riot::models::ChatChannel::Party.matches_cid(cid))
        .map(str::to_string)
}

fn glz_client(
    access_token: &str,
    entitlement_token: &str,
    puuid: &str,
    region: &str,
    client_version: String,
) -> RiotApiClient {
    RiotApiClient {
        puuid: puuid.to_string(),
        region: region_to_shard(region),
        client_version,
        access_token: access_token.to_string(),
        entitlement_token: entitlement_token.to_string(),
    }
}

/// Blue/Red of the signed-in player in the current pregame or live match.
pub async fn local_team_side(
    access_token: &str,
    entitlement_token: &str,
    puuid: &str,
    region: &str,
) -> Option<crate::riot::models::MatchSide> {
    if access_token.is_empty() || puuid.is_empty() {
        return None;
    }
    let client_version = fallback_client_version().await.unwrap_or_default();
    let api = glz_client(
        access_token,
        entitlement_token,
        puuid,
        region,
        client_version,
    );
    if let Ok(core) = api.coregame_get_player(puuid).await {
        if let Some(match_id) = core.get("MatchID").and_then(Value::as_str) {
            if let Ok(match_data) = api.coregame_get_match(match_id).await {
                if let Some(side) = crate::riot::models::local_match_side(puuid, &match_data) {
                    return Some(side);
                }
            }
        }
    }
    let pre = api.pregame_get_player(puuid).await.ok()?;
    let match_id = pre.get("MatchID").and_then(Value::as_str)?;
    let match_data = api.pregame_get_match(match_id).await.ok()?;
    crate::riot::models::local_match_side(puuid, &match_data)
}

pub fn party_muc_name(party: &Value) -> Option<&str> {
    party
        .get("MUCName")
        .or_else(|| party.get("mucName"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

/// Authenticated client for Riot's `pd`/`glz` game APIs, built from local
/// Riot Client tokens. Mirrors electron/util/riot/create-api.ts.
#[derive(Clone)]
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

    async fn request(
        &self,
        target: Target,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
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
            return Err(format!(
                "{{\"status\":{},\"path\":{:?},\"message\":{:?}}}",
                status.as_u16(),
                path,
                text
            ));
        }
        serde_json::from_str(&text).or(Ok(Value::String(text)))
    }

    /// Resolve puuids -> Riot IDs. Note the hyphen: `/nameservice/...` (no
    /// hyphen) is a dead route that answers 503, so a typo here fails silently
    /// and every player renders nameless.
    pub async fn get_names(&self, puuids: &[String]) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::PUT,
            "/name-service/v2/players",
            Some(serde_json::json!(puuids)),
        )
        .await
    }

    /// The player's storefront: daily offers, featured bundle, Night Market and
    /// the accessory store, all in one document.
    ///
    /// Riot moved this to `POST /store/v3/...` with an empty body; the older
    /// `GET /store/v2/...` still answers on some deployments. Try the current
    /// shape first and fall back, so a client-side version skew shows up as
    /// data rather than an error.
    pub async fn get_storefront(&self, puuid: &str) -> Result<Value, String> {
        let v3 = self
            .request(
                Target::Pd,
                reqwest::Method::POST,
                &format!("/store/v3/storefront/{puuid}"),
                Some(serde_json::json!({})),
            )
            .await;
        match v3 {
            Ok(value) => Ok(value),
            Err(v3_error) => self
                .request(
                    Target::Pd,
                    reqwest::Method::GET,
                    &format!("/store/v2/storefront/{puuid}"),
                    None,
                )
                .await
                .map_err(|v2_error| format!("{v3_error}; fallback: {v2_error}")),
        }
    }
    /// VP / Radianite / Kingdom Credit balances.
    pub async fn get_wallet(&self, puuid: &str) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!("/store/v1/wallet/{puuid}"),
            None,
        )
        .await
    }
    pub async fn get_contracts(&self, puuid: &str) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!("/contracts/v1/contracts/{puuid}"),
            None,
        )
        .await
    }
    pub async fn get_entitlements(&self, puuid: &str, item_type_id: &str) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!("/store/v1/entitlements/{puuid}/{item_type_id}"),
            None,
        )
        .await
    }

    /// Equipped cosmetics: guns, sprays, card, title, expression.
    pub async fn get_player_loadout(&self, puuid: &str) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!("/personalization/v2/players/{puuid}/playerloadout"),
            None,
        )
        .await
    }
    pub async fn get_mmr(&self, puuid: &str) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!("/mmr/v1/players/{puuid}"),
            None,
        )
        .await
    }
    pub async fn get_competitive_history(
        &self,
        puuid: &str,
        start_index: u32,
        end_index: u32,
    ) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!("/mmr/v1/players/{puuid}/competitiveupdates?startIndex={start_index}&endIndex={end_index}&queue=competitive"),
            None,
        )
        .await
    }
    pub async fn get_competitive_leaderboard(&self, season_id: &str) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &competitive_leaderboard_path(&self.region, season_id),
            None,
        )
        .await
    }
    pub async fn get_match_history(
        &self,
        puuid: &str,
        start_index: u32,
        end_index: u32,
    ) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!(
                "/match-history/v1/history/{puuid}?startIndex={start_index}&endIndex={end_index}"
            ),
            None,
        )
        .await
    }
    pub async fn get_match_details(&self, match_id: &str) -> Result<Value, String> {
        self.request(
            Target::Pd,
            reqwest::Method::GET,
            &format!("/match-details/v1/matches/{match_id}"),
            None,
        )
        .await
    }
    pub async fn party_get_by_player(&self, puuid: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/parties/v1/players/{puuid}"),
            None,
        )
        .await
    }
    pub async fn party_get(&self, party_id: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/parties/v1/parties/{party_id}"),
            None,
        )
        .await
    }
    pub async fn party_get_chat_token(&self, party_id: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/parties/v1/parties/{party_id}/muctoken"),
            None,
        )
        .await
    }
    pub async fn party_invite(
        &self,
        party_id: &str,
        name: &str,
        tagline: &str,
    ) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::POST,
            &format!(
                "/parties/v1/parties/{party_id}/invites/name/{}/tag/{}",
                crate::riot::client::urlencoding_encode(name),
                crate::riot::client::urlencoding_encode(tagline)
            ),
            None,
        )
        .await
    }
    pub async fn party_request(&self, party_id: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::POST,
            &format!("/parties/v1/parties/{party_id}/request"),
            None,
        )
        .await
    }
    pub async fn pregame_get_player(&self, puuid: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/pregame/v1/players/{puuid}"),
            None,
        )
        .await
    }
    pub async fn pregame_get_match(&self, match_id: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/pregame/v1/matches/{match_id}"),
            None,
        )
        .await
    }
    pub async fn pregame_get_loadouts(&self, match_id: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/pregame/v1/matches/{match_id}/loadouts"),
            None,
        )
        .await
    }
    pub async fn coregame_get_player(&self, puuid: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/core-game/v1/players/{puuid}"),
            None,
        )
        .await
    }
    pub async fn coregame_get_match(&self, match_id: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/core-game/v1/matches/{match_id}"),
            None,
        )
        .await
    }
    pub async fn coregame_get_loadouts(&self, match_id: &str) -> Result<Value, String> {
        self.request(
            Target::Glz,
            reqwest::Method::GET,
            &format!("/core-game/v1/matches/{match_id}/loadouts"),
            None,
        )
        .await
    }
}

/// True for the errors Riot returns when the RSO access token is no longer
/// good — expired, or belonging to an account that has since been switched away
/// from. Both are fixed by re-reading tokens from the Riot Client.
pub fn is_auth_error(error: &str) -> bool {
    error.contains("BAD_CLAIMS")
        || error.contains("UNAUTHORIZED")
        || error.contains("\"status\":401")
}

/// Runs `f` against an authenticated client, retrying **once** with freshly
/// fetched tokens if the first attempt fails RSO validation.
///
/// Without this, switching Riot accounts breaks every remote call until the
/// token cache happens to expire, because the cached token still parses fine
/// locally — it's only the game API that rejects it.
pub async fn with_api<T, F, Fut>(state: &RiotState, f: F) -> Result<T, String>
where
    F: Fn(RiotApiClient) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let api = create_api(state).await?;
    match f(api).await {
        Err(e) if is_auth_error(&e) => {
            client::invalidate_tokens(state);
            let api = create_api(state).await?;
            f(api).await
        }
        other => other,
    }
}

/// Builds an authenticated Riot API client from the local Riot Client
/// tokens. Errors when the lockfile is missing or Riot Client isn't signed in.
pub async fn create_api(state: &RiotState) -> Result<RiotApiClient, String> {
    let tokens = client::get_tokens(state, false).await?;
    let locale = client::get_region_locale(state).await?;
    let mut client_version = client::get_valorant_client_version(state)
        .await
        .unwrap_or_default();
    if !looks_like_client_version(&client_version) {
        client_version = fallback_client_version().await.unwrap_or_default();
    }

    let region_raw = locale
        .get("region")
        .and_then(|v| v.as_str())
        .unwrap_or("na");
    let region = region_to_shard(region_raw);

    Ok(RiotApiClient {
        puuid: tokens
            .get("subject")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        region,
        client_version,
        access_token: tokens
            .get("accessToken")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        entitlement_token: tokens
            .get("token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_regional_competitive_leaderboard_path() {
        assert_eq!(
            competitive_leaderboard_path("ap", "act/current"),
            "/mmr/v1/leaderboards/affinity/ap/queue/competitive/season/act%2Fcurrent?startIndex=0&size=1"
        );
    }

    #[test]
    fn extracts_party_muc_name_from_party_details() {
        let party = serde_json::json!({ "MUCName": "party@ares-parties.ap" });

        assert_eq!(party_muc_name(&party), Some("party@ares-parties.ap"));
    }

    #[test]
    fn rejects_missing_or_empty_party_muc_name() {
        assert_eq!(party_muc_name(&serde_json::json!({})), None);
        assert_eq!(party_muc_name(&serde_json::json!({ "MUCName": "" })), None);
    }

    #[tokio::test]
    async fn active_party_muc_skips_without_tokens() {
        assert!(active_party_muc("", "ent", "player", "ap").await.is_none());
        assert!(active_party_muc("access", "ent", "", "ap").await.is_none());
    }
}
