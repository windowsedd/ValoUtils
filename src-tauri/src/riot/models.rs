//! Request/response shapes for the Riot Client chat API, plus the app-facing
//! models the frontend sees.
//!
//! The wire types (`ConversationsResponse`, `Conversation`, `RawMessage`) mirror
//! what the local API actually returns and are deliberately permissive: every
//! field is `#[serde(default)]` so that a Riot-side addition or a renamed field
//! degrades one value rather than failing the whole response. The app-facing
//! types (`ChatChannel`, `ChatMessage`) are strict, because the frontend and the
//! translation router depend on them being unambiguous.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Conversation-listing endpoints. Kept here so no caller spells a path inline.
pub const PATH_CONVERSATIONS_PARTIES: &str = "/chat/v6/conversations/ares-parties";
pub const PATH_CONVERSATIONS_PREGAME: &str = "/chat/v6/conversations/ares-pregame";
pub const PATH_CONVERSATIONS_COREGAME: &str = "/chat/v6/conversations/ares-coregame";
pub const PATH_CONVERSATIONS: &str = "/chat/v6/conversations";
/// GET history. The CID goes through `.query()`, never string interpolation.
pub const PATH_MESSAGES: &str = "/chat/v6/messages";
/// POST a message. The trailing slash is what the Riot Client expects here.
pub const PATH_SEND_MESSAGE: &str = "/chat/v6/messages/";

/// Every VALORANT chat room this app can read from or write to.
///
/// `Team` and `All` are separate variants rather than a merged "in-game" case
/// on purpose: keeping them distinct all the way from retrieval to send is what
/// prevents an All-chat message being delivered to Team.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ChatChannel {
    Party,
    Pregame,
    Team,
    All,
}

impl ChatChannel {
    pub const EVERY: [ChatChannel; 4] = [
        ChatChannel::Party,
        ChatChannel::Pregame,
        ChatChannel::Team,
        ChatChannel::All,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ChatChannel::Party => "party",
            ChatChannel::Pregame => "pregame",
            ChatChannel::Team => "team",
            ChatChannel::All => "all",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "party" => Some(ChatChannel::Party),
            "pregame" | "pre-game" => Some(ChatChannel::Pregame),
            "team" => Some(ChatChannel::Team),
            "all" => Some(ChatChannel::All),
            _ => None,
        }
    }

    /// Which conversation-listing endpoint owns this channel.
    ///
    /// `Team` and `All` both come from `ares-coregame` and are told apart by
    /// their CID, which is why resolution cannot stop at the endpoint.
    pub fn conversations_path(self) -> &'static str {
        match self {
            ChatChannel::Party => PATH_CONVERSATIONS_PARTIES,
            ChatChannel::Pregame => PATH_CONVERSATIONS_PREGAME,
            ChatChannel::Team | ChatChannel::All => PATH_CONVERSATIONS_COREGAME,
        }
    }

    /// Whether a CID returned by [`Self::conversations_path`] belongs to this
    /// channel.
    ///
    /// Every channel is identified by the CID's domain, and the two in-game
    /// ones additionally by its local part:
    ///
    /// ```text
    /// <party-id>@ares-parties.<region>.pvp.net         -> Party
    /// <match-id>-blue@ares-pregame.<region>.pvp.net    -> Pregame
    /// <match-id>-blue@ares-coregame.<region>.pvp.net   -> Team
    /// <match-id>-red@ares-coregame.<region>.pvp.net    -> Team
    /// <match-id>-all@ares-coregame.<region>.pvp.net    -> All
    /// ```
    ///
    /// Party and pregame check the domain rather than accepting whatever their
    /// endpoint returned. That endpoint is not guaranteed to be single-purpose,
    /// and "first entry in the array" is precisely the assumption this module
    /// exists to avoid.
    ///
    /// Note there is no fallback arm: an `All` lookup that finds no `all@ares`
    /// room reports the channel as unavailable rather than settling for the
    /// team room that is sitting right next to it in the same response.
    pub fn matches_cid(self, cid: &str) -> bool {
        let lower = cid.to_ascii_lowercase();
        match self {
            ChatChannel::Party => lower.contains("@ares-parties"),
            ChatChannel::Pregame => lower.contains("@ares-pregame"),
            // Anchored to `ares-coregame` rather than the looser `blue@ares`,
            // because a pregame room is also spelled `<id>-blue@ares-pregame`
            // and must never be mistaken for an in-game team room.
            ChatChannel::Team => {
                lower.contains("blue@ares-coregame")
                    || lower.contains("red@ares-coregame")
                    || lower.contains("blue@ares-pregame")
                    || lower.contains("red@ares-pregame")
            }
            ChatChannel::All => lower.contains("all@ares-coregame"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchSide {
    Blue,
    Red,
}

impl MatchSide {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "blue" => Some(Self::Blue),
            "red" => Some(Self::Red),
            _ => None,
        }
    }

    pub fn cid_token(self) -> &'static str {
        match self {
            Self::Blue => "-blue@",
            Self::Red => "-red@",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blue => "blue",
            Self::Red => "red",
        }
    }
}

