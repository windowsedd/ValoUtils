//! Reading and sending VALORANT chat through the local Riot Client API.
//!
//! # Channel routing
//!
//! Four rooms are reachable, and each one is resolved independently:
//!
//! | Channel   | Listing endpoint              | CID selected by            |
//! |-----------|-------------------------------|----------------------------|
//! | `Party`   | `.../conversations/ares-parties`  | the party room; falls back to all conversations, then the live party MUC |
//! | `Pregame` | `.../conversations/ares-pregame`  | the only conversation there |
//! | `Team`    | `.../conversations/ares-coregame` | CID contains `blue@ares` or `red@ares` |
//! | `All`     | `.../conversations/ares-coregame` | CID contains `all@ares`    |
//!
//! Resolution searches the whole `conversations` array. Riot does not promise
//! an order, and the coregame endpoint returns the team room and the all room
//! side by side, so indexing into `[0]` and `[1]` would pick whichever landed
//! first that match.
//!
//! Crucially, `Team` and `All` never substitute for one another. If a player
//! asks for `All` during a match where only the team room resolved, this module
//! returns [`RiotError::ChannelUnavailable`] instead of quietly delivering the
//! message to their team - which is exactly the bug the Java implementation
//! shipped.
//!
//! # Credential handling
//!
//! The lockfile password goes into `basic_auth("riot", ...)` and nowhere else.
//! The client is pinned to loopback at construction, refuses a non-loopback
//! base URL, and disables any system proxy so the credential cannot be routed
//! through one. Errors carry a status code at most - never a response body.

use crate::riot::error::RiotError;
use crate::riot::lockfile::{self, Lockfile};
use crate::riot::models::{
    filter_messages_by_cid, messages_path_for_cid, pick_team_cid, sanitize_cid_for_log,
    validate_riot_cid, ChatChannel, ChatMessage, Conversation, ConversationsResponse,
    MessagesResponse, SendMessageRequest, PATH_CONVERSATIONS, PATH_MESSAGES, PATH_SEND_MESSAGE,
};
use serde::de::DeserializeOwned;
use std::time::Duration;

#[derive(Clone)]
pub struct RiotChatClient {
    http: reqwest::Client,
    base_url: String,
    lockfile: Lockfile,
}

/// Hand-written so a `{:?}` of this struct cannot print the embedded
/// credential. `Lockfile` redacts itself, but the base URL is spelled out here
/// and there is no reason to widen what a log line can show.
impl std::fmt::Debug for RiotChatClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RiotChatClient")
            .field("base_url", &"<loopback>")
            .field("lockfile", &self.lockfile)
            .finish()
    }
}

/// Guards the credential-bearing client against ever being pointed off-box.
///
/// In production the base URL is derived from the lockfile and is loopback by
/// construction; this exists so that the test seam - the one place an arbitrary
/// URL can be supplied - cannot be misused to send Basic credentials to a
/// remote host.
fn conversation_init_retry() -> Duration {
    if cfg!(test) {
        Duration::ZERO
    } else {
        Duration::from_millis(1500)
    }
}

fn stamp_messages(
    messages: Vec<crate::riot::models::RawMessage>,
    channel: ChatChannel,
) -> Vec<ChatMessage> {
    messages
        .into_iter()
        .map(|raw| ChatMessage::from_raw(raw, channel))
        .collect()
}

