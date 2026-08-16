//! Tauri surface for VALORANT chat.
//!
//! # State
//!
//! [`RiotChatState`] holds `Arc<RwLock<Option<RiotChatClient>>>`. The client is
//! cached and reused for as long as the lockfile it was built from stays
//! byte-identical; a changed port, password or pid means the Riot Client
//! restarted or the player switched accounts, and the cached client is replaced
//! rather than retried.
//!
//! The lock is only ever held long enough to clone the client out or swap a new
//! one in. Every network call happens on a cloned `RiotChatClient` with no
//! guard held, so a slow or hanging Riot Client cannot block an unrelated
//! command. `reqwest::Client` clones share one connection pool, so this is
//! cheap.
//!
//! # Errors
//!
//! Commands return `Result<_, String>` built from [`RiotError`]'s `Display`,
//! which is sanitized at the source: no password, no `Authorization` header,
//! no raw response body. Nothing here re-formats an error with extra context
//! that could reintroduce those.

use crate::riot::chat::RiotChatClient;
use crate::riot::chat_command::{self, TranslationCommand};
use crate::riot::dedup::SeenMessages;
use crate::riot::error::RiotError;
use crate::riot::lockfile;
use crate::riot::models::{ChatChannel, ChatMessage, ConnectionStatus};
use crate::store::ConfigStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex, RwLock};

/// Events pushed to the frontend by the poller.
pub const EVENT_MESSAGE: &str = "riot-chat://message";
pub const EVENT_COMMAND: &str = "riot-chat://command";
pub const EVENT_ERROR: &str = "riot-chat://error";

const DEFAULT_POLL_INTERVAL_MS: u64 = 1_500;
const MIN_POLL_INTERVAL_MS: u64 = 500;

#[derive(Default)]
pub struct RiotChatState {
    client: Arc<RwLock<Option<RiotChatClient>>>,
    poller: Arc<Mutex<Option<Poller>>>,
}