/// `{match}-blue@ares-pregame.eu1.pvp.net` → `eu1`
pub fn chat_domain_from_cid(cid: &str) -> Option<String> {
    let after_at = cid.split_once('@')?.1;
    let rest = after_at
        .strip_prefix("ares-")
        .or_else(|| after_at.split_once('.').map(|(_, rest)| rest))?;
    let domain = rest
        .split_once('.')
        .map(|(_, rest)| rest)
        .unwrap_or(rest)
        .trim_end_matches(".pvp.net")
        .trim_matches('.');
    if domain.is_empty() {
        None
    } else {
        Some(domain.to_string())
    }
}

/// Build the side room when Riot omits `TeamMUCName`.
pub fn build_team_cid(match_id: &str, side: MatchSide, phase: &str, domain: &str) -> String {
    format!(
        "{}-{}@ares-{}.{}.pvp.net",
        match_id.trim(),
        side.as_str(),
        phase,
        domain
    )
}

fn id_root(value: &str) -> &str {
    value.split('@').next().unwrap_or(value)
}

fn player_subject(player: &Value) -> Option<&str> {
    player
        .get("Subject")
        .or_else(|| player.get("PUUID"))
        .and_then(Value::as_str)
}

fn team_id(value: &Value) -> Option<MatchSide> {
    value
        .get("TeamID")
        .or_else(|| value.get("teamId"))
        .and_then(Value::as_str)
        .and_then(MatchSide::parse)
}

/// Blue/Red for the local player from a coregame or pregame match payload.
pub fn local_match_side(puuid: &str, match_data: &Value) -> Option<MatchSide> {
    let want = id_root(puuid);
    if let Some(players) = match_data.get("Players").and_then(Value::as_array) {
        for player in players {
            let subject = player_subject(player).unwrap_or_default();
            if id_root(subject).eq_ignore_ascii_case(want) {
                if let Some(side) = team_id(player) {
                    return Some(side);
                }
            }
        }
    }
    for key in ["AllyTeam", "EnemyTeam"] {
        let Some(team) = match_data.get(key) else {
            continue;
        };
        let on_team = team
            .get("Players")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|player| {
                player_subject(player)
                    .is_some_and(|subject| id_root(subject).eq_ignore_ascii_case(want))
            });
        if on_team {
            if let Some(side) = team_id(team) {
                return Some(side);
            }
        }
    }
    match_data
        .get("TeamMUCName")
        .and_then(Value::as_str)
        .and_then(side_from_cid)
}

pub fn side_from_cid(cid: &str) -> Option<MatchSide> {
    let lower = cid.to_ascii_lowercase();
    if lower.contains("-blue@") {
        Some(MatchSide::Blue)
    } else if lower.contains("-red@") {
        Some(MatchSide::Red)
    } else {
        None
    }
}