fn is_loopback_base(base_url: &str) -> bool {
    let Some(rest) = base_url
        .strip_prefix("https://")
        .or_else(|| base_url.strip_prefix("http://"))
    else {
        return false;
    };
    let host = rest
        .split('/')
        .next()
        .unwrap_or_default()
        .rsplit_once(':')
        .map(|(host, _port)| host)
        .unwrap_or(rest.split('/').next().unwrap_or_default());
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

impl RiotChatClient {
    /// Builds a client for the running Riot Client.
    pub fn connect() -> Result<Self, RiotError> {
        Self::from_lockfile(lockfile::read()?)
    }

    pub fn from_lockfile(lockfile: Lockfile) -> Result<Self, RiotError> {
        let base_url = lockfile.base_url();
        Self::with_base_url(base_url, lockfile)
    }

    /// The test seam. `base_url` must be loopback.
    ///
    /// `danger_accept_invalid_certs` is required because the Riot Client serves
    /// a self-signed certificate on localhost. It is scoped to this client, and
    /// this client only ever talks to 127.0.0.1 - enforced above.
    pub fn with_base_url(
        base_url: impl Into<String>,
        lockfile: Lockfile,
    ) -> Result<Self, RiotError> {
        let base_url = base_url.into();
        let base_url = base_url.trim_end_matches('/').to_string();
        if !is_loopback_base(&base_url) {
            return Err(RiotError::NotConnected);
        }

        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            // A system proxy must never see a request carrying the lockfile
            // credential, even for a loopback address.
            .no_proxy()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(RiotError::from_transport)?;

        Ok(Self {
            http,
            base_url,
            lockfile,
        })
    }

    pub fn lockfile(&self) -> &Lockfile {
        &self.lockfile
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, RiotError> {
        let response = self
            .http
            .get(format!("{}{path}", self.base_url))
            .query(query)
            .basic_auth("riot", Some(self.lockfile.password()))
            .send()
            .await
            .map_err(RiotError::from_transport)?;

        let status = response.status();
        if !status.is_success() {
            return Err(RiotError::Http {
                status: status.as_u16(),
            });
        }

        let bytes = response.bytes().await.map_err(RiotError::from_transport)?;
        serde_json::from_slice(&bytes).map_err(|_| RiotError::UnreadableResponse)
    }

    /// Finds the CID for `channel`, searching every returned conversation.
    pub async fn resolve_cid(&self, channel: ChatChannel) -> Result<String, RiotError> {
        let dedicated = self
            .listed_cids(channel.conversations_path(), channel)
            .await?;
        let all = self.listed_cids(PATH_CONVERSATIONS, channel).await?;
        let mut cids = dedicated;
        for cid in all {
            if !cids.iter().any(|existing| existing == &cid) {
                cids.push(cid);
            }
        }
        let side = if matches!(channel, ChatChannel::Team | ChatChannel::Pregame) {
            self.local_team_side().await
        } else {
            None
        };
        if matches!(channel, ChatChannel::Team | ChatChannel::Pregame) {
            if let Some(cid) = pick_team_cid(cids.iter().map(String::as_str), side) {
                return Ok(cid);
            }
        } else if let Some(cid) = cids.into_iter().next() {
            return Ok(cid);
        }
        if channel == ChatChannel::Party {
            if let Some(cid) = self.active_party_muc().await {
                return Ok(cid);
            }
        }
        Err(RiotError::ChannelUnavailable { channel })
    }

    async fn listed_conversations(&self, path: &str) -> Result<Vec<Conversation>, RiotError> {
        let response: ConversationsResponse = self.get_json(path, &[]).await?;
        Ok(response
            .conversations
            .into_iter()
            .filter(|conversation| !conversation.cid.is_empty())
            .collect())
    }

    async fn listed_cids(
        &self,
        path: &str,
        channel: ChatChannel,
    ) -> Result<Vec<String>, RiotError> {
        Ok(self
            .listed_conversations(path)
            .await?
            .into_iter()
            .map(|conversation| conversation.cid)
            .filter(|cid| channel.matches_cid(cid))
            .collect())
    }

    async fn lookup_conversation(
        &self,
        cid: &str,
        channel: ChatChannel,
    ) -> Result<Option<Conversation>, RiotError> {
        let mut listed = self
            .listed_conversations(channel.conversations_path())
            .await?;
        listed.extend(self.listed_conversations(PATH_CONVERSATIONS).await?);
        Ok(listed
            .into_iter()
            .find(|conversation| conversation.cid == cid && channel.matches_cid(&conversation.cid)))
    }

    async fn require_active_conversation(
        &self,
        cid: &str,
        channel: ChatChannel,
    ) -> Result<Conversation, RiotError> {
        if let Some(found) = self.lookup_conversation(cid, channel).await? {
            return Ok(found);
        }
        tokio::time::sleep(conversation_init_retry()).await;
        self.lookup_conversation(cid, channel)
            .await?
            .ok_or(RiotError::StaleConversation { channel })
    }

    async fn active_party_muc(&self) -> Option<String> {
        #[derive(serde::Deserialize, Default)]
        struct Token {
            #[serde(default)]
            subject: String,
            #[serde(default, rename = "accessToken")]
            access_token: String,
            #[serde(default)]
            token: String,
        }
        #[derive(serde::Deserialize, Default)]
        struct Locale {
            #[serde(default)]
            region: String,
        }

        let entitlements: Token = self.get_json("/entitlements/v1/token", &[]).await.ok()?;
        let locale: Locale = self
            .get_json("/riotclient/region-locale", &[])
            .await
            .unwrap_or_default();
        crate::riot::api::active_party_muc(
            &entitlements.access_token,
            &entitlements.token,
            &entitlements.subject,
            &locale.region,
        )
        .await
    }

    async fn local_team_side(&self) -> Option<crate::riot::models::MatchSide> {
        #[derive(serde::Deserialize, Default)]
        struct Token {
            #[serde(default)]
            subject: String,
            #[serde(default, rename = "accessToken")]
            access_token: String,
            #[serde(default)]
            token: String,
        }
        #[derive(serde::Deserialize, Default)]
        struct Locale {
            #[serde(default)]
            region: String,
        }
        let entitlements: Token = self.get_json("/entitlements/v1/token", &[]).await.ok()?;
        let locale: Locale = self
            .get_json("/riotclient/region-locale", &[])
            .await
            .unwrap_or_default();
        crate::riot::api::local_team_side(
            &entitlements.access_token,
            &entitlements.token,
            &entitlements.subject,
            &locale.region,
        )
        .await
    }

    /// History for `channel`, with every message stamped with the channel it
    /// came from so a reply can be routed back to the same room.
    pub async fn get_messages(&self, channel: ChatChannel) -> Result<Vec<ChatMessage>, RiotError> {
        let cid = self.resolve_cid(channel).await?;
        self.get_messages_for_cid(&cid, channel).await
    }

    /// History for an already-resolved CID.
    ///
    /// The poller uses this so it can resolve each channel once per tick rather
    /// than twice. The specific-history URL interpolates a validated CID so `@`
    /// stays `@`; a 404 falls back to the unfiltered list and exact-cid filter.
    pub async fn get_recent_messages(&self) -> Result<Vec<ChatMessage>, RiotError> {
        let response = self.get_messages_payload(PATH_MESSAGES).await?;
        Ok(response
            .messages
            .into_iter()
            .filter_map(|raw| {
                let channel = ChatChannel::EVERY
                    .into_iter()
                    .find(|channel| channel.matches_cid(&raw.cid))?;
                Some(ChatMessage::from_raw(raw, channel))
            })
            .collect())
    }

    pub async fn get_messages_for_cid(
        &self,
        cid: &str,
        channel: ChatChannel,
    ) -> Result<Vec<ChatMessage>, RiotError> {
        let cid = validate_riot_cid(cid)?.to_string();
        if !channel.matches_cid(&cid) {
            return Err(RiotError::ChannelUnavailable { channel });
        }
        let conversation = self.require_active_conversation(&cid, channel).await?;
        if conversation.message_history == Some(false) {
            log::info!(
                "GET {PATH_MESSAGES} channel={} cid={} fallback=true reason=message_history_false",
                channel.as_str(),
                sanitize_cid_for_log(&cid)
            );
            return self.fallback_messages_for_cid(&cid, channel).await;
        }

        match self
            .get_messages_payload(&messages_path_for_cid(&cid)?)
            .await
        {
            Ok(payload) => Ok(stamp_messages(payload.messages, channel)),
            Err(RiotError::ConversationNotFound) => {
                if self
                    .require_active_conversation(&cid, channel)
                    .await
                    .is_err()
                {
                    return Err(RiotError::StaleConversation { channel });
                }
                log::info!(
                    "GET {PATH_MESSAGES} status=404 channel={} cid={} fallback=true",
                    channel.as_str(),
                    sanitize_cid_for_log(&cid)
                );
                self.fallback_messages_for_cid(&cid, channel).await
            }
            Err(error) => Err(error),
        }
    }

    async fn fallback_messages_for_cid(
        &self,
        cid: &str,
        channel: ChatChannel,
    ) -> Result<Vec<ChatMessage>, RiotError> {
        let payload = self.get_messages_payload(PATH_MESSAGES).await?;
        Ok(stamp_messages(
            filter_messages_by_cid(payload.messages, cid),
            channel,
        ))
    }

    async fn get_messages_payload(&self, path: &str) -> Result<MessagesResponse, RiotError> {
        let url = format!("{}{path}", self.base_url.trim_end_matches('/'));
        let response = self
            .http
            .get(&url)
            .basic_auth("riot", Some(self.lockfile.password()))
            .send()
            .await
            .map_err(RiotError::from_transport)?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            let text = response.text().await.unwrap_or_default();
            if text.contains("RESOURCE_NOT_FOUND") || text.contains("Invalid URI") {
                return Err(RiotError::RiotClientUnavailable);
            }
            return Err(RiotError::ConversationNotFound);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(RiotError::AuthenticationFailed {
                status: status.as_u16(),
            });
        }
        if !status.is_success() {
            return Err(RiotError::RequestFailed {
                status: status.as_u16(),
            });
        }
        let bytes = response.bytes().await.map_err(RiotError::from_transport)?;
        serde_json::from_slice(&bytes).map_err(|_| RiotError::UnreadableResponse)
    }

    pub async fn send_message(&self, channel: ChatChannel, message: &str) -> Result<(), RiotError> {
        if message.trim().is_empty() {
            return Err(RiotError::EmptyMessage);
        }
        let cid = self.resolve_cid(channel).await?;
        self.send_to_cid(&cid, message).await
    }

    pub async fn send_to_cid(&self, cid: &str, message: &str) -> Result<(), RiotError> {
        if message.trim().is_empty() {
            return Err(RiotError::EmptyMessage);
        }

        let body = SendMessageRequest::groupchat(cid, message);
        let response = self
            .http
            .post(format!("{}{PATH_SEND_MESSAGE}", self.base_url))
            .basic_auth("riot", Some(self.lockfile.password()))
            .json(&body)
            .send()
            .await
            .map_err(RiotError::from_transport)?;

        let status = response.status();
        if !status.is_success() {
            return Err(RiotError::Http {
                status: status.as_u16(),
            });
        }
        Ok(())
    }

    pub async fn send_to_party(&self, message: &str) -> Result<(), RiotError> {
        self.send_message(ChatChannel::Party, message).await
    }

    pub async fn send_to_pregame(&self, message: &str) -> Result<(), RiotError> {
        self.send_message(ChatChannel::Pregame, message).await
    }

    pub async fn send_to_team(&self, message: &str) -> Result<(), RiotError> {
        self.send_message(ChatChannel::Team, message).await
    }

    pub async fn send_to_all(&self, message: &str) -> Result<(), RiotError> {
        self.send_message(ChatChannel::All, message).await
    }

    /// The channels that currently resolve to a live room.
    ///
    /// Each channel is probed on its own; an unavailable one is simply absent
    /// from the result rather than failing the whole call, because "in a party
    /// but not in a match" is the normal case, not an error.
    pub async fn available_channels(&self) -> Vec<ChatChannel> {
        let mut available = Vec::new();
        for channel in ChatChannel::EVERY {
            if self.resolve_cid(channel).await.is_ok() {
                available.push(channel);
            }
        }
        available
    }

    /// PUUID of the signed-in player, used to tell own messages from others'.
    ///
    /// Tries the chat session first and falls back to the entitlements token's
    /// `subject`, because the chat session route has moved between client
    /// versions while the entitlements one has been stable.
    pub async fn local_puuid(&self) -> Result<String, RiotError> {
        #[derive(serde::Deserialize)]
        struct ChatSession {
            #[serde(default)]
            puuid: String,
        }
        #[derive(serde::Deserialize)]
        struct Entitlements {
            #[serde(default)]
            subject: String,
        }

        if let Ok(session) = self.get_json::<ChatSession>("/chat/v1/session", &[]).await {
            if !session.puuid.is_empty() {
                return Ok(session.puuid);
            }
        }

        let entitlements: Entitlements = self.get_json("/entitlements/v1/token", &[]).await?;
        if entitlements.subject.is_empty() {
            return Err(RiotError::UnreadableResponse);
        }
        Ok(entitlements.subject)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::response::Response;
    use axum::Router;
    use serde_json::{json, Value};
    use std::net::Ipv4Addr;
    use std::sync::{Arc, Mutex};

    const PARTY_CID: &str = "6f1c-3a20@ares-parties.eu1.pvp.net";
    const PREGAME_CID: &str = "9f2e-blue@ares-pregame.eu1.pvp.net";
    const TEAM_BLUE_CID: &str = "9f2e-blue@ares-coregame.eu1.pvp.net";
    const TEAM_RED_CID: &str = "9f2e-red@ares-coregame.eu1.pvp.net";
    const ALL_CID: &str = "9f2e-all@ares-coregame.eu1.pvp.net";
    const TEST_PASSWORD: &str = "sup3r-s3cret-lockfile-pw";

    #[derive(Debug, Clone)]
    struct RecordedRequest {
        method: String,
        path: String,
        query: String,
        authorization: String,
        body: Option<Value>,
    }

    struct MockRiot {
        base_url: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
    }

    impl MockRiot {
        fn requests(&self) -> Vec<RecordedRequest> {
            self.requests.lock().unwrap().clone()
        }

        fn posts(&self) -> Vec<RecordedRequest> {
            self.requests()
                .into_iter()
                .filter(|request| request.method == "POST")
                .collect()
        }
    }

    /// Spawns a stand-in Riot Client on an ephemeral loopback port.
    ///
    /// `responder` receives `(method, path, query)` and returns
    /// `(status, json body)`, which keeps each test's fixture next to its
    /// assertions instead of in a shared table.
    async fn spawn_mock<F>(responder: F) -> MockRiot
    where
        F: Fn(&str, &str, &str) -> (u16, String) + Send + Sync + 'static,
    {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let responder = Arc::new(responder);
        let log = requests.clone();

        let app = Router::new().fallback(move |request: Request| {
            let responder = responder.clone();
            let log = log.clone();
            async move {
                let method = request.method().to_string();
                let path = request.uri().path().to_string();
                let query = request.uri().query().unwrap_or_default().to_string();
                let authorization = request
                    .headers()
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let bytes = axum::body::to_bytes(request.into_body(), usize::MAX)
                    .await
                    .unwrap_or_default();

                log.lock().unwrap().push(RecordedRequest {
                    method: method.clone(),
                    path: path.clone(),
                    query: query.clone(),
                    authorization,
                    body: serde_json::from_slice(&bytes).ok(),
                });

                let (status, payload) = responder(&method, &path, &query);
                Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(Body::from(payload))
                    .unwrap()
            }
        });

        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        MockRiot {
            base_url: format!("http://127.0.0.1:{port}"),
            requests,
        }
    }

    fn test_lockfile() -> Lockfile {
        lockfile::parse(&format!("Riot Client:4242:1:{TEST_PASSWORD}:http")).unwrap()
    }

    fn client_for(mock: &MockRiot) -> RiotChatClient {
        RiotChatClient::with_base_url(&mock.base_url, test_lockfile()).unwrap()
    }

    fn conversations(cids: &[&str]) -> String {
        json!({
            "conversations": cids
                .iter()
                .map(|cid| json!({ "cid": cid, "type": "groupchat", "unread_count": 0 }))
                .collect::<Vec<_>>()
        })
        .to_string()
    }

    /// The realistic fixture: every listing endpoint answers, the coregame one
    /// with a team room *and* an all room, and the ordering is deliberately
    /// unhelpful so index-based lookups would pick the wrong entry.
    async fn full_session_mock() -> MockRiot {
        spawn_mock(|method, path, _query| {
            if method == "POST" {
                return (200, json!({ "success": true }).to_string());
            }
            let body = match path {
                "/chat/v6/conversations/ares-parties" => {
                    conversations(&["noise@ares-other.eu1.pvp.net", PARTY_CID])
                }
                "/chat/v6/conversations/ares-pregame" => conversations(&[PREGAME_CID]),
                "/chat/v6/conversations/ares-coregame" => {
                    // All first, team second: a `[0]`/`[1]` reader gets these
                    // backwards.
                    conversations(&[ALL_CID, TEAM_BLUE_CID])
                }
                _ => json!({ "messages": [] }).to_string(),
            };
            (200, body)
        })
        .await
    }

    // ---- channel resolution -------------------------------------------------

    #[tokio::test]
    async fn resolves_the_party_cid() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);

        assert_eq!(
            client.resolve_cid(ChatChannel::Party).await.unwrap(),
            PARTY_CID
        );
    }

    #[tokio::test]
    async fn resolves_the_pregame_cid() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);

        assert_eq!(
            client.resolve_cid(ChatChannel::Pregame).await.unwrap(),
            PREGAME_CID
        );
    }

    #[tokio::test]
    async fn resolves_the_blue_team_cid() {
        let mock = spawn_mock(|_method, path, _query| match path {
            "/chat/v6/conversations/ares-coregame" => {
                (200, conversations(&[ALL_CID, TEAM_BLUE_CID]))
            }
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        assert_eq!(
            client.resolve_cid(ChatChannel::Team).await.unwrap(),
            TEAM_BLUE_CID
        );
    }

    #[tokio::test]
    async fn resolves_the_red_team_cid() {
        let mock = spawn_mock(|_method, path, _query| match path {
            "/chat/v6/conversations/ares-coregame" => {
                (200, conversations(&[ALL_CID, TEAM_RED_CID]))
            }
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        assert_eq!(
            client.resolve_cid(ChatChannel::Team).await.unwrap(),
            TEAM_RED_CID
        );
    }

    #[tokio::test]
    async fn resolves_the_all_cid() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);

        assert_eq!(client.resolve_cid(ChatChannel::All).await.unwrap(), ALL_CID);
    }

    #[tokio::test]
    async fn resolution_searches_the_whole_array_rather_than_fixed_indexes() {
        // The wanted room is last, behind three decoys.
        let mock = spawn_mock(|_method, path, _query| match path {
            "/chat/v6/conversations/ares-coregame" => (
                200,
                conversations(&[
                    "junk-1@ares-coregame.eu1.pvp.net",
                    ALL_CID,
                    "junk-2@ares-coregame.eu1.pvp.net",
                    TEAM_RED_CID,
                ]),
            ),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        assert_eq!(
            client.resolve_cid(ChatChannel::Team).await.unwrap(),
            TEAM_RED_CID
        );
        assert_eq!(client.resolve_cid(ChatChannel::All).await.unwrap(), ALL_CID);
    }

    #[tokio::test]
    async fn party_falls_back_to_the_full_conversation_list() {
        // The dedicated ares-parties listing is often empty while the player
        // is already in a live party. The game still has the room on the
        // unfiltered conversations list — that's what the screenshot hit.
        let mock = spawn_mock(|_method, path, _query| match path {
            "/chat/v6/conversations/ares-parties" => (200, conversations(&[])),
            "/chat/v6/conversations" => (200, conversations(&[PARTY_CID])),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        assert_eq!(
            client.resolve_cid(ChatChannel::Party).await.unwrap(),
            PARTY_CID
        );
    }

    #[tokio::test]
    async fn team_picks_the_listed_side_room_when_both_exist() {
        let mock = spawn_mock(|_method, path, _query| match path {
            "/chat/v6/conversations/ares-coregame" => {
                (200, conversations(&[ALL_CID, TEAM_RED_CID, TEAM_BLUE_CID]))
            }
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        // No live match payload here, so we keep the first team room rather
        // than guessing Blue. Side-aware picking is covered on the match JSON.
        assert_eq!(
            client.resolve_cid(ChatChannel::Team).await.unwrap(),
            TEAM_RED_CID
        );
    }

    // ---- unavailability -----------------------------------------------------

    #[tokio::test]
    async fn an_unavailable_channel_is_a_typed_error() {
        let mock = spawn_mock(|_method, _path, _query| (200, conversations(&[]))).await;
        let client = client_for(&mock);

        for channel in ChatChannel::EVERY {
            let error = client.resolve_cid(channel).await.unwrap_err();
            assert!(
                matches!(error, RiotError::ChannelUnavailable { channel: got } if got == channel),
                "expected ChannelUnavailable for {channel}, got {error:?}"
            );
            assert!(error.to_string().contains(channel.to_string().as_str()));
        }
    }

    #[tokio::test]
    async fn all_never_falls_back_to_the_team_room() {
        // A live match with a team room but no all room. This is the exact
        // shape that made the Java implementation leak All-chat into Team.
        let mock = spawn_mock(|_method, path, _query| match path {
            "/chat/v6/conversations/ares-coregame" => (200, conversations(&[TEAM_BLUE_CID])),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        let error = client.send_to_all("everyone gg").await.unwrap_err();
        assert!(matches!(
            error,
            RiotError::ChannelUnavailable {
                channel: ChatChannel::All
            }
        ));
        assert!(
            mock.posts().is_empty(),
            "nothing may be sent when All is unavailable, got {:?}",
            mock.posts()
        );
    }

    #[tokio::test]
    async fn team_never_falls_back_to_the_all_room() {
        let mock = spawn_mock(|_method, path, _query| match path {
            "/chat/v6/conversations/ares-coregame" => (200, conversations(&[ALL_CID])),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        let error = client.send_to_team("push a").await.unwrap_err();
        assert!(matches!(
            error,
            RiotError::ChannelUnavailable {
                channel: ChatChannel::Team
            }
        ));
        assert!(mock.posts().is_empty());
    }

    // ---- sending ------------------------------------------------------------

    #[tokio::test]
    async fn every_channel_sends_to_its_own_cid() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);

        client.send_to_party("party msg").await.unwrap();
        client.send_to_pregame("pregame msg").await.unwrap();
        client.send_to_team("team msg").await.unwrap();
        client.send_to_all("all msg").await.unwrap();

        let sent: Vec<(String, String)> = mock
            .posts()
            .iter()
            .map(|request| {
                let body = request.body.clone().unwrap();
                (
                    body["cid"].as_str().unwrap().to_string(),
                    body["message"].as_str().unwrap().to_string(),
                )
            })
            .collect();

        assert_eq!(
            sent,
            vec![
                (PARTY_CID.to_string(), "party msg".to_string()),
                (PREGAME_CID.to_string(), "pregame msg".to_string()),
                (TEAM_BLUE_CID.to_string(), "team msg".to_string()),
                (ALL_CID.to_string(), "all msg".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn outgoing_requests_use_the_documented_path_and_groupchat_type() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);

        client.send_to_all("hello").await.unwrap();

        let post = mock.posts().pop().unwrap();
        assert_eq!(post.path, "/chat/v6/messages/");
        assert_eq!(post.body.unwrap()["type"], json!("groupchat"));
    }

    #[tokio::test]
    async fn messages_with_awkward_characters_survive_the_round_trip() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);
        let nasty = "sl/ash \"quote\" back\\slash \u{65e5}\u{672c}\u{8a9e} \u{1f3af}\nnewline";

        client.send_to_team(nasty).await.unwrap();

        let post = mock.posts().pop().unwrap();
        assert_eq!(post.body.unwrap()["message"], json!(nasty));
    }

    #[tokio::test]
    async fn empty_messages_are_refused_before_any_request_is_made() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);

        assert!(matches!(
            client.send_to_all("   ").await,
            Err(RiotError::EmptyMessage)
        ));
        assert!(mock.posts().is_empty());
    }

    // ---- retrieval ----------------------------------------------------------

    #[tokio::test]
    async fn retrieved_messages_keep_the_channel_they_came_from() {
        let mock = spawn_mock(|_method, path, query| match path {
            "/chat/v6/conversations/ares-coregame" => {
                (200, conversations(&[ALL_CID, TEAM_BLUE_CID]))
            }
            "/chat/v6/messages" => {
                let body = if query.contains("all@ares") {
                    json!({ "messages": [{ "cid": ALL_CID, "id": "m-all", "body": "gg all" }] })
                } else {
                    json!({ "messages": [{ "cid": TEAM_BLUE_CID, "id": "m-team", "body": "go b" }] })
                };
                (200, body.to_string())
            }
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        let all = client.get_messages(ChatChannel::All).await.unwrap();
        let team = client.get_messages(ChatChannel::Team).await.unwrap();

        assert_eq!(all.len(), 1);
        assert_eq!(all[0].channel, ChatChannel::All);
        assert_eq!(all[0].body, "gg all");

        assert_eq!(team.len(), 1);
        assert_eq!(team[0].channel, ChatChannel::Team);
        assert_eq!(team[0].body, "go b");
    }

    #[tokio::test]
    async fn a_coregame_cid_is_sent_without_percent_encoding_the_at_sign() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);

        client.get_messages(ChatChannel::All).await.unwrap();

        let history = mock
            .requests()
            .into_iter()
            .find(|request| request.path == "/chat/v6/messages")
            .expect("history request");
        assert!(
            history.query.contains("all@ares-coregame"),
            "expected a raw @, got {:?}",
            history.query
        );
        assert!(
            !history.query.contains("%40"),
            "Riot compares the query literally; %40 must not appear: {:?}",
            history.query
        );
    }

    #[tokio::test]
    async fn specific_history_returns_the_room_payload() {
        let mock = spawn_mock(|_method, path, query| match path {
            "/chat/v6/conversations/ares-coregame" | "/chat/v6/conversations" => {
                (200, conversations(&[ALL_CID]))
            }
            "/chat/v6/messages" if query.contains(ALL_CID) => (
                200,
                json!({ "messages": [{ "cid": ALL_CID, "id": "m-1", "body": "hello" }] })
                    .to_string(),
            ),
            "/chat/v6/messages" => (500, json!({ "message": "should not fallback" }).to_string()),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);
        let messages = client
            .get_messages_for_cid(ALL_CID, ChatChannel::All)
            .await
            .unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].body, "hello");
        assert_eq!(messages[0].channel, ChatChannel::All);
    }

    #[tokio::test]
    async fn a_not_found_specific_request_falls_back_to_all_history() {
        let mock = spawn_mock(|_method, path, query| match path {
            "/chat/v6/conversations/ares-coregame" | "/chat/v6/conversations" => {
                (200, conversations(&[TEAM_BLUE_CID, ALL_CID]))
            }
            "/chat/v6/messages" if query.contains("cid=") => (
                404,
                json!({
                    "errorCode": "RPC_ERROR",
                    "httpStatus": 404,
                    "implementationDetails": {},
                    "message": "not_found"
                })
                .to_string(),
            ),
            "/chat/v6/messages" => (
                200,
                json!({
                    "messages": [
                        { "cid": TEAM_BLUE_CID, "id": "m-team", "body": "rotate" },
                        { "cid": ALL_CID, "id": "m-all", "body": "gg" }
                    ]
                })
                .to_string(),
            ),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);
        let messages = client
            .get_messages_for_cid(TEAM_BLUE_CID, ChatChannel::Team)
            .await
            .unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|item| item.body.as_str())
                .collect::<Vec<_>>(),
            vec!["rotate"]
        );
        assert!(messages
            .iter()
            .all(|item| item.channel == ChatChannel::Team));
        assert!(
            mock.requests()
                .iter()
                .any(|request| request.path == "/chat/v6/messages" && request.query.is_empty()),
            "expected the unfiltered fallback GET"
        );
    }

    #[tokio::test]
    async fn empty_filtered_history_is_not_a_network_error() {
        let mock = spawn_mock(|_method, path, query| match path {
            "/chat/v6/conversations/ares-coregame" | "/chat/v6/conversations" => {
                (200, conversations(&[TEAM_BLUE_CID]))
            }
            "/chat/v6/messages" if query.contains("cid=") => {
                (404, json!({ "message": "not_found" }).to_string())
            }
            "/chat/v6/messages" => (200, json!({ "messages": [] }).to_string()),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);
        let messages = client
            .get_messages_for_cid(TEAM_BLUE_CID, ChatChannel::Team)
            .await
            .unwrap();
        assert!(messages.is_empty());
    }

    #[tokio::test]
    async fn a_stale_cid_is_detected_after_refreshing_conversations() {
        let generation = Arc::new(Mutex::new(0u8));
        let seen = generation.clone();
        let mock = spawn_mock(move |_method, path, query| {
            let gen = *seen.lock().unwrap();
            match path {
                "/chat/v6/conversations/ares-coregame" | "/chat/v6/conversations" => {
                    let cid = if gen == 0 {
                        TEAM_BLUE_CID
                    } else {
                        "next-blue@ares-coregame.eu1.pvp.net"
                    };
                    (200, conversations(&[cid]))
                }
                "/chat/v6/messages" if query.contains("cid=") => {
                    *seen.lock().unwrap() = 1;
                    (404, json!({ "message": "not_found" }).to_string())
                }
                "/chat/v6/messages" => (500, json!({ "message": "must not fallback" }).to_string()),
                _ => (200, conversations(&[])),
            }
        })
        .await;
        let client = client_for(&mock);
        let error = client
            .get_messages_for_cid(TEAM_BLUE_CID, ChatChannel::Team)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            RiotError::StaleConversation {
                channel: ChatChannel::Team
            }
        ));
    }

    #[tokio::test]
    async fn message_history_false_skips_the_specific_endpoint() {
        let mock = spawn_mock(|_method, path, query| match path {
            "/chat/v6/conversations/ares-coregame" | "/chat/v6/conversations" => (
                200,
                json!({
                    "conversations": [{
                        "cid": TEAM_BLUE_CID,
                        "type": "groupchat",
                        "message_history": false
                    }]
                })
                .to_string(),
            ),
            "/chat/v6/messages" if query.contains("cid=") => (
                500,
                json!({ "message": "must not call specific" }).to_string(),
            ),
            "/chat/v6/messages" => (
                200,
                json!({ "messages": [{ "cid": TEAM_BLUE_CID, "id": "m-1", "body": "hi" }] })
                    .to_string(),
            ),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);
        let messages = client
            .get_messages_for_cid(TEAM_BLUE_CID, ChatChannel::Team)
            .await
            .unwrap();
        assert_eq!(messages[0].body, "hi");
        assert!(mock
            .requests()
            .iter()
            .filter(|request| request.path == "/chat/v6/messages")
            .all(|request| request.query.is_empty()));
    }

    #[tokio::test]
    async fn a_new_match_invalidates_the_previous_cached_cid() {
        let generation = Arc::new(Mutex::new(0u8));
        let seen = generation.clone();
        let mock = spawn_mock(move |_method, path, _query| {
            let cid = if *seen.lock().unwrap() == 0 {
                "match-a-blue@ares-coregame.eu1.pvp.net"
            } else {
                "match-b-blue@ares-coregame.eu1.pvp.net"
            };
            if path.contains("ares-coregame") || path == "/chat/v6/conversations" {
                return (200, conversations(&[cid]));
            }
            (200, conversations(&[]))
        })
        .await;
        let client = client_for(&mock);
        assert_eq!(
            client.resolve_cid(ChatChannel::Team).await.unwrap(),
            "match-a-blue@ares-coregame.eu1.pvp.net"
        );
        *generation.lock().unwrap() = 1;
        assert_eq!(
            client.resolve_cid(ChatChannel::Team).await.unwrap(),
            "match-b-blue@ares-coregame.eu1.pvp.net"
        );
    }

    #[tokio::test]
    async fn unexpected_cid_characters_are_rejected_before_the_request() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);
        let before = mock.requests().len();
        let error = client
            .get_messages_for_cid("blue%40ares-coregame.jp1.pvp.net", ChatChannel::Team)
            .await
            .unwrap_err();
        assert!(matches!(error, RiotError::InvalidCid));
        assert_eq!(mock.requests().len(), before);
    }

    #[tokio::test]
    async fn sending_puts_the_exact_cid_in_the_json_body() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);
        client.send_to_team("push").await.unwrap();
        let post = mock.posts().pop().unwrap();
        assert_eq!(post.body.unwrap()["cid"], json!(TEAM_BLUE_CID));
        assert!(TEAM_BLUE_CID.contains('@'));
        assert!(!TEAM_BLUE_CID.contains("%40"));
    }

    #[tokio::test]
    async fn available_channels_reports_only_the_rooms_that_resolved() {
        let mock = spawn_mock(|_method, path, _query| match path {
            "/chat/v6/conversations/ares-parties" => (200, conversations(&[PARTY_CID])),
            "/chat/v6/conversations/ares-coregame" => (200, conversations(&[TEAM_BLUE_CID])),
            _ => (200, conversations(&[])),
        })
        .await;
        let client = client_for(&mock);

        assert_eq!(
            client.available_channels().await,
            vec![ChatChannel::Party, ChatChannel::Team]
        );
    }

    // ---- credential handling ------------------------------------------------

    #[tokio::test]
    async fn requests_authenticate_with_http_basic_as_riot() {
        let mock = full_session_mock().await;
        let client = client_for(&mock);

        client.send_to_party("hi").await.unwrap();

        let expected = {
            use base64::Engine;
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode(format!("riot:{TEST_PASSWORD}").as_bytes())
            )
        };
        for request in mock.requests() {
            assert_eq!(request.authorization, expected, "on {}", request.path);
        }
    }

    #[tokio::test]
    async fn errors_never_carry_the_password_the_header_or_the_response_body() {
        // A hostile-shaped failure: the client echoes the credential back in an
        // error body, which a naive `format!("{status}: {text}")` would forward
        // straight to the frontend.
        let mock = spawn_mock(|_method, _path, _query| {
            (
                403,
                json!({
                    "message": format!("rejected auth Basic riot:{TEST_PASSWORD}"),
                    "puuid": "leaky-puuid",
                })
                .to_string(),
            )
        })
        .await;
        let client = client_for(&mock);

        let error = client.resolve_cid(ChatChannel::Party).await.unwrap_err();
        let rendered = error.to_string();
        let debugged = format!("{error:?}");

        for haystack in [&rendered, &debugged] {
            assert!(!haystack.contains(TEST_PASSWORD), "password leaked");
            assert!(!haystack.contains("Basic "), "auth header leaked");
            assert!(!haystack.contains("leaky-puuid"), "response body leaked");
        }
        assert!(
            rendered.contains("403"),
            "status should survive: {rendered}"
        );
    }

    #[tokio::test]
    async fn client_debug_output_redacts_the_credential() {
        let mock = full_session_mock().await;
        let rendered = format!("{:?}", client_for(&mock));

        assert!(!rendered.contains(TEST_PASSWORD));
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn a_non_loopback_base_url_is_refused() {
        for base in [
            "https://example.com",
            "https://evil.test:443",
            "http://10.0.0.5:8080",
            "ftp://127.0.0.1",
            "127.0.0.1:1234",
        ] {
            assert!(
                RiotChatClient::with_base_url(base, test_lockfile()).is_err(),
                "{base} must be refused"
            );
        }

        for base in ["https://127.0.0.1:1234", "http://localhost:8000"] {
            assert!(
                RiotChatClient::with_base_url(base, test_lockfile()).is_ok(),
                "{base} must be accepted"
            );
        }
    }

    #[tokio::test]
    async fn an_unreadable_response_is_reported_as_such() {
        let mock = spawn_mock(|_method, _path, _query| (200, "<html>not json</html>".into())).await;
        let client = client_for(&mock);

        assert!(matches!(
            client.resolve_cid(ChatChannel::Party).await,
            Err(RiotError::UnreadableResponse)
        ));
    }
}
