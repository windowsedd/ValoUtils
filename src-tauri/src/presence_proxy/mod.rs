mod local_ca;
mod relay;
mod xml;

pub use relay::{start, stop};

use crate::riot::models::ChatChannel;
use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceMode {
    Online,
    Offline,
    Mobile,
}

impl PresenceMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "online" => Some(Self::Online),
            "offline" => Some(Self::Offline),
            "mobile" => Some(Self::Mobile),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Offline => "offline",
            Self::Mobile => "mobile",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpstreamTarget {
    pub host: String,
    pub port: u16,
    pub affinity: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskingState {
    pub enabled: bool,
    pub mode: PresenceMode,
    pub connect_to_muc: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshot {
    pub enabled: bool,
    pub mode: PresenceMode,
    pub connect_to_muc: bool,
    pub relay_running: bool,
    pub relay_port: Option<u16>,
    pub active_connections: usize,
    pub upstream_ready: bool,
    pub last_warning: Option<String>,
}

struct Inner {
    masking: MaskingState,
    relay_port: Option<u16>,
    active_connections: usize,
    upstream: Option<UpstreamTarget>,
    last_presence: Option<String>,
    last_warning: Option<String>,
}

pub struct PresenceController {
    inner: Mutex<Inner>,
    state_tx: broadcast::Sender<MaskingState>,
}

impl PresenceController {
    pub fn new(enabled: bool, mode: PresenceMode, connect_to_muc: bool) -> Self {
        let (state_tx, _) = broadcast::channel(16);
        Self {
            inner: Mutex::new(Inner {
                masking: MaskingState {
                    enabled,
                    mode,
                    connect_to_muc,
                },
                relay_port: None,
                active_connections: 0,
                upstream: None,
                last_presence: None,
                last_warning: None,
            }),
            state_tx,
        }
    }
    pub fn state(&self) -> MaskingState {
        self.inner.lock().unwrap().masking
    }
    pub fn mode(&self) -> PresenceMode {
        self.state().mode
    }
    fn mutate(&self, update: impl FnOnce(&mut MaskingState)) {
        let state = {
            let mut inner = self.inner.lock().unwrap();
            update(&mut inner.masking);
            inner.masking
        };
        let _ = self.state_tx.send(state);
    }
    pub fn set_mode(&self, mode: PresenceMode) {
        self.mutate(|state| state.mode = mode);
    }
    pub fn set_mode_and_enable(&self, mode: PresenceMode) {
        self.mutate(|state| {
            state.mode = mode;
            state.enabled = true;
        });
    }
    pub fn set_enabled(&self, enabled: bool) {
        self.mutate(|state| state.enabled = enabled);
    }
    pub fn set_connect_to_muc(&self, value: bool) {
        self.mutate(|state| state.connect_to_muc = value);
    }
    pub fn subscribe_state(&self) -> broadcast::Receiver<MaskingState> {
        self.state_tx.subscribe()
    }
    pub fn apply_command(&self, command: crate::fake_player::FakePlayerCommand) -> String {
        use crate::fake_player::FakePlayerCommand::*;
        match command {
            Online => {
                self.set_mode_and_enable(PresenceMode::Online);
                "You are now appearing online.".into()
            }
            Offline => {
                self.set_mode_and_enable(PresenceMode::Offline);
                "You are now appearing offline.".into()
            }
            Mobile => {
                self.set_mode_and_enable(PresenceMode::Mobile);
                "You are now appearing mobile.".into()
            }
            Enable => {
                self.set_enabled(true);
                "Presence masking is now enabled.".into()
            }
            Disable => {
                self.set_enabled(false);
                "Presence masking is now disabled.".into()
            }
            Status => {
                let state = self.state();
                format!(
                    "Masking: {}. Status: {}.",
                    if state.enabled { "enabled" } else { "disabled" },
                    state.mode.as_str()
                )
            }
            Help => crate::fake_player::help_text().into(),
        }
    }
    pub fn set_upstream(&self, target: UpstreamTarget) {
        self.inner.lock().unwrap().upstream = Some(target);
    }
    pub fn upstream(&self) -> Option<UpstreamTarget> {
        self.inner.lock().unwrap().upstream.clone()
    }
    pub fn set_relay_port(&self, port: Option<u16>) {
        self.inner.lock().unwrap().relay_port = port;
    }
    pub fn relay_port(&self) -> Option<u16> {
        self.inner.lock().unwrap().relay_port
    }
    pub fn connection_opened(&self) {
        self.inner.lock().unwrap().active_connections += 1;
    }
    pub fn connection_closed(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.active_connections = inner.active_connections.saturating_sub(1);
    }
    pub fn capture_presence(&self, stanza: String) {
        self.inner.lock().unwrap().last_presence = Some(stanza);
    }
    pub fn last_presence(&self) -> Option<String> {
        self.inner.lock().unwrap().last_presence.clone()
    }
    pub fn set_warning(&self, warning: Option<String>) {
        self.inner.lock().unwrap().last_warning = warning;
    }
    pub fn snapshot(&self) -> PresenceSnapshot {
        let inner = self.inner.lock().unwrap();
        PresenceSnapshot {
            enabled: inner.masking.enabled,
            mode: inner.masking.mode,
            connect_to_muc: inner.masking.connect_to_muc,
            relay_running: inner.relay_port.is_some(),
            relay_port: inner.relay_port,
            active_connections: inner.active_connections,
            upstream_ready: inner.upstream.is_some(),
            last_warning: inner.last_warning.clone(),
        }
    }
}

static CONTROLLER: OnceLock<PresenceController> = OnceLock::new();
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static OUTBOUND: OnceLock<broadcast::Sender<String>> = OnceLock::new();

fn outbound() -> &'static broadcast::Sender<String> {
    OUTBOUND.get_or_init(|| broadcast::channel(32).0)
}

pub fn subscribe_outbound() -> broadcast::Receiver<String> {
    outbound().subscribe()
}

/// Inject a groupchat stanza through the game client's XMPP so it shows up
/// in-game as a normal party/team/all line, not only in a ValoUtils session.
const LIVE_CHAT_MAX: usize = 200;

fn live_chat() -> &'static Mutex<VecDeque<xml::LiveChatLine>> {
    static TRANSCRIPT: OnceLock<Mutex<VecDeque<xml::LiveChatLine>>> = OnceLock::new();
    TRANSCRIPT.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub fn record_live_chat(stanza: &str) {
    record_group_muc_from_stanza(stanza);
    let Some(line) = xml::parse_groupchat_line(stanza) else {
        return;
    };
    if let Ok(mut transcript) = live_chat().lock() {
        transcript.push_back(line);
        while transcript.len() > LIVE_CHAT_MAX {
            transcript.pop_front();
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ObservedRoom {
    room: String,
    resource: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ObservedMucs {
    party: ObservedRoom,
    team: ObservedRoom,
    all: ObservedRoom,
    pregame: ObservedRoom,
}

fn observed_mucs() -> &'static Mutex<ObservedMucs> {
    static OBSERVED: OnceLock<Mutex<ObservedMucs>> = OnceLock::new();
    OBSERVED.get_or_init(|| Mutex::new(ObservedMucs::default()))
}

fn room_slot(observed: &mut ObservedMucs, channel: ChatChannel) -> &mut ObservedRoom {
    match channel {
        ChatChannel::Party => &mut observed.party,
        ChatChannel::Team => &mut observed.team,
        ChatChannel::All => &mut observed.all,
        ChatChannel::Pregame => &mut observed.pregame,
    }
}

fn room_slot_ref(observed: &ObservedMucs, channel: ChatChannel) -> &ObservedRoom {
    match channel {
        ChatChannel::Party => &observed.party,
        ChatChannel::Team => &observed.team,
        ChatChannel::All => &observed.all,
        ChatChannel::Pregame => &observed.pregame,
    }
}

pub fn record_group_muc_from_stanza(stanza: &str) {
    let Some((channel, room, resource)) = xml::group_muc_target(stanza) else {
        return;
    };
    if let Ok(mut observed) = observed_mucs().lock() {
        let slot = room_slot(&mut observed, channel);
        slot.room = room;
        if !resource.is_empty() {
            slot.resource = resource;
        }
    }
}

pub fn record_party_muc_from_stanza(stanza: &str) {
    record_group_muc_from_stanza(stanza);
}

pub fn last_group_muc_jid(channel: ChatChannel) -> Option<String> {
    observed_mucs().lock().ok().and_then(|observed| {
        let room = &room_slot_ref(&observed, channel).room;
        if room.is_empty() {
            None
        } else {
            Some(room.clone())
        }
    })
}

pub fn last_party_muc_jid() -> Option<String> {
    last_group_muc_jid(ChatChannel::Party)
}

pub fn last_group_muc_resource(channel: ChatChannel) -> String {
    observed_mucs()
        .lock()
        .map(|observed| {
            let specific = room_slot_ref(&observed, channel).resource.clone();
            if !specific.is_empty() {
                return specific;
            }
            [
                ChatChannel::All,
                ChatChannel::Team,
                ChatChannel::Party,
                ChatChannel::Pregame,
            ]
            .into_iter()
            .map(|item| room_slot_ref(&observed, item).resource.clone())
            .find(|resource| !resource.is_empty())
            .unwrap_or_default()
        })
        .unwrap_or_default()
}

pub fn last_party_muc_resource() -> String {
    last_group_muc_resource(ChatChannel::Party)
}

/// Re-join if we know the occupant nick, then post through the game XMPP.
pub fn send_group_through_game(channel: ChatChannel, room: &str, body: &str) -> bool {
    if room.is_empty() || body.is_empty() {
        return false;
    }
    let resource = last_group_muc_resource(channel);
    if !resource.is_empty() {
        let join = format!(
            r#"<presence to="{}/{}"><x xmlns="http://jabber.org/protocol/muc"/></presence>"#,
            xml::escape_xml(room),
            xml::escape_xml(&resource)
        );
        if outbound().send(join).is_err() {
            return false;
        }
    }
    send_groupchat_through_game(room, body)
}

pub fn send_party_through_game(room: &str, body: &str) -> bool {
    send_group_through_game(ChatChannel::Party, room, body)
}

pub fn live_chat_transcript() -> Vec<xml::LiveChatLine> {
    live_chat()
        .lock()
        .map(|transcript| transcript.iter().cloned().collect())
        .unwrap_or_default()
}

pub fn send_groupchat_through_game(cid: &str, body: &str) -> bool {
    if cid.is_empty() || body.is_empty() {
        return false;
    }
    let stanza = format!(
        r#"<message to="{}" type="groupchat"><body>{}</body></message>"#,
        xml::escape_xml(cid),
        xml::escape_xml(body)
    );
    outbound().send(stanza).is_ok()
}

pub fn init(enabled: bool, mode: PresenceMode, connect_to_muc: bool) -> Result<(), &'static str> {
    CONTROLLER
        .set(PresenceController::new(enabled, mode, connect_to_muc))
        .map_err(|_| "presence controller already initialized")
}
pub fn controller() -> &'static PresenceController {
    CONTROLLER
        .get()
        .expect("presence controller must be initialized during app setup")
}
pub fn attach_app(app: AppHandle) -> Result<(), &'static str> {
    APP_HANDLE
        .set(app)
        .map_err(|_| "presence app handle already initialized")
}

pub fn app_handle() -> Option<&'static AppHandle> {
    APP_HANDLE.get()
}