struct Poller {
    shutdown: oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl RiotChatState {
    /// Starts the in-game `.send` poller. Restarts if one is already running.
    pub async fn begin_polling(&self, app: AppHandle, interval_ms: Option<u64>) {
        self.stop_polling().await;

        let interval = poll_interval(interval_ms);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let client_slot = self.client.clone();

        let task = tauri::async_runtime::spawn(async move {
            poll_loop(app, client_slot, interval, shutdown_rx).await;
        });

        *self.poller.lock().await = Some(Poller {
            shutdown: shutdown_tx,
            task,
        });
    }

    /// Returns a ready client, rebuilding it if the lockfile moved underneath
    /// us. Never holds a lock across an await that touches the network.
    pub async fn client(&self) -> Result<RiotChatClient, RiotError> {
        let lockfile = lockfile::read()?;

        {
            let guard = self.client.read().await;
            if let Some(existing) = guard.as_ref() {
                if existing.lockfile() == &lockfile {
                    return Ok(existing.clone());
                }
            }
        }

        let fresh = RiotChatClient::from_lockfile(lockfile)?;
        *self.client.write().await = Some(fresh.clone());
        Ok(fresh)
    }

    async fn forget_client(&self) {
        *self.client.write().await = None;
    }

    /// Stops a running poller and waits for the task to finish.
    ///
    /// Idempotent, so it is safe to call on app exit whether or not polling was
    /// ever started.
    pub async fn stop_polling(&self) {
        let taken = self.poller.lock().await.take();
        if let Some(poller) = taken {
            // A closed receiver just means the task already exited.
            let _ = poller.shutdown.send(());
            let _ = poller.task.await;
        }
    }
}

fn sanitized(error: RiotError) -> String {
    error.to_string()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn connect_riot_chat(
    state: State<'_, RiotChatState>,
) -> Result<ConnectionStatus, String> {
    let client = state.client().await.map_err(sanitized)?;
    let available_channels = client.available_channels().await;

    Ok(ConnectionStatus {
        connected: true,
        client_name: client.lockfile().name.clone(),
        available_channels,
    })
}

#[tauri::command]
pub async fn disconnect_riot_chat(state: State<'_, RiotChatState>) -> Result<(), String> {
    state.stop_polling().await;
    state.forget_client().await;
    Ok(())
}

#[tauri::command]
pub async fn get_chat_messages(
    channel: ChatChannel,
    state: State<'_, RiotChatState>,
) -> Result<Vec<ChatMessage>, String> {
    let client = state.client().await.map_err(sanitized)?;
    client.get_messages(channel).await.map_err(sanitized)
}

#[tauri::command]
pub async fn send_chat_message(
    channel: ChatChannel,
    message: String,
    state: State<'_, RiotChatState>,
) -> Result<(), String> {
    let client = state.client().await.map_err(sanitized)?;
    client
        .send_message(channel, &message)
        .await
        .map_err(sanitized)
}

#[tauri::command]
pub async fn get_available_chat_channels(
    state: State<'_, RiotChatState>,
) -> Result<Vec<ChatChannel>, String> {
    let client = state.client().await.map_err(sanitized)?;
    Ok(client.available_channels().await)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationOutcome {
    pub channel: ChatChannel,
    pub language: String,
    pub original: String,
    pub translated: String,
}

/// Runs a `.send {channel} {language} {message}` command.
///
/// The channel parsed from the command is the channel the translation is sent
/// to. It is resolved once, and if that room is not live the command fails with
/// [`RiotError::ChannelUnavailable`] - there is no substitution of a
/// neighbouring room for the one that was asked for.
#[tauri::command]
pub async fn send_translated_chat_message(
    command: String,
    app: AppHandle,
    state: State<'_, RiotChatState>,
) -> Result<TranslationOutcome, String> {
    let client = state.client().await.map_err(sanitized)?;
    let config = translator_config(&app);
    let parsed = chat_command::parse_translation_command_with_fallback(
        &command,
        &config.provider,
        Some(config.target_language.as_str()),
    )
    .map_err(sanitized)?;

    run_translation_command(&client, &parsed, &config, Some(&app))
        .await
        .map_err(sanitized)
}

/// Runs a typed command without going through the Tauri command wrapper.
///
/// Used by the ValoUtils Bot whisper path so `.send ...` sent as a DM is
/// handled the same way as a line typed in party/team/all.
pub async fn execute_typed_translation(
    command: &str,
    app: Option<&AppHandle>,
) -> Result<TranslationOutcome, crate::riot::error::RiotError> {
    let client = RiotChatClient::connect()?;
    let config = app
        .map(translator_config)
        .unwrap_or_else(|| TranslatorConfig {
            provider: "google".into(),
            deepl_api_key: String::new(),
            target_language: "en".into(),
        });
    let parsed = chat_command::parse_translation_command_with_fallback(
        command,
        &config.provider,
        Some(config.target_language.as_str()),
    )?;
    run_translation_command(&client, &parsed, &config, app).await
}

pub async fn execute_maybe_custom_command(
    input: &str,
    app: Option<&AppHandle>,
) -> Option<Result<String, crate::riot::error::RiotError>> {
    let commands = load_custom_commands(app);
    let expanded = chat_command::expand_custom_command(input, &commands)?;
    if chat_command::is_history_translate_command(&expanded) {
        Some(execute_history_translation(&expanded, app).await)
    } else if chat_command::is_translation_command(&expanded) {
        Some(
            execute_typed_translation(&expanded, app)
                .await
                .map(|outcome| format_translation_reply(&outcome)),
        )
    } else {
        None
    }
}

/// Which executor owns a line typed into the Chat tab composer.
///
/// Split out from [`chat_command`] so the routing can be tested without a Riot
/// Client: everything past this point needs a live session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerCommand {
    /// `.tran` / `.translate` — returns a summary to print locally.
    History(String),
    /// `.send` — translates and posts to a room.
    Translate(String),
    Unknown,
}

/// Routes a composer line, expanding a custom trigger first.
///
/// Unlike the in-game poller, a bare word is never a command here: the
/// composer is where the player writes ordinary messages, and matching `gg`
/// would make it impossible to ever say "gg".
///
/// The leading `.` is required *here* rather than trusted from the caller,
/// because [`chat_command::expand_custom_command`] deliberately normalises a
/// bare trigger into a dotted one for the in-game path - so without this guard
/// every trigger word would still be swallowed.
pub fn classify_composer_command(
    input: &str,
    commands: &[chat_command::CustomBotCommand],
) -> ComposerCommand {
    let trimmed = input.trim();
    if !trimmed.starts_with('.') {
        return ComposerCommand::Unknown;
    }
    let expanded = chat_command::expand_custom_command(trimmed, commands)
        .unwrap_or_else(|| trimmed.to_string());
    if chat_command::is_history_translate_command(&expanded) {
        ComposerCommand::History(expanded)
    } else if chat_command::is_translation_command(&expanded) {
        ComposerCommand::Translate(expanded)
    } else {
        ComposerCommand::Unknown
    }
}

/// Runs a command typed into the Chat tab composer.
///
/// The raw line is never posted to the room - the frontend routes here instead
/// of `chat:send` precisely so a mistyped command does not leak into chat.
#[tauri::command]
pub async fn chat_command(args: Vec<Value>, app: AppHandle) -> Result<String, ()> {
    let input = args
        .first()
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if input.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "Command is empty." }).to_string());
    }

    let commands = load_custom_commands(Some(&app));
    let outcome = match classify_composer_command(&input, &commands) {
        ComposerCommand::History(command) => execute_history_translation(&command, Some(&app)).await,
        ComposerCommand::Translate(command) => execute_typed_translation(&command, Some(&app))
            .await
            .map(|outcome| format_translation_reply(&outcome)),
        ComposerCommand::Unknown => {
            return Ok(json!({
                "success": false,
                "error": format!("Unknown command '{}'.", input.trim()),
            })
            .to_string())
        }
    };

    Ok(match outcome {
        Ok(reply) => json!({ "success": true, "reply": reply }).to_string(),
        Err(error) => json!({ "success": false, "error": error.to_string() }).to_string(),
    })
}