pub fn pick_team_cid<'a>(
    cids: impl IntoIterator<Item = &'a str>,
    side: Option<MatchSide>,
) -> Option<String> {
    let cids: Vec<&str> = cids
        .into_iter()
        .filter(|cid| !cid.is_empty() && ChatChannel::Team.matches_cid(cid))
        .collect();
    if let Some(side) = side {
        if let Some(cid) = cids
            .iter()
            .copied()
            .find(|cid| cid.to_ascii_lowercase().contains(side.cid_token()))
        {
            return Some(cid.to_string());
        }
    }
    cids.first().map(|cid| (*cid).to_string())
}

pub fn rewrite_team_cid(cid: &str, side: MatchSide) -> String {
    let lower = cid.to_ascii_lowercase();
    let Some(current) = ["-blue@", "-red@"]
        .into_iter()
        .find(|token| lower.contains(token))
    else {
        return cid.to_string();
    };
    if current == side.cid_token() {
        return cid.to_string();
    }
    let index = lower.find(current).expect("token present");
    format!(
        "{}{}{}",
        &cid[..index],
        side.cid_token(),
        &cid[index + current.len()..]
    )
}

impl std::fmt::Display for ChatChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let label = match self {
            ChatChannel::Party => "Party",
            ChatChannel::Pregame => "Pregame",
            ChatChannel::Team => "Team",
            ChatChannel::All => "All",
        };
        f.write_str(label)
    }
}

/// Body of `POST /chat/v6/messages/`.
///
/// Serialized by serde rather than assembled with `format!`, so a message
/// containing quotes, backslashes or newlines cannot break out of the JSON
/// string it belongs in.
#[derive(Debug, Serialize)]
pub struct SendMessageRequest<'a> {
    pub cid: &'a str,
    pub message: &'a str,
    #[serde(rename = "type")]
    pub message_type: &'static str,
}

impl<'a> SendMessageRequest<'a> {
    /// Every room this app writes to is a MUC, so the type is always
    /// `groupchat`; direct messages would be `chat` and are out of scope here.
    pub const GROUPCHAT: &'static str = "groupchat";

