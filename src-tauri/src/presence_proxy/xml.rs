use crate::presence_proxy::PresenceMode;
use crate::riot::models::ChatChannel;
use base64::Engine;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use xmltree::{Element, EmitterConfig, XMLNode};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BotCommand {
    SetMode(PresenceMode),
    SetEnabled(bool),
    Status,
    Help,
    Translate,
    TranslateHistory,
    Unknown,
    Consume,
}

pub fn parse_bot_command(value: &str) -> Option<BotCommand> {
    match value.trim().to_ascii_lowercase().as_str() {
        "$online" | "online" => Some(BotCommand::SetMode(PresenceMode::Online)),
        "$offline" | "offline" => Some(BotCommand::SetMode(PresenceMode::Offline)),
        "$mobile" | "mobile" => Some(BotCommand::SetMode(PresenceMode::Mobile)),
        "$enable" | "enable" => Some(BotCommand::SetEnabled(true)),
        "$disable" | "disable" => Some(BotCommand::SetEnabled(false)),
        "$status" | "status" => Some(BotCommand::Status),
        "$help" | "help" => Some(BotCommand::Help),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveChatLine {
    pub id: String,
    pub cid: String,
    pub sender: String,
    pub body: String,
    pub timestamp: String,
}

pub fn parse_groupchat_line(stanza: &str) -> Option<LiveChatLine> {
    let root = Element::parse(stanza.as_bytes()).ok()?;
    if root.name != "message" {
        return None;
    }
    let kind = root.attributes.get("type").map(String::as_str).unwrap_or("");
    if !kind.eq_ignore_ascii_case("groupchat") {
        return None;
    }
    let body = root
        .get_child("body")
        .and_then(Element::get_text)?
        .into_owned();
    if body.trim().is_empty() {
        return None;
    }
    let from = root.attributes.get("from").cloned().unwrap_or_default();
    let to = root.attributes.get("to").cloned().unwrap_or_default();
    let (cid, sender) = if let Some((room, nick)) = from.split_once('/') {
        (room.to_string(), nick.to_string())
    } else if !from.is_empty() && from.contains('@') {
        (from, String::new())
    } else {
        (to.split('/').next().unwrap_or(&to).to_string(), String::new())
    };
    if cid.is_empty() {
        return None;
    }
    let id = root.attributes.get("id").cloned().unwrap_or_else(|| {
        format!("{cid}:{sender}:{}", body.chars().take(24).collect::<String>())
    });
    Some(LiveChatLine {
        id,
        cid,
        sender,
        body,
        timestamp: unix_millis().to_string(),
    })
}

pub fn bot_message_body(stanza: &str) -> Option<String> {
    Element::parse(stanza.as_bytes())
        .ok()?
        .get_child("body")?
        .get_text()
        .map(|body| body.into_owned())
}

/// Group MUC the game is actually in, taken from a live stanza.
///
/// Presence: `to="id@ares-coregame.na1.pvp.net/resource"`.
/// Outbound chat: `to="id-blue@ares-coregame.na1.pvp.net"`.
/// Incoming chat: `from="id@ares-parties.ap/nick"`.
pub fn group_muc_target(stanza: &str) -> Option<(ChatChannel, String, String)> {
    let root = Element::parse(stanza.as_bytes()).ok()?;
    let mut candidates = Vec::new();
    match root.name.as_str() {
        "presence" => {
            if let Some(to) = root.attributes.get("to") {
                candidates.push(to.clone());
            }
        }
        "message" => {
            for key in ["from", "to"] {
                if let Some(value) = root.attributes.get(key) {
                    candidates.push(value.clone());
                }
            }
        }
        _ => return None,
    }
    for candidate in candidates {
        let (room, resource) = match candidate.split_once('/') {
            Some((room, resource)) => (room.to_string(), resource.to_string()),
            None => (candidate, String::new()),
        };
        let Some(channel) = ChatChannel::EVERY
            .into_iter()
            .find(|channel| channel.matches_cid(&room))
        else {
            continue;
        };
        let resource = if root.name == "presence" {
            resource
        } else {
            String::new()
        };
        return Some((channel, room, resource));
    }
    None
}

pub fn party_muc_jid(stanza: &str) -> Option<String> {
    let (channel, room, _) = group_muc_target(stanza)?;
    (channel == ChatChannel::Party).then_some(room)
}

pub fn party_muc_target(stanza: &str) -> Option<(String, String)> {
    let (channel, room, resource) = group_muc_target(stanza)?;
    (channel == ChatChannel::Party).then_some((room, resource))
}

pub fn is_muc_presence(stanza: &str) -> bool {
    let Ok(root) = Element::parse(stanza.as_bytes()) else {
        return false;
    };
    if root.name != "presence" {
        return false;
    }
    root.attributes.get("to").is_some_and(|to| to.contains("@ares-parties."))
        || root.children.iter().any(|node| matches!(node, XMLNode::Element(child) if child.namespace.as_deref() == Some("http://jabber.org/protocol/muc")))
}

pub fn parse_bot_message(stanza: &str) -> Result<Option<(String, BotCommand)>, String> {
    let root = Element::parse(stanza.as_bytes()).map_err(|error| error.to_string())?;
    let Some(jid) = root.attributes.get("to") else {
        return Ok(None);
    };
    let root_id = jid.split('@').next().unwrap_or(jid);
    if !root_id.eq_ignore_ascii_case(crate::fake_player::PUUID) {
        return Ok(None);
    }
    if root.name != "message" {
        return Ok(Some((jid.clone(), BotCommand::Consume)));
    }
    let Some(body) = root.get_child("body").and_then(Element::get_text) else {
        return Ok(Some((jid.clone(), BotCommand::Consume)));
    };
    let command = if crate::riot::chat_command::is_history_translate_command(&body) {
        BotCommand::TranslateHistory
    } else if crate::riot::chat_command::is_translation_command(&body) {
        BotCommand::Translate
    } else {
        parse_bot_command(&body).unwrap_or(BotCommand::Unknown)
    };
    Ok(Some((jid.clone(), command)))
}

pub fn inject_bot_roster(stanza: &str, account_domain: &str) -> Result<Option<String>, String> {
    if !stanza.trim_start().starts_with("<iq") {
        return Ok(None);
    }
    let mut root = Element::parse(stanza.as_bytes()).map_err(|error| error.to_string())?;
    if root.name != "iq" {
        return Ok(None);
    }
    let Some(query) = root.get_mut_child("query") else {
        return Ok(None);
    };
    let namespace = query
        .namespace
        .as_deref()
        .or_else(|| query.attributes.get("xmlns").map(String::as_str));
    if !matches!(
        namespace,
        Some("jabber:iq:roster" | "jabber:iq:riotgames:roster")
    ) {
        return Ok(None);
    }
    let already_present = query.children.iter().any(|node| match node {
        XMLNode::Element(item) if item.name == "item" => item
            .attributes
            .get("jid")
            .and_then(|jid| jid.split('@').next())
            .map(|id| id.eq_ignore_ascii_case(crate::fake_player::PUUID))
            .unwrap_or(false),
        _ => false,
    });
    if already_present {
        return Ok(None);
    }

    let mut item = Element::new("item");
    item.attributes.insert(
        "jid".into(),
        format!("{}@{account_domain}", crate::fake_player::PUUID),
    );
    item.attributes
        .insert("name".into(), crate::fake_player::GAME_NAME.into());
    item.attributes.insert("subscription".into(), "both".into());
    item.attributes
        .insert("puuid".into(), crate::fake_player::PUUID.into());
    let mut group = Element::new("group");
    group.attributes.insert("priority".into(), "9999".into());
    group.children.push(XMLNode::Text("ValoUtils".to_string()));
    item.children.push(XMLNode::Element(group));
    let mut state = Element::new("state");
    state.children.push(XMLNode::Text("online".to_string()));
    item.children.push(XMLNode::Element(state));
    let mut id = Element::new("id");
    id.attributes
        .insert("name".into(), crate::fake_player::GAME_NAME.into());
    id.attributes
        .insert("tagline".into(), crate::fake_player::TAG_LINE.into());
    item.children.push(XMLNode::Element(id));
    let mut lol = Element::new("lol");
    lol.attributes
        .insert("name".into(), crate::fake_player::GAME_NAME.into());
    item.children.push(XMLNode::Element(lol));
    let mut platforms = Element::new("platforms");
    let mut riot = Element::new("riot");
    riot.attributes
        .insert("name".into(), crate::fake_player::GAME_NAME.into());
    riot.attributes
        .insert("tagline".into(), crate::fake_player::TAG_LINE.into());
    platforms.children.push(XMLNode::Element(riot));
    item.children.push(XMLNode::Element(platforms));
    query.children.push(XMLNode::Element(item));

    serialize_element(&root).map(Some)
}

pub fn extract_valorant_version(stanza: &str) -> Option<String> {
    let root = Element::parse(stanza.as_bytes()).ok()?;
    let encoded = root
        .get_child("games")?
        .get_child("valorant")?
        .get_child("p")?
        .get_text()?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim().as_bytes())
        .ok()?;
    let payload: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    payload
        .get("partyPresenceData")?
        .get("partyClientVersion")?
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

pub fn bot_presence(account_domain: &str, client_version: Option<&str>) -> String {
    let jid = escape_xml(&format!("{}@{account_domain}", crate::fake_player::PUUID));
    let timestamp = unix_millis();
    let sequence = next_sequence();
    let version = client_version.unwrap_or("unknown");
    let valorant = json!({
        "isValid": true,
        "isIdle": false,
        "queueId": "competitive",
        "provisioningFlow": "Invalid",
        "partyId": "00000000-0000-0000-0000-000000000000",
        "partySize": 1,
        "maxPartySize": 5,
        "partyOwnerMatchScoreAllyTeam": 0,
        "partyOwnerMatchScoreEnemyTeam": 0,
        "premierPresenceData": {
            "rosterId": "",
            "rosterName": "ValoUtils is active.",
            "rosterTag": "",
            "rosterType": "VCT",
            "division": 0,
            "score": 0,
            "plating": 0,
            "showAura": false,
            "showTag": false,
            "showPlating": false
        },
        "matchPresenceData": {
            "sessionLoopState": "MENUS",
            "provisioningFlow": "Invalid",
            "matchMap": "",
            "queueId": "competitive"
        },
        "partyPresenceData": {
            "partyId": "00000000-0000-0000-0000-000000000000",
            "isPartyOwner": true,
            "partyState": "DEFAULT",
            "partyAccessibility": "CLOSED",
            "partyLFM": false,
            "partyClientVersion": version,
            "partyVersion": timestamp,
            "partySize": 1,
            "queueEntryTime": "0001.01.01-00.00.00",
            "isPartyCrossPlayEnabled": false,
            "isPlayerCrossPlayEnabled": false,
            "partyPrecisePlatformTypes": 1,
            "customGameName": "ValoUtils Active!",
            "customGameTeam": "",
            "maxPartySize": 5,
            "tournamentId": "",
            "rosterId": "",
            "partyOwnerSessionLoopState": "MENUS",
            "partyOwnerMatchMap": "",
            "partyOwnerProvisioningFlow": "Invalid",
            "partyOwnerMatchScoreAllyTeam": 0,
            "partyOwnerMatchScoreEnemyTeam": 0
        },
        "playerPresenceData": {
            "playerCardId": "893deca1-4123-9c1f-2985-aa9de74cb512",
            "playerTitleId": "e3ca05a4-4e44-9afe-3791-7d96ca8f71fa",
            "accountLevel": 999,
            "competitiveTier": 0,
            "leaderboardPosition": 0
        }
    });
    let encoded = base64::engine::general_purpose::STANDARD.encode(valorant.to_string());
    format!(
        r#"<presence from="{jid}/RC-ValoUtils" id="valoutils-presence-{timestamp}-{sequence}"><games><keystone><st>chat</st><s.t>{timestamp}</s.t><s.p>keystone</s.p><pty/></keystone><league_of_legends><st>chat</st><s.t>{timestamp}</s.t><s.p>league_of_legends</s.p><s.c>live</s.c><p>{{&quot;pty&quot;:true}}</p></league_of_legends><valorant><st>chat</st><s.t>{timestamp}</s.t><s.p>valorant</s.p><s.r>PC</s.r><p>{encoded}</p><pty/></valorant><bacon><st>chat</st><s.t>{timestamp}</s.t><s.l>bacon_availability_online</s.l><s.p>bacon</s.p></bacon></games><show>chat</show><platform>riot</platform><status>ValoUtils presence control</status></presence>"#
    )
}

pub fn bot_reply(bot_jid: &str, body: &str, _sequence: u64) -> String {
    let stamp = riot_timestamp();
    let bare_jid = bot_jid.split('/').next().unwrap_or(bot_jid);
    format!(
        r#"<message from="{}/RC-ValoUtils" stamp="{stamp}" id="fake-{stamp}" type="chat"><body>{}</body></message>"#,
        escape_xml(bare_jid),
        escape_xml(body)
    )
}

pub fn bot_command_frames(
    account_domain: &str,
    client_version: Option<&str>,
    bot_jid: &str,
    reply: &str,
    sequence: u64,
) -> [String; 2] {
    [
        bot_presence(account_domain, client_version),
        bot_reply(bot_jid, reply, sequence),
    ]
}

fn next_sequence() -> u64 {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    SEQUENCE.fetch_add(1, Ordering::Relaxed)
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn riot_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let (year, month, day, hour, minute, second) =
        crate::util_time::civil_from_unix_secs(now.as_secs() as i64 + 1);
    format!(
        "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{:03}",
        now.subsec_millis()
    )
}

pub(crate) fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Debug, Eq, PartialEq)]
pub enum FrameError {
    TooLarge,
}