fn load_custom_commands(app: Option<&AppHandle>) -> Vec<chat_command::CustomBotCommand> {
    let Some(app) = app else {
        return Vec::new();
    };
    let Some(store) = app.try_state::<ConfigStore>() else {
        return Vec::new();
    };
    store
        .get("botCustomCommands")
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub async fn execute_history_translation(
    command: &str,
    app: Option<&AppHandle>,
) -> Result<String, crate::riot::error::RiotError> {
    let client = RiotChatClient::connect()?;
    let config = app
        .map(translator_config)
        .unwrap_or_else(|| TranslatorConfig {
            provider: "google".into(),
            deepl_api_key: String::new(),
            target_language: "en".into(),
        });
    let parsed = chat_command::parse_history_translate_command(
        command,
        &config.provider,
        Some(config.target_language.as_str()),
    )?;

    let channels = match parsed.channel {
        Some(channel) => vec![channel],
        None => vec![
            ChatChannel::Team,
            ChatChannel::Pregame,
            ChatChannel::All,
            ChatChannel::Party,
        ],
    };

    let mut collected = Vec::new();
    if let Ok(recent) = client.get_recent_messages().await {
        collected.extend(
            recent
                .into_iter()
                .filter(|message| history_channel_matches(parsed.channel, &message.cid)),
        );
    }
    for channel in channels {
        let Ok(cid) = resolve_send_cid(&client, channel, app).await else {
            continue;
        };
        let Ok(messages) = client.get_messages_for_cid(&cid, channel).await else {
            continue;
        };
        collected.extend(messages);
    }
    for live in crate::presence_proxy::live_chat_transcript() {
        if !history_channel_matches(parsed.channel, &live.cid) {
            continue;
        }
        let Some(channel) = ChatChannel::EVERY
            .into_iter()
            .find(|channel| channel.matches_cid(&live.cid))
        else {
            continue;
        };
        collected.push(crate::riot::models::ChatMessage {
            key: format!("live:{}", live.id),
            cid: live.cid,
            channel,
            sender_puuid: live.sender,
            sender_name: String::new(),
            sender_tag: String::new(),
            body: live.body,
            timestamp: live.timestamp,
        });
    }
    for live in crate::xmpp::get_xmpp_messages().await {
        if !history_channel_matches(parsed.channel, &live.conversation_id) {
            continue;
        }
        let Some(channel) = ChatChannel::EVERY
            .into_iter()
            .find(|channel| channel.matches_cid(&live.conversation_id))
        else {
            continue;
        };
        collected.push(crate::riot::models::ChatMessage {
            key: if live.id.is_empty() {
                format!("xmpp:{}:{}", live.conversation_id, live.body)
            } else {
                live.id.clone()
            },
            cid: live.conversation_id,
            channel,
            sender_puuid: live.sender,
            sender_name: live.sender_name,
            sender_tag: String::new(),
            body: live.body,
            timestamp: live.timestamp,
        });
    }

    collected.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    let mut seen = std::collections::HashSet::new();
    collected.retain(|message| {
        !chat_command::is_skippable_history_line(&message.body) && seen.insert(message.key.clone())
    });
    if collected.len() > parsed.count {
        collected = collected.split_off(collected.len() - parsed.count);
    }
    if collected.is_empty() {
        return Ok("No messages to translate.".into());
    }

    let mut parts = Vec::new();
    for (index, message) in collected.iter().enumerate() {
        let translated = crate::translate::translate_text(
            &message.body,
            &config.provider,
            "auto",
            &parsed.language,
            &config.deepl_api_key,
        )
        .await
        .map_err(RiotError::InvalidCommand)?;
        parts.push(format!(
            "{}. {} → {}",
            index + 1,
            preview_history_line(&message.body),
            translated.text.trim()
        ));
    }
    Ok(parts.join(" · "))
}

fn history_channel_matches(wanted: Option<ChatChannel>, cid: &str) -> bool {
    match wanted {
        None => ChatChannel::EVERY
            .into_iter()
            .any(|channel| channel.matches_cid(cid)),
        Some(ChatChannel::Team) | Some(ChatChannel::Pregame) => {
            ChatChannel::Team.matches_cid(cid) || ChatChannel::Pregame.matches_cid(cid)
        }
        Some(channel) => channel.matches_cid(cid),
    }
}

fn preview_history_line(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    const LIMIT: usize = 40;
    if compact.chars().count() <= LIMIT {
        return compact;
    }
    let mut preview: String = compact.chars().take(LIMIT).collect();
    preview.push('…');
    preview
}

pub fn format_translation_reply(outcome: &TranslationOutcome) -> String {
    format!(
        "Sent to {} ({}): {}",
        outcome.channel, outcome.language, outcome.translated
    )
}

async fn run_translation_command(
    client: &RiotChatClient,
    parsed: &TranslationCommand,
    config: &TranslatorConfig,
    app: Option<&AppHandle>,
) -> Result<TranslationOutcome, RiotError> {
    let translated = crate::translate::translate_text(
        &parsed.message,
        &config.provider,
        "auto",
        &parsed.language,
        &config.deepl_api_key,
    )
    .await
    .map_err(RiotError::InvalidCommand)?;

    let body = translated.text.clone();
    let cid = resolve_send_cid(client, parsed.channel, app).await?;

    // Prefer the game client's own XMPP so the line appears in party/team/all
    // on the player's screen. REST and ValoUtils XMPP can "succeed" without
    // the game ever rendering the message.
    let sent_in_game = crate::presence_proxy::send_groupchat_through_game(&cid, &body);
    if !sent_in_game && client.send_to_cid(&cid, &body).await.is_err() {
        send_via_xmpp(app, parsed.channel, &body).await?;
    }

    Ok(TranslationOutcome {
        channel: parsed.channel,
        language: translated.target_language,
        original: parsed.message.clone(),
        translated: translated.text,
    })
}

async fn resolve_send_cid(
    client: &RiotChatClient,
    channel: ChatChannel,
    app: Option<&AppHandle>,
) -> Result<String, RiotError> {
    if let Ok(cid) = client.resolve_cid(channel).await {
        return Ok(cid);
    }
    let Some(app) = app else {
        return Err(RiotError::ChannelUnavailable { channel });
    };
    let Some(riot) = app.try_state::<crate::riot::client::RiotState>() else {
        return Err(RiotError::ChannelUnavailable { channel });
    };
    match channel {
        ChatChannel::Party => {
            let (room, _) = crate::xmpp::ensure_party_xmpp_chat(&riot).await;
            if room.is_empty() {
                Err(RiotError::ChannelUnavailable { channel })
            } else {
                Ok(room)
            }
        }
        ChatChannel::Pregame | ChatChannel::Team | ChatChannel::All => {
            let (team, all) = crate::xmpp::ensure_match_xmpp_chat(&riot)
                .await
                .unwrap_or((None, None));
            let room = match channel {
                ChatChannel::All => all.unwrap_or_default(),
                _ => team.unwrap_or_default(),
            };
            if room.is_empty() {
                Err(RiotError::ChannelUnavailable { channel })
            } else {
                Ok(room)
            }
        }
    }
}

async fn send_via_xmpp(
    app: Option<&AppHandle>,
    channel: ChatChannel,
    body: &str,
) -> Result<(), RiotError> {
    let Some(app) = app else {
        return Err(RiotError::ChannelUnavailable { channel });
    };
    let Some(riot) = app.try_state::<crate::riot::client::RiotState>() else {
        return Err(RiotError::ChannelUnavailable { channel });
    };

    match channel {
        ChatChannel::Party => {
            let (room, _) = crate::xmpp::ensure_party_xmpp_chat(&riot).await;
            if room.is_empty() {
                return Err(RiotError::ChannelUnavailable { channel });
            }
            crate::xmpp::send_party_xmpp_message(&riot, &room, body)
                .await
                .map_err(RiotError::InvalidCommand)?;
        }
        ChatChannel::Pregame | ChatChannel::Team | ChatChannel::All => {
            let (team, all) = crate::xmpp::ensure_match_xmpp_chat(&riot)
                .await
                .unwrap_or((None, None));
            let room = match channel {
                ChatChannel::All => all.unwrap_or_default(),
                _ => team.unwrap_or_default(),
            };
            if room.is_empty() {
                return Err(RiotError::ChannelUnavailable { channel });
            }
            crate::xmpp::send_match_xmpp_message(&riot, &room, body)
                .await
                .map_err(RiotError::InvalidCommand)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/// Resolves the caller's requested interval to one the loop can safely run at.
///
/// The floor matters: each tick issues up to four conversation lookups plus a
/// history fetch per live room, all against a local HTTP server the game itself
/// depends on. An unclamped `0` would busy-loop against the Riot Client.
fn poll_interval(requested: Option<u64>) -> u64 {
    match requested {
        Some(value) => value.max(MIN_POLL_INTERVAL_MS),
        None => DEFAULT_POLL_INTERVAL_MS,
    }
}

#[tauri::command]
pub async fn start_chat_polling(
    interval_ms: Option<u64>,
    app: AppHandle,
    state: State<'_, RiotChatState>,
) -> Result<(), String> {
    state.begin_polling(app, interval_ms).await;
    Ok(())
}

#[tauri::command]
pub async fn stop_chat_polling(state: State<'_, RiotChatState>) -> Result<(), String> {
    state.stop_polling().await;
    Ok(())
}

/// One tick's worth of per-channel state.
#[derive(Default)]
struct PollMemory {
    /// Message keys already handled, bounded so a long session cannot grow it
    /// without limit.
    seen: SeenMessages,
    /// CIDs whose history has been primed. A CID appearing for the first time -
    /// on connect, or when a new match starts - has its whole history marked as
    /// seen and emits nothing, which is what stops old history being replayed.
    primed: SeenMessages,
    /// Last resolved CID per channel, used to notice a session change.
    cids: HashMap<ChatChannel, String>,
    local_puuid: Option<String>,
    /// Lines this app posted itself, so they cannot be read back as commands.
    echoes: PendingEchoes,
}

/// Bodies the bot has just posted, kept only until they come back around.
///
/// A custom trigger matches on the first word of a line and needs no prefix, so
/// a bare `gg` is a command. The translation the bot posts is itself a line of
/// chat from the local player, which means a trigger whose translation happens
/// to start with the trigger word would re-fire forever. Entries are consumed
/// on first match rather than merely remembered, so typing the same trigger
/// twice still works the second time.
#[derive(Default)]
struct PendingEchoes {
    bodies: VecDeque<String>,
}

impl PendingEchoes {
    /// Far more than the handful of lines that can be in flight at once, and
    /// small enough that the linear scan below stays free.
    const CAPACITY: usize = 32;

    fn remember(&mut self, body: &str) {
        self.bodies.push_back(normalize_echo(body));
        while self.bodies.len() > Self::CAPACITY {
            self.bodies.pop_front();
        }
    }

    /// Consumes a matching entry. `true` means this line was our own output.
    fn consume(&mut self, body: &str) -> bool {
        let wanted = normalize_echo(body);
        let Some(index) = self.bodies.iter().position(|entry| entry == &wanted) else {
            return false;
        };
        self.bodies.remove(index);
        true
    }
}

fn normalize_echo(body: &str) -> String {
    body.trim().to_lowercase()
}

/// What a line typed by the local player means.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OwnMessage {
    /// Ordinary chat, or our own echo. Nothing to do.
    Ignore,
    /// A command to run, already expanded to its `.send` form.
    Translate(String),
}

/// Classifies a line from the local player.
///
/// Kept separate from [`dispatch`] so the decision can be tested without a Riot
/// Client: everything below this point needs a live session, everything here is
/// pure apart from the echo bookkeeping.
fn plan_own_message(
    body: &str,
    commands: &[chat_command::CustomBotCommand],
    echoes: &mut PendingEchoes,
) -> OwnMessage {
    if echoes.consume(body) {
        return OwnMessage::Ignore;
    }
    if chat_command::is_translation_command(body) {
        return OwnMessage::Translate(body.to_string());
    }
    // A custom trigger expands to a full command. Triggers whose action is
    // `tran` expand to `.tran ...`, which produces a text summary with nowhere
    // to show it in-game, so those stay a UI-only feature and fall through.
    match chat_command::expand_custom_command(body, commands) {
        Some(expanded) if chat_command::is_translation_command(&expanded) => {
            OwnMessage::Translate(expanded)
        }
        _ => OwnMessage::Ignore,
    }
}

async fn poll_loop(
    app: AppHandle,
    client_slot: Arc<RwLock<Option<RiotChatClient>>>,
    interval_ms: u64,
    mut shutdown: oneshot::Receiver<()>,
) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut memory = PollMemory::default();

    loop {
        tokio::select! {
            // Biased so a shutdown request that arrives alongside a tick wins,
            // rather than racing one more round of network calls.
            biased;
            _ = &mut shutdown => break,
            _ = ticker.tick() => {
                if let Err(error) = poll_once(&app, &client_slot, &mut memory).await {
                    // A closed or signed-out Riot Client is the ordinary case
                    // here, not an incident. Keep ticking so the poller
                    // recovers by itself when the client comes back.
                    if !error.is_login_required() {
                        let _ = app.emit(EVENT_ERROR, error.to_string());
                    }
                }
            }
        }
    }
}

async fn poll_once(
    app: &AppHandle,
    client_slot: &Arc<RwLock<Option<RiotChatClient>>>,
    memory: &mut PollMemory,
) -> Result<(), RiotError> {
    let client = resolve_client(client_slot).await?;

    if memory.local_puuid.is_none() {
        memory.local_puuid = client.local_puuid().await.ok();
    }

    for channel in ChatChannel::EVERY {
        // An unavailable channel is the normal state for most of a session.
        let Ok(cid) = client.resolve_cid(channel).await else {
            memory.cids.remove(&channel);
            continue;
        };

        // A changed CID means a new match or party. Priming below handles the
        // history; recording it here keeps the map honest for the next tick.
        memory.cids.insert(channel, cid.clone());

        let Ok(messages) = client.get_messages_for_cid(&cid, channel).await else {
            continue;
        };

        // First sight of this room: swallow its backlog.
        let priming = memory.primed.observe(&cid);

        for message in messages {
            if !memory.seen.observe(&message.key) {
                continue;
            }
            if priming {
                continue;
            }
            dispatch(app, &client, &message, memory).await;
        }
    }

    Ok(())
}

/// Clones the cached client out, rebuilding it if the lockfile changed.
///
/// Mirrors [`RiotChatState::client`] but works on the bare slot, because the
/// poller outlives any `State` borrow.
async fn resolve_client(
    client_slot: &Arc<RwLock<Option<RiotChatClient>>>,
) -> Result<RiotChatClient, RiotError> {
    let lockfile = lockfile::read()?;
    {
        let guard = client_slot.read().await;
        if let Some(existing) = guard.as_ref() {
            if existing.lockfile() == &lockfile {
                return Ok(existing.clone());
            }
        }
    }
    let fresh = RiotChatClient::from_lockfile(lockfile)?;
    *client_slot.write().await = Some(fresh.clone());
    Ok(fresh)
}

/// Decides what a newly-seen message means.
///
/// Messages from the local player are ignored unless they are a `.send`
/// command or a custom trigger. What keeps a translated reply from being
/// translated again is the echo list: the body the bot posts is recorded on the
/// way out and consumed when the poller reads it back.
async fn dispatch(
    app: &AppHandle,
    client: &RiotChatClient,
    message: &ChatMessage,
    memory: &mut PollMemory,
) {
    let is_own = memory
        .local_puuid
        .as_deref()
        .is_some_and(|puuid| message.is_from(puuid));

    if is_own {
        let commands = load_custom_commands(Some(app));
        let OwnMessage::Translate(command) =
            plan_own_message(&message.body, &commands, &mut memory.echoes)
        else {
            return;
        };
        let config = translator_config(app);
        match chat_command::parse_translation_command_with_fallback(
            &command,
            &config.provider,
            Some(config.target_language.as_str()),
        ) {
            Ok(parsed) => match run_translation_command(client, &parsed, &config, Some(app)).await {
                Ok(outcome) => {
                    memory.echoes.remember(&outcome.translated);
                    let _ = app.emit(EVENT_COMMAND, outcome);
                }
                Err(error) => {
                    let _ = app.emit(EVENT_ERROR, error.to_string());
                }
            },
            Err(error) => {
                let _ = app.emit(EVENT_ERROR, error.to_string());
            }
        }
        return;
    }

    let _ = app.emit(EVENT_MESSAGE, message.clone());
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

pub struct TranslatorConfig {
    pub provider: String,
    pub deepl_api_key: String,
    pub target_language: String,
}

/// Reads translator settings from the same config store the Settings page
/// writes, so a command typed in-game honours the provider chosen in the UI.
fn translator_config(app: &AppHandle) -> TranslatorConfig {
    let Some(store) = app.try_state::<ConfigStore>() else {
        return TranslatorConfig {
            provider: "google".into(),
            deepl_api_key: String::new(),
            target_language: "en".into(),
        };
    };
    let text = |key: &str| {
        store
            .0
            .get(key)
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default()
    };
    let provider = match text("translatorProvider").as_str() {
        "deepl" => "deepl".to_string(),
        _ => "google".to_string(),
    };
    let target_language = text("translatorTargetLanguage");
    TranslatorConfig {
        provider,
        deepl_api_key: text("deeplApiKey"),
        target_language: if target_language.is_empty() {
            "en".into()
        } else {
            target_language
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom_commands() -> Vec<chat_command::CustomBotCommand> {
        vec![
            chat_command::CustomBotCommand {
                trigger: "gg".into(),
                action: "send".into(),
                channel: "team".into(),
                language: "french".into(),
                message: "good game".into(),
                count: 0,
            },
            chat_command::CustomBotCommand {
                trigger: "last".into(),
                action: "tran".into(),
                channel: "team".into(),
                language: String::new(),
                message: String::new(),
                count: 3,
            },
        ]
    }

    #[test]
    fn a_bare_trigger_typed_in_game_is_a_command() {
        let mut echoes = PendingEchoes::default();
        let commands = custom_commands();

        assert_eq!(
            plan_own_message("gg", &commands, &mut echoes),
            OwnMessage::Translate(".send team french good game".into())
        );
        // The dotted spelling keeps working.
        assert_eq!(
            plan_own_message(".gg", &commands, &mut echoes),
            OwnMessage::Translate(".send team french good game".into())
        );
        // As does a literal command.
        assert_eq!(
            plan_own_message(".send all french push a", &commands, &mut echoes),
            OwnMessage::Translate(".send all french push a".into())
        );
    }

    #[test]
    fn ordinary_chat_and_retired_syntax_stay_ordinary_chat() {
        let mut echoes = PendingEchoes::default();
        let commands = custom_commands();

        for body in [
            "nice one",
            "ggwp",
            "TR/send/team/french/hello",
            // `tran` triggers have nowhere to print their summary in-game.
            "last",
        ] {
            assert_eq!(
                plan_own_message(body, &commands, &mut echoes),
                OwnMessage::Ignore,
                "{body}"
            );
        }
    }

    #[test]
    fn the_bots_own_output_cannot_retrigger_a_bare_command() {
        let mut echoes = PendingEchoes::default();
        // A trigger whose translation starts with the trigger word is the loop
        // case: without the echo list this line would fire `gg` forever.
        let commands = vec![chat_command::CustomBotCommand {
            trigger: "gg".into(),
            action: "send".into(),
            channel: "team".into(),
            language: "french".into(),
            message: "gg wp".into(),
            count: 0,
        }];

        assert!(matches!(
            plan_own_message("gg", &commands, &mut echoes),
            OwnMessage::Translate(_)
        ));
        echoes.remember("gg wp");

        assert_eq!(
            plan_own_message("gg wp", &commands, &mut echoes),
            OwnMessage::Ignore,
            "the bot must not read its own line back as a command"
        );
    }

    #[test]
    fn an_echo_is_consumed_once_so_the_same_trigger_works_again() {
        let mut echoes = PendingEchoes::default();
        let commands = custom_commands();

        echoes.remember("gg");
        assert_eq!(plan_own_message("gg", &commands, &mut echoes), OwnMessage::Ignore);
        assert!(
            matches!(
                plan_own_message("gg", &commands, &mut echoes),
                OwnMessage::Translate(_)
            ),
            "a single echo must not mute the trigger for the rest of the session"
        );
    }

    #[test]
    fn echo_matching_ignores_case_and_surrounding_space() {
        let mut echoes = PendingEchoes::default();
        echoes.remember("  Bonne Chance  ");
        assert!(echoes.consume("bonne chance"));
    }

    #[test]
    fn the_echo_list_stays_bounded() {
        let mut echoes = PendingEchoes::default();
        for index in 0..(PendingEchoes::CAPACITY + 5) {
            echoes.remember(&format!("line-{index}"));
        }

        assert_eq!(echoes.bodies.len(), PendingEchoes::CAPACITY);
        assert!(!echoes.consume("line-0"), "oldest entries are evicted");
        assert!(echoes.consume("line-36"));
    }

    #[test]
    fn the_composer_routes_each_command_to_its_own_executor() {
        let commands = custom_commands();
        assert_eq!(
            classify_composer_command(".send team french gl hf", &commands),
            ComposerCommand::Translate(".send team french gl hf".into())
        );
        assert_eq!(
            classify_composer_command(".tran 3", &commands),
            ComposerCommand::History(".tran 3".into())
        );
        assert_eq!(
            classify_composer_command(".translate team 2", &commands),
            ComposerCommand::History(".translate team 2".into())
        );
    }

    #[test]
    fn the_composer_expands_a_dotted_custom_trigger() {
        let commands = custom_commands();
        assert_eq!(
            classify_composer_command(".gg", &commands),
            ComposerCommand::Translate(".send team french good game".into())
        );
        // A `tran` trigger has somewhere to print here, unlike in-game.
        assert_eq!(
            classify_composer_command(".last", &commands),
            ComposerCommand::History(".tran team 3".into())
        );
    }

    #[test]
    fn a_bare_word_is_never_a_command_in_the_composer() {
        // In-game a bare trigger fires. Here it must not, or the player could
        // never send "gg" as an ordinary message.
        let commands = custom_commands();
        assert_eq!(classify_composer_command("gg", &commands), ComposerCommand::Unknown);
        assert_eq!(
            classify_composer_command("good game everyone", &commands),
            ComposerCommand::Unknown
        );
    }

    #[test]
    fn an_unrecognised_dotted_line_is_reported_rather_than_sent() {
        let commands = custom_commands();
        assert_eq!(
            classify_composer_command(".nope arg", &commands),
            ComposerCommand::Unknown
        );
        assert_eq!(classify_composer_command(".", &commands), ComposerCommand::Unknown);
    }

    #[test]
    fn poll_interval_is_floored_so_a_zero_cannot_spin_the_loop() {
        assert_eq!(poll_interval(Some(0)), MIN_POLL_INTERVAL_MS);
        assert_eq!(poll_interval(Some(1)), MIN_POLL_INTERVAL_MS);
        assert_eq!(poll_interval(None), DEFAULT_POLL_INTERVAL_MS);
        // A caller asking for something slower than the floor gets what it
        // asked for.
        assert_eq!(poll_interval(Some(30_000)), 30_000);
    }

    #[test]
    fn priming_a_room_swallows_its_backlog_then_lets_new_traffic_through() {
        let mut memory = PollMemory::default();
        let cid = "9f2e-all@ares-coregame.eu1.pvp.net";

        // First sight of the room primes it.
        assert!(memory.primed.observe(cid), "first sight should prime");
        for key in ["hist-1", "hist-2"] {
            assert!(memory.seen.observe(key));
        }

        // Next tick: same room, so no priming, and the history is already seen.
        assert!(!memory.primed.observe(cid));
        assert!(!memory.seen.observe("hist-1"));
        assert!(memory.seen.observe("live-1"), "new message must pass");
    }

    #[test]
    fn a_new_match_primes_again_rather_than_replaying_the_old_room() {
        let mut memory = PollMemory::default();

        assert!(memory
            .primed
            .observe("match-a-all@ares-coregame.eu1.pvp.net"));
        assert!(!memory
            .primed
            .observe("match-a-all@ares-coregame.eu1.pvp.net"));
        // A different match is a different CID, so it primes on first sight.
        assert!(memory
            .primed
            .observe("match-b-all@ares-coregame.eu1.pvp.net"));
    }

    #[tokio::test]
    async fn xmpp_fallback_without_an_app_handle_keeps_the_channel_error() {
        let error = send_via_xmpp(None, ChatChannel::Party, "hello")
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            RiotError::ChannelUnavailable {
                channel: ChatChannel::Party
            }
        ));
    }

    #[test]
    fn history_channel_matches_party_and_team_rooms() {
        assert!(history_channel_matches(
            None,
            "abc@ares-parties.ap"
        ));
        assert!(history_channel_matches(
            Some(ChatChannel::Team),
            "m-blue@ares-pregame.ap"
        ));
        assert!(!history_channel_matches(
            Some(ChatChannel::Party),
            "m-blue@ares-pregame.ap"
        ));
    }

    #[test]
    fn translation_reply_names_the_room_and_keeps_the_translated_text() {
        let reply = format_translation_reply(&TranslationOutcome {
            channel: ChatChannel::All,
            language: "fr".into(),
            original: "hello everyone".into(),
            translated: "bonjour tout le monde".into(),
        });
        assert_eq!(reply, "Sent to All (fr): bonjour tout le monde");
    }

    #[test]
    fn sanitized_errors_are_just_the_display_form() {
        assert_eq!(
            sanitized(RiotError::ChannelUnavailable {
                channel: ChatChannel::All
            }),
            "All chat is not available right now."
        );
    }
}