    pub fn groupchat(cid: &'a str, message: &'a str) -> Self {
        Self {
            cid,
            message,
            message_type: Self::GROUPCHAT,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct ConversationsResponse {
    #[serde(default, alias = "Conversations", alias = "data")]
    pub conversations: Vec<Conversation>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Conversation {
    #[serde(
        default,
        alias = "id",
        alias = "conversationId",
        alias = "ConversationID"
    )]
    pub cid: String,
    #[serde(default, rename = "type", alias = "Type")]
    pub kind: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct MessagesResponse {
    #[serde(default, alias = "Messages")]
    pub messages: Vec<RawMessage>,
}

/// A message exactly as the Riot Client reports it.
///
/// `time` is `serde_json::Value` because the client has shipped it both as a
/// millisecond number and as a string; normalizing happens in
/// [`ChatMessage::from_raw`] rather than failing to deserialize.
#[derive(Debug, Default, Deserialize)]
pub struct RawMessage {
    #[serde(default)]
    pub cid: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub mid: String,
    #[serde(default)]
    pub puuid: String,
    #[serde(default)]
    pub sender: String,
    #[serde(default)]
    pub pid: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub game_name: String,
    #[serde(default)]
    pub game_tag: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub message: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub time: serde_json::Value,
}

/// A message as the rest of the app sees it.
///
/// `channel` is stamped at retrieval time from the endpoint the message came
/// from and travels with the message from then on. Nothing downstream re-derives
/// it, so a reply can always be routed back to the room that produced it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// Stable key for deduplication. Riot's own message id when it sends one,
    /// otherwise a content fingerprint - see [`ChatMessage::from_raw`].
    pub key: String,
    pub cid: String,
    pub channel: ChatChannel,
    pub sender_puuid: String,
    pub sender_name: String,
    pub sender_tag: String,
    pub body: String,
    pub timestamp: String,
}

impl ChatMessage {
    pub fn from_raw(raw: RawMessage, channel: ChatChannel) -> Self {
        let timestamp = match &raw.time {
            serde_json::Value::String(text) => text.clone(),
            serde_json::Value::Number(number) => number.to_string(),
            _ => String::new(),
        };

        // Riot usually sends `id`, sometimes only `mid`, and occasionally
        // neither for freshly-delivered MUC traffic. Falling back to a content
        // fingerprint keeps the dedup cache usable in that last case instead of
        // collapsing every unidentified message onto one empty key.
        let key = [raw.id.as_str(), raw.mid.as_str()]
            .into_iter()
            .find(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| fingerprint(&raw, &timestamp));

        let sender_name = if raw.game_name.is_empty() {
            raw.name.clone()
        } else {
            raw.game_name.clone()
        };

        ChatMessage {
            key,
            cid: raw.cid,
            channel,
            sender_puuid: first_nonempty([&raw.puuid, &raw.sender, &raw.pid, &raw.from]),
            sender_name,
            sender_tag: raw.game_tag,
            body: first_nonempty([&raw.body, &raw.message]),
            timestamp,
        }
    }

    pub fn is_from(&self, puuid: &str) -> bool {
        same_player(&self.sender_puuid, puuid)
    }
}

fn first_nonempty(values: impl IntoIterator<Item = impl AsRef<str>>) -> String {
    values
        .into_iter()
        .map(|value| value.as_ref().to_string())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// True when both values name the same player, whether they arrived as a bare
/// PUUID or as `puuid@affinity.pvp.net`. Empty sides never match.
pub fn same_player(left: &str, right: &str) -> bool {
    let left = left.split('@').next().unwrap_or(left);
    let right = right.split('@').next().unwrap_or(right);
    !left.is_empty() && !right.is_empty() && left.eq_ignore_ascii_case(right)
}

fn fingerprint(raw: &RawMessage, timestamp: &str) -> String {
    let mut hasher = DefaultHasher::new();
    raw.cid.hash(&mut hasher);
    first_nonempty([&raw.puuid, &raw.sender, &raw.pid, &raw.from]).hash(&mut hasher);
    first_nonempty([&raw.body, &raw.message]).hash(&mut hasher);
    timestamp.hash(&mut hasher);
    format!("fp:{:016x}", hasher.finish())
}

/// What [`crate::commands::riot_chat::connect_riot_chat`] reports back.
///
/// Carries no port, pid or credential - only what the UI needs to decide
/// between "connected", "sign in first" and "which rooms can I type in".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    /// The `name` field of the lockfile, e.g. `Riot Client`.
    pub client_name: String,
    pub available_channels: Vec<ChatChannel>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLUE: &str = "9f2e-blue@ares-coregame.eu1.pvp.net";
    const RED: &str = "9f2e-red@ares-coregame.eu1.pvp.net";
    const ALL: &str = "9f2e-all@ares-coregame.eu1.pvp.net";

    #[test]
    fn team_claims_both_side_rooms_and_never_the_all_room() {
        assert!(ChatChannel::Team.matches_cid(BLUE));
        assert!(ChatChannel::Team.matches_cid(RED));
        assert!(!ChatChannel::Team.matches_cid(ALL));
    }

    #[test]
    fn all_claims_only_the_all_room() {
        assert!(ChatChannel::All.matches_cid(ALL));
        assert!(!ChatChannel::All.matches_cid(BLUE));
        assert!(!ChatChannel::All.matches_cid(RED));
    }

    #[test]
    fn local_match_side_reads_coregame_team_id() {
        let match_data = serde_json::json!({
            "Players": [
                { "Subject": "me", "TeamID": "Red" },
                { "Subject": "other", "TeamID": "Blue" }
            ]
        });
        assert_eq!(local_match_side("me", &match_data), Some(MatchSide::Red));
        assert_eq!(local_match_side("other", &match_data), Some(MatchSide::Blue));
    }

    #[test]
    fn local_match_side_reads_pregame_ally_team_color() {
        let match_data = serde_json::json!({
            "AllyTeam": {
                "TeamID": "Blue",
                "Players": [{ "Subject": "me" }]
            },
            "EnemyTeam": {
                "TeamID": "Red",
                "Players": [{ "Subject": "foe" }]
            }
        });
        assert_eq!(local_match_side("me", &match_data), Some(MatchSide::Blue));
        assert_eq!(local_match_side("foe", &match_data), Some(MatchSide::Red));
    }

    #[test]
    fn pick_team_cid_prefers_the_player_side() {
        let cids = [
            "match-red@ares-coregame.ap",
            "match-blue@ares-coregame.ap",
        ];
        assert_eq!(
            pick_team_cid(cids, Some(MatchSide::Blue)).as_deref(),
            Some("match-blue@ares-coregame.ap")
        );
        assert_eq!(
            pick_team_cid(cids, Some(MatchSide::Red)).as_deref(),
            Some("match-red@ares-coregame.ap")
        );
        assert_eq!(
            rewrite_team_cid("match-blue@ares-pregame.ap", MatchSide::Red),
            "match-red@ares-pregame.ap"
        );
        assert_eq!(
            chat_domain_from_cid("9f2e-blue@ares-pregame.eu1.pvp.net").as_deref(),
            Some("eu1")
        );
        assert_eq!(
            chat_domain_from_cid("party@ares-parties.jp1.pvp.net").as_deref(),
            Some("jp1")
        );
        assert_eq!(
            build_team_cid("9f2e", MatchSide::Red, "pregame", "jp1"),
            "9f2e-red@ares-pregame.jp1.pvp.net"
        );
    }

    #[test]
    fn a_pregame_side_room_is_team_chat_during_agent_select() {
        const PREGAME_BLUE: &str = "9f2e-blue@ares-pregame.eu1.pvp.net";

        assert!(ChatChannel::Pregame.matches_cid(PREGAME_BLUE));
        assert!(ChatChannel::Team.matches_cid(PREGAME_BLUE));
        assert!(!ChatChannel::All.matches_cid(PREGAME_BLUE));
    }

    #[test]
    fn party_and_pregame_check_the_domain_rather_than_trusting_the_endpoint() {
        const PARTY: &str = "6f1c@ares-parties.eu1.pvp.net";
        const STRAY: &str = "someone@ares-other.eu1.pvp.net";

        assert!(ChatChannel::Party.matches_cid(PARTY));
        assert!(!ChatChannel::Party.matches_cid(STRAY));
        assert!(!ChatChannel::Party.matches_cid(""));
        assert!(!ChatChannel::Pregame.matches_cid(STRAY));
        assert!(!ChatChannel::Pregame.matches_cid(PARTY));
    }

    #[test]
    fn team_and_all_share_the_coregame_endpoint_and_pregame_has_its_own() {
        assert_eq!(
            ChatChannel::Team.conversations_path(),
            PATH_CONVERSATIONS_COREGAME
        );
        assert_eq!(
            ChatChannel::All.conversations_path(),
            PATH_CONVERSATIONS_COREGAME
        );
        assert_eq!(
            ChatChannel::Pregame.conversations_path(),
            PATH_CONVERSATIONS_PREGAME
        );
        assert_eq!(
            ChatChannel::Party.conversations_path(),
            PATH_CONVERSATIONS_PARTIES
        );
    }

    #[test]
    fn send_body_serializes_to_riots_exact_shape() {
        let request = SendMessageRequest::groupchat("cid-1", "hello");
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({ "cid": "cid-1", "message": "hello", "type": "groupchat" })
        );
    }

    #[test]
    fn send_body_escapes_characters_that_would_break_hand_built_json() {
        let nasty = "he said \"hi\"\\ then\nleft // ok? \u{65e5}\u{672c}\u{8a9e} \u{1f3af}";
        let request = SendMessageRequest::groupchat("cid-1", nasty);
        let encoded = serde_json::to_string(&request).unwrap();

        // Round-trips byte-for-byte, which hand-assembled JSON would not.
        let decoded: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded["message"], serde_json::json!(nasty));
        assert!(!encoded.contains('\n'), "raw newline must be escaped");
    }