pub struct XmppFramer {
    buffer: Vec<u8>,
    max_bytes: usize,
}

impl XmppFramer {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_bytes,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();

        loop {
            if self.buffer.is_empty() {
                break;
            }
            if self.buffer[0].is_ascii_whitespace() {
                let end = self
                    .buffer
                    .iter()
                    .position(|byte| *byte == b'<')
                    .unwrap_or(self.buffer.len());
                if end > 0 {
                    frames.push(self.buffer.drain(..end).collect());
                    continue;
                }
            }
            let Some(end) = find_frame_end(&self.buffer) else {
                if self.buffer.len() > self.max_bytes {
                    return Err(FrameError::TooLarge);
                }
                break;
            };
            if end > self.max_bytes {
                return Err(FrameError::TooLarge);
            }
            frames.push(self.buffer.drain(..end).collect());
        }

        Ok(frames)
    }
}

fn find_frame_end(bytes: &[u8]) -> Option<usize> {
    if bytes.starts_with(b"<?xml") {
        return find_bytes(bytes, 0, b"?>").map(|index| index + 2);
    }
    if bytes.starts_with(b"</") {
        return find_tag_end(bytes, 2).map(|index| index + 1);
    }

    let mut index = 0;
    let mut depth = 0usize;
    let mut started = false;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        if bytes[index..].starts_with(b"<!--") {
            index = find_bytes(bytes, index + 4, b"-->")? + 3;
            continue;
        }
        if bytes[index..].starts_with(b"<![CDATA[") {
            index = find_bytes(bytes, index + 9, b"]]>")? + 3;
            continue;
        }
        if bytes[index..].starts_with(b"<?") {
            index = find_bytes(bytes, index + 2, b"?>")? + 2;
            continue;
        }

        let tag_end = find_tag_end(bytes, index + 1)?;
        let tag = &bytes[index..=tag_end];
        if tag.starts_with(b"<stream:stream") {
            return Some(tag_end + 1);
        }
        if tag.starts_with(b"</") {
            depth = depth.saturating_sub(1);
            if started && depth == 0 {
                return Some(tag_end + 1);
            }
        } else if !tag.starts_with(b"<!") {
            started = true;
            if tag.ends_with(b"/>") {
                if depth == 0 {
                    return Some(tag_end + 1);
                }
            } else {
                depth += 1;
            }
        }
        index = tag_end + 1;
    }
    None
}