pub fn change_mode(mode: PresenceMode) {
    controller().set_mode_and_enable(mode);
    persist_and_emit();
}
pub fn change_enabled(enabled: bool) {
    controller().set_enabled(enabled);
    persist_and_emit();
}
pub fn change_connect_to_muc(value: bool) {
    controller().set_connect_to_muc(value);
    persist_and_emit();
}
pub fn apply_command(command: crate::fake_player::FakePlayerCommand) -> String {
    let reply = controller().apply_command(command);
    if !matches!(
        command,
        crate::fake_player::FakePlayerCommand::Status | crate::fake_player::FakePlayerCommand::Help
    ) {
        persist_and_emit();
    }
    reply
}

fn persist_and_emit() {
    if let Some(app) = APP_HANDLE.get() {
        let state = controller().state();
        if let Some(config) = app.try_state::<crate::store::ConfigStore>() {
            config.set("presenceEnabled", json!(state.enabled));
            config.set("presenceMode", json!(state.mode.as_str()));
            config.set("presenceMucEnabled", json!(state.connect_to_muc));
        }
        let payload = json!({ "success": true, "presence": controller().snapshot() }).to_string();
        let _ = app.emit("presence:status-changed", payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn game_groupchat_inject_is_a_no_op_without_a_live_relay() {
        assert!(!send_groupchat_through_game(
            "party@ares-parties.ap",
            "hello everyone\n大家好"
        ));
        assert!(!send_groupchat_through_game("", "hello"));
    }

    #[test]
    fn remembers_the_party_muc_the_game_joined() {
        record_party_muc_from_stanza(
            r#"<presence to="live@ares-parties.ap1.pvp.net/occupant"/>"#,
        );
        assert_eq!(
            last_party_muc_jid().as_deref(),
            Some("live@ares-parties.ap1.pvp.net")
        );
        assert_eq!(last_party_muc_resource(), "occupant");
        record_party_muc_from_stanza(
            r#"<message from="live@ares-parties.ap1.pvp.net/friend" type="groupchat"><body>x</body></message>"#,
        );
        assert_eq!(last_party_muc_resource(), "occupant");
    }

    #[test]
    fn remembers_the_team_room_the_player_just_typed_in() {
        record_group_muc_from_stanza(
            r#"<message to="9f2e-blue@ares-coregame.ap1.pvp.net" type="groupchat"><body>lol</body></message>"#,
        );
        assert_eq!(
            last_group_muc_jid(ChatChannel::Team).as_deref(),
            Some("9f2e-blue@ares-coregame.ap1.pvp.net")
        );
    }

    #[test]
    fn parses_supported_modes() {
        assert_eq!(PresenceMode::parse("online"), Some(PresenceMode::Online));
        assert_eq!(
            PresenceMode::parse(" OFFLINE "),
            Some(PresenceMode::Offline)
        );
        assert_eq!(PresenceMode::parse("mobile"), Some(PresenceMode::Mobile));
        assert_eq!(PresenceMode::parse("away"), None);
    }
    #[test]
    fn starts_offline_without_connections() {
        let state = PresenceController::new(false, PresenceMode::Offline, true).snapshot();
        assert_eq!(state.mode, PresenceMode::Offline);
        assert_eq!(state.active_connections, 0);
        assert!(!state.relay_running);
    }
    #[test]
    fn status_commands_enable_masking_and_broadcast_complete_state() {
        let controller = PresenceController::new(false, PresenceMode::Offline, true);
        let mut updates = controller.subscribe_state();
        assert_eq!(
            controller.apply_command(crate::fake_player::FakePlayerCommand::Mobile),
            "You are now appearing mobile."
        );
        assert!(controller.snapshot().enabled);
        assert_eq!(updates.try_recv().unwrap().mode, PresenceMode::Mobile);
    }
    #[test]
    fn disable_passes_original_presence_through() {
        let controller = PresenceController::new(true, PresenceMode::Offline, true);
        assert_eq!(
            controller.apply_command(crate::fake_player::FakePlayerCommand::Disable),
            "Presence masking is now disabled."
        );
        assert!(!controller.snapshot().enabled);
    }
}