    #[test]
    fn channel_round_trips_through_serde_as_lowercase() {
        for channel in ChatChannel::EVERY {
            let json = serde_json::to_string(&channel).unwrap();
            assert_eq!(json, format!("\"{}\"", channel.as_str()));
            assert_eq!(serde_json::from_str::<ChatChannel>(&json).unwrap(), channel);
        }
    }

    #[test]
    fn raw_message_reads_riots_sender_and_message_fields() {
        // chat.rs already treats this as the live shape: `sender` + `message`,
        // no `puuid` / `body`. The poller has to see the same line or `.send`
        // is silently dropped.
        let raw: RawMessage = serde_json::from_value(serde_json::json!({
            "cid": ALL,
            "sender": "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1",
            "message": ".send party french hello everyone",
            "time": "1",
        }))
        .unwrap();
        let message = ChatMessage::from_raw(raw, ChatChannel::Party);

        assert_eq!(
            message.sender_puuid,
            "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1"
        );
        assert_eq!(message.body, ".send party french hello everyone");
    }

    #[test]
    fn empty_puuid_does_not_hide_a_populated_sender_or_pid() {
        let raw: RawMessage = serde_json::from_value(serde_json::json!({
            "cid": ALL,
            "puuid": "",
            "pid": "abc-def@jp1.pvp.net",
            "body": "",
            "message": "hello",
        }))
        .unwrap();
        let message = ChatMessage::from_raw(raw, ChatChannel::All);

        assert_eq!(message.sender_puuid, "abc-def@jp1.pvp.net");
        assert_eq!(message.body, "hello");
    }