fn find_tag_end(bytes: &[u8], mut index: usize) -> Option<usize> {
    let mut quote = None;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' if quote.is_none() => quote = Some(bytes[index]),
            value if quote == Some(value) => quote = None,
            b'>' if quote.is_none() => return Some(index),
            _ => {}
        }
        index += 1;
    }
    None
}

fn find_bytes(haystack: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    haystack
        .get(start..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| start + position)
}

pub fn is_global_presence(stanza: &str) -> bool {
    Element::parse(stanza.as_bytes())
        .map(|element| element.name == "presence" && !element.attributes.contains_key("to"))
        .unwrap_or(false)
}

pub fn rewrite_presence(stanza: &str, mode: PresenceMode) -> Result<Option<String>, String> {
    let mut root = Element::parse(stanza.as_bytes()).map_err(|error| error.to_string())?;
    if root.name != "presence" || root.attributes.contains_key("to") {
        return Ok(None);
    }
    if mode == PresenceMode::Online {
        return Ok(Some(stanza.to_string()));
    }

    set_child_text(
        &mut root,
        "show",
        match mode {
            PresenceMode::Mobile => "mobile",
            PresenceMode::Offline => "offline",
            PresenceMode::Online => unreachable!(),
        },
    );
    remove_children_named(&mut root, &["status"]);
    if let Some(games) = root.get_mut_child("games") {
        if mode == PresenceMode::Mobile {
            if let Some(mobile) = games.get_mut_child("keystone") {
                set_child_text(mobile, "st", "mobile");
                remove_children_named(mobile, &["m", "p"]);
            }
            if let Some(valorant) = games.get_mut_child("valorant") {
                set_child_text(valorant, "st", "offline");
                remove_children_named(valorant, &["m", "p"]);
            }
            remove_children_named(
                games,
                &["riot_client", "league_of_legends", "bacon", "lion"],
            );
        } else {
            remove_children_named(
                games,
                &[
                    "valorant",
                    "keystone",
                    "riot_client",
                    "league_of_legends",
                    "bacon",
                    "lion",
                ],
            );
        }
    }

    serialize_element(&root).map(Some)
}