    #[test]
    fn own_message_matches_bare_puuid_or_jid() {
        assert!(same_player(
            "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1",
            "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1@jp1.pvp.net"
        ));
        assert!(same_player("ABC", "abc"));
        assert!(!same_player("", "abc"));
        assert!(!same_player("abc", "def"));
    }

    #[test]
    fn raw_message_becomes_a_channel_stamped_app_message() {
        let raw: RawMessage = serde_json::from_value(serde_json::json!({
            "cid": ALL,
            "id": "msg-77",
            "puuid": "puuid-a",
            "game_name": "Windowsed",
            "game_tag": "NA1",
            "body": "nice shot",
            "type": "groupchat",
            "time": "1737000000000",
        }))
        .unwrap();

        let message = ChatMessage::from_raw(raw, ChatChannel::All);

        assert_eq!(message.key, "msg-77");
        assert_eq!(message.channel, ChatChannel::All);
        assert_eq!(message.sender_name, "Windowsed");
        assert_eq!(message.sender_tag, "NA1");
        assert_eq!(message.body, "nice shot");
        assert_eq!(message.timestamp, "1737000000000");
    }

    #[test]
    fn numeric_timestamps_and_missing_ids_are_both_handled() {
        let raw: RawMessage = serde_json::from_value(serde_json::json!({
            "cid": BLUE,
            "puuid": "puuid-b",
            "name": "Legacy Name",
            "body": "go b",
            "time": 1737000000000i64,
        }))
        .unwrap();

        let message = ChatMessage::from_raw(raw, ChatChannel::Team);

        assert_eq!(message.timestamp, "1737000000000");
        assert_eq!(message.sender_name, "Legacy Name");
        assert!(message.key.starts_with("fp:"), "expected a fingerprint key");
    }

    #[test]
    fn fingerprints_separate_distinct_messages_and_repeat_for_identical_ones() {
        let build = |body: &str| {
            let raw: RawMessage = serde_json::from_value(serde_json::json!({
                "cid": BLUE, "puuid": "p", "body": body, "time": 1,
            }))
            .unwrap();
            ChatMessage::from_raw(raw, ChatChannel::Team).key
        };

        assert_eq!(build("same"), build("same"));
        assert_ne!(build("same"), build("different"));
    }

    #[test]
    fn unknown_fields_in_riots_payload_do_not_fail_the_parse() {
        let response: ConversationsResponse = serde_json::from_value(serde_json::json!({
            "conversations": [
                { "cid": ALL, "type": "groupchat", "unread_count": 3, "uiState": { "x": 1 } }
            ],
            "somethingRiotAddedLater": true,
        }))
        .unwrap();

        assert_eq!(response.conversations.len(), 1);
        assert_eq!(response.conversations[0].cid, ALL);
        assert_eq!(response.conversations[0].kind, "groupchat");
    }
}