fn serialize_element(root: &Element) -> Result<String, String> {
    let mut output = Vec::new();
    root.write_with_config(
        &mut output,
        EmitterConfig::new()
            .write_document_declaration(false)
            .perform_indent(false),
    )
    .map_err(|error| error.to_string())?;
    String::from_utf8(output).map_err(|error| error.to_string())
}

fn set_child_text(element: &mut Element, name: &str, value: &str) {
    if let Some(child) = element.get_mut_child(name) {
        child.children.clear();
        child.children.push(XMLNode::Text(value.to_string()));
        return;
    }
    let mut child = Element::new(name);
    child.children.push(XMLNode::Text(value.to_string()));
    element.children.push(XMLNode::Element(child));
}

fn remove_children_named(element: &mut Element, names: &[&str]) {
    element.children.retain(|node| match node {
        XMLNode::Element(child) => !names.contains(&child.name.as_str()),
        _ => true,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn frames_split_and_joined_stanzas() {
        let mut framer = XmppFramer::new(256 * 1024);
        assert!(framer.push(b"<presence><show>off").unwrap().is_empty());
        let frames = framer
            .push(b"line</show></presence><message><body>x</body></message>")
            .unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], b"<presence><show>offline</show></presence>");
    }

    #[test]
    fn forwards_the_stream_closing_tag() {
        let mut framer = XmppFramer::new(256 * 1024);
        assert_eq!(
            framer.push(b"</stream:stream>").unwrap(),
            vec![b"</stream:stream>".to_vec()]
        );
    }

    #[test]
    fn bounds_unclosed_input() {
        let mut framer = XmppFramer::new(16);
        assert!(matches!(
            framer.push(b"<presence>123456789"),
            Err(FrameError::TooLarge)
        ));
    }

    #[test]
    fn preserves_muc_presence() {
        let stanza =
            r#"<presence to="room@ares-parties.na1.pvp.net/me"><show>chat</show></presence>"#;
        assert_eq!(
            rewrite_presence(stanza, PresenceMode::Offline).unwrap(),
            None
        );
    }

    #[test]
    fn identifies_riot_party_presence() {
        assert!(is_muc_presence(
            r#"<presence to="room@ares-parties.na1.pvp.net/me"/>"#
        ));
        assert!(!is_muc_presence(
            r#"<presence><show>chat</show></presence>"#
        ));
    }

    #[test]
    fn reads_the_party_muc_the_game_joined() {
        assert_eq!(
            party_muc_target(r#"<presence to="p-1@ares-parties.na1.pvp.net/abc"/>"#),
            Some(("p-1@ares-parties.na1.pvp.net".into(), "abc".into()))
        );
        assert_eq!(
            party_muc_jid(
                r#"<message from="p-1@ares-parties.ap/friend" type="groupchat"><body>hi</body></message>"#
            )
            .as_deref(),
            Some("p-1@ares-parties.ap")
        );
        assert_eq!(
            party_muc_jid(r#"<presence to="match-all@ares-coregame.na1.pvp.net/me"/>"#),
            None
        );
        assert_eq!(
            group_muc_target(
                r#"<message to="9f2e-blue@ares-coregame.ap1.pvp.net" type="groupchat"><body>lol</body></message>"#
            ),
            Some((
                ChatChannel::Team,
                "9f2e-blue@ares-coregame.ap1.pvp.net".into(),
                String::new()
            ))
        );
        assert_eq!(
            group_muc_target(r#"<presence to="9f2e-all@ares-coregame.ap1.pvp.net/me"/>"#)
                .map(|(channel, room, _)| (channel, room)),
            Some((
                ChatChannel::All,
                "9f2e-all@ares-coregame.ap1.pvp.net".into()
            ))
        );
    }

    #[test]
    fn offline_removes_products() {
        let stanza = r#"<presence><show>chat</show><status>ready</status><games><valorant><p>secret</p></valorant><keystone/></games></presence>"#;
        let output = rewrite_presence(stanza, PresenceMode::Offline)
            .unwrap()
            .unwrap();
        assert!(output.contains("<show>offline</show>"));
        assert!(!output.contains("<status>"));
        assert!(!output.contains("<valorant>"));
        assert!(!output.contains("<keystone"));
    }

    #[test]
    fn mobile_matches_a_riot_mobile_resource_without_private_data() {
        let stanza = r#"<presence><show>chat</show><status>ready</status><games><keystone><st>chat</st></keystone><league_of_legends><st>chat</st><m>available</m><p>private</p></league_of_legends><valorant><st>chat</st><p>secret</p></valorant></games></presence>"#;
        let output = rewrite_presence(stanza, PresenceMode::Mobile)
            .unwrap()
            .unwrap();

        assert!(output.contains("<show>mobile</show>"));
        assert!(output.contains("<keystone><st>mobile</st>"));
        assert!(output.contains("<valorant><st>offline</st>"));
        assert!(!output.contains("<league_of_legends>"));
        assert!(!output.contains("<p>"));
    }

    #[test]
    fn online_preserves_exact_xml() {
        let stanza = "<presence><show>dnd</show></presence>";
        assert_eq!(
            rewrite_presence(stanza, PresenceMode::Online).unwrap(),
            Some(stanza.into())
        );
    }

    #[test]
    fn parses_presence_commands() {
        assert_eq!(
            parse_bot_command(" $OFFLINE "),
            Some(BotCommand::SetMode(PresenceMode::Offline))
        );
        assert_eq!(
            parse_bot_command("$mobile"),
            Some(BotCommand::SetMode(PresenceMode::Mobile))
        );
        assert_eq!(parse_bot_command("$status"), Some(BotCommand::Status));
        assert_eq!(parse_bot_command("$help"), Some(BotCommand::Help));
        assert_eq!(
            parse_bot_command("enable"),
            Some(BotCommand::SetEnabled(true))
        );
        assert_eq!(
            parse_bot_command("$disable"),
            Some(BotCommand::SetEnabled(false))
        );
        assert_eq!(parse_bot_command("$rank 27"), None);
    }

    #[test]
    fn intercepts_messages_to_local_bot() {
        let jid = format!("{}@na1.pvp.net", crate::fake_player::PUUID);
        let stanza = format!(r#"<message to="{jid}" type="chat"><body>$offline</body></message>"#);
        assert_eq!(
            parse_bot_message(&stanza).unwrap(),
            Some((jid, BotCommand::SetMode(PresenceMode::Offline)))
        );
    }

    #[test]
    fn intercepts_riot_style_namespaced_messages_with_a_resource() {
        let jid = format!("{}@sa1.pvp.net/RC-ValoUtils", crate::fake_player::PUUID);
        let stanza = format!(
            r#"<message xmlns="jabber:client" id="riot-1" to="{jid}" type="chat"><body>help</body><active xmlns="http://jabber.org/protocol/chatstates"/></message>"#
        );

        assert_eq!(
            parse_bot_message(&stanza).unwrap(),
            Some((jid, BotCommand::Help))
        );
    }

    #[test]
    fn parses_incoming_party_groupchat_for_history() {
        let stanza = r#"<message from="abc@ares-parties.ap/friend" type="groupchat" id="m-9"><body>Haha, stultusne es?</body></message>"#;
        let line = parse_groupchat_line(stanza).expect("groupchat");
        assert_eq!(line.cid, "abc@ares-parties.ap");
        assert_eq!(line.body, "Haha, stultusne es?");
        assert!(parse_groupchat_line(
            r#"<message to="bot@na1.pvp.net" type="chat"><body>.tran</body></message>"#
        )
        .is_none());
    }

    #[test]
    fn intercepts_history_translate_whispers_to_the_bot() {
        let jid = format!("{}@na1.pvp.net", crate::fake_player::PUUID);
        let stanza = format!(
            r#"<message to="{jid}" type="chat"><body>.tran [5]</body></message>"#
        );
        assert_eq!(
            parse_bot_message(&stanza).unwrap(),
            Some((jid, BotCommand::TranslateHistory))
        );
    }

    #[test]
    fn intercepts_translation_whispers_to_the_bot() {
        let jid = format!("{}@na1.pvp.net", crate::fake_player::PUUID);
        let stanza = format!(
            r#"<message to="{jid}" type="chat"><body>.send all french hello everyone</body></message>"#
        );
        assert_eq!(
            parse_bot_message(&stanza).unwrap(),
            Some((jid, BotCommand::Translate))
        );
    }

    #[test]
    fn intercepts_unknown_messages_to_local_bot() {
        let jid = format!("{}@na1.pvp.net", crate::fake_player::PUUID);
        let stanza = format!(r#"<message to="{jid}" type="chat"><body>hello</body></message>"#);
        assert_eq!(
            parse_bot_message(&stanza).unwrap(),
            Some((jid, BotCommand::Unknown))
        );
    }

    #[test]
    fn consumes_bodyless_and_non_message_stanzas_to_local_bot() {
        let jid = format!("{}@na1.pvp.net", crate::fake_player::PUUID);
        let receipt = format!(r#"<message to="{jid}" type="chat"><received id="1"/></message>"#);
        let iq = format!(r#"<iq to="{jid}" type="get"><ping/></iq>"#);

        assert_eq!(
            parse_bot_message(&receipt).unwrap(),
            Some((jid.clone(), BotCommand::Consume))
        );
        assert_eq!(
            parse_bot_message(&iq).unwrap(),
            Some((jid, BotCommand::Consume))
        );
    }

    #[test]
    fn leaves_real_direct_messages_alone() {
        let stanza =
            r#"<message to="real-player@na1.pvp.net" type="chat"><body>$offline</body></message>"#;
        assert_eq!(parse_bot_message(stanza).unwrap(), None);
    }

    #[test]
    fn injects_bot_into_roster_once() {
        let roster = r#"<iq type="result"><query xmlns="jabber:iq:roster"><item jid="real@na1.pvp.net"/></query></iq>"#;
        let output = inject_bot_roster(roster, "na1.pvp.net").unwrap().unwrap();
        assert!(output.contains(crate::fake_player::PUUID));
        assert!(output.contains("ValoUtils Bot"));
        assert!(inject_bot_roster(&output, "na1.pvp.net").unwrap().is_none());
    }

    #[test]
    fn roster_injection_ignores_xmpp_stream_frames() {
        assert_eq!(
            inject_bot_roster(r#"<?xml version="1.0"?>"#, "na1.pvp.net").unwrap(),
            None
        );
        assert_eq!(
            inject_bot_roster(
                r#"<stream:stream xmlns:stream="http://etherx.jabber.org/streams">"#,
                "na1.pvp.net"
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn injected_bot_has_the_full_riot_roster_identity() {
        let roster = r#"<iq type="result"><query xmlns="jabber:iq:riotgames:roster"/></iq>"#;
        let output = inject_bot_roster(roster, "na1.pvp.net").unwrap().unwrap();

        assert!(output.contains(&format!(r#"puuid="{}""#, crate::fake_player::PUUID)));
        assert!(output.contains("<group priority=\"9999\">ValoUtils</group>"));
        assert!(output.contains("<state>online</state>"));
        assert!(output.contains("<platforms>"));
        assert!(output.contains("ValoUtils Bot"));
    }

    #[test]
    fn extracts_the_current_valorant_client_version() {
        let payload = serde_json::json!({
            "partyPresenceData": { "partyClientVersion": "release-10.04-shipping-17" }
        });
        let encoded = base64::engine::general_purpose::STANDARD.encode(payload.to_string());
        let stanza =
            format!("<presence><games><valorant><p>{encoded}</p></valorant></games></presence>");

        assert_eq!(
            extract_valorant_version(&stanza).as_deref(),
            Some("release-10.04-shipping-17")
        );
    }

    #[test]
    fn bot_presence_contains_a_versioned_valorant_payload() {
        let stanza = bot_presence("na1.pvp.net", Some("release-10.04-shipping-17"));
        let root = Element::parse(stanza.as_bytes()).unwrap();
        let encoded = root
            .get_child("games")
            .and_then(|games| games.get_child("valorant"))
            .and_then(|valorant| valorant.get_child("p"))
            .and_then(Element::get_text)
            .unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&decoded).unwrap();

        assert_eq!(
            payload["partyPresenceData"]["partyClientVersion"],
            "release-10.04-shipping-17"
        );
        assert_eq!(payload["playerPresenceData"]["accountLevel"], 999);
        assert_eq!(payload["premierPresenceData"]["showTag"], false);
        assert_eq!(payload["premierPresenceData"]["rosterTag"], "");
        assert!(stanza.contains("<keystone>"));
        assert!(stanza.contains("<league_of_legends>"));
        assert!(stanza.contains("<bacon>"));
    }

    #[test]
    fn escapes_bot_reply_body() {
        let output = bot_reply("bot@na1.pvp.net", "mode <offline> & ready", 7);
        let root = Element::parse(output.as_bytes()).unwrap();
        assert!(output.contains("mode &lt;offline&gt; &amp; ready"));
        let stamp = root.attributes.get("stamp").unwrap();
        assert_eq!(root.attributes.get("id"), Some(&format!("fake-{stamp}")));
    }

    #[test]
    fn bot_reply_replaces_the_resource_from_a_full_recipient_jid() {
        let output = bot_reply(
            "bot@na1.pvp.net/RC-ValoUtils",
            "You are now appearing offline.",
            8,
        );
        let root = Element::parse(output.as_bytes()).unwrap();

        assert_eq!(
            root.attributes.get("from").map(String::as_str),
            Some("bot@na1.pvp.net/RC-ValoUtils")
        );
    }

    #[test]
    fn bot_command_refreshes_presence_before_replying_to_valorant() {
        let domain = "eu1.pvp.net";
        let bot_jid = format!("{}@{domain}/RC-ValoUtils", crate::fake_player::PUUID);
        let frames = bot_command_frames(
            domain,
            Some("release-10.04-shipping-17"),
            &bot_jid,
            "You are now appearing offline.",
            7,
        );

        assert_eq!(frames.len(), 2);
        assert!(frames[0].starts_with(&format!(
            "<presence from=\"{}@{domain}/RC-ValoUtils\"",
            crate::fake_player::PUUID
        )));
        assert!(frames[0].contains("<valorant>"));
        let reply = Element::parse(frames[1].as_bytes()).unwrap();
        assert_eq!(
            reply.attributes.get("from").map(String::as_str),
            Some(bot_jid.as_str())
        );
        let stamp = reply.attributes.get("stamp").unwrap();
        assert_eq!(reply.attributes.get("id"), Some(&format!("fake-{stamp}")));
        assert!(frames[1].contains("<body>You are now appearing offline.</body>"));
    }
}
