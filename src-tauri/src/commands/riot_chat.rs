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
use crate::riot::chat_lifecycle::{LifecycleTracker, LifecycleTransition, PhaseObservation};
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

pub(crate) struct PreparedTranslation {
    pub live_cid: String,
    pub body: String,
    pub reply: String,
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

pub(crate) async fn prepare_typed_translation(
    command: &str,
    app: Option<&AppHandle>,
    pinned_live_cid: Option<&str>,
) -> Result<PreparedTranslation, crate::riot::error::RiotError> {
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
    let prepared =
        prepare_translation_command(&client, &parsed, &config, app, pinned_live_cid, false).await?;
    let reply = format_translation_reply(&prepared.outcome);
    Ok(PreparedTranslation {
        live_cid: prepared.live_cid,
        body: prepared.body,
        reply,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResolvedCustomCommand {
    History(String),
    Group(String),
    Direct(String),
}

struct DirectTranslationRequest {
    message: String,
    provider: String,
    source_language: String,
    target_language: String,
    deepl_api_key: String,
}

fn direct_translation_request(
    language: &str,
    message: &str,
    config: &TranslatorConfig,
) -> Result<Option<DirectTranslationRequest>, RiotError> {
    let language = language.trim();
    if language.is_empty() || language.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    let target_language = crate::translate::resolve_target_language(&config.provider, language)
        .ok_or_else(|| RiotError::InvalidCommand(format!("Unknown language '{language}'.")))?;
    Ok(Some(DirectTranslationRequest {
        message: message.to_string(),
        provider: config.provider.clone(),
        source_language: "auto".into(),
        target_language,
        deepl_api_key: config.deepl_api_key.clone(),
    }))
}

async fn resolve_direct_message(
    language: &str,
    message: &str,
    app: Option<&AppHandle>,
) -> Result<String, RiotError> {
    let config = app
        .map(translator_config)
        .unwrap_or_else(|| TranslatorConfig {
            provider: "google".into(),
            deepl_api_key: String::new(),
            target_language: "en".into(),
        });
    let Some(request) = direct_translation_request(language, message, &config)? else {
        return Ok(message.to_string());
    };
    crate::translate::translate_text(
        &request.message,
        &request.provider,
        &request.source_language,
        &request.target_language,
        &request.deepl_api_key,
    )
    .await
    .map(|translated| translated.text)
    .map_err(RiotError::InvalidCommand)
}

async fn resolve_matched_custom_command(
    command: &chat_command::CustomBotCommand,
    app: Option<&AppHandle>,
) -> Result<Option<ResolvedCustomCommand>, RiotError> {
    let resolved_message = if command.action.trim().eq_ignore_ascii_case("send") {
        match app {
            Some(app) => super::bot_template::resolve_custom_message(app, &command.message).await,
            None => crate::riot::chat_template::render_template(&command.message, &HashMap::new()),
        }
    } else {
        command.message.clone()
    };
    let Some(expanded) = chat_command::expand_matched_custom_command(command, &resolved_message)
    else {
        return Ok(None);
    };
    match expanded {
        chat_command::ExpandedCustomCommand::History(command) => {
            Ok(Some(ResolvedCustomCommand::History(command)))
        }
        chat_command::ExpandedCustomCommand::Group(command) => {
            Ok(Some(ResolvedCustomCommand::Group(command)))
        }
        chat_command::ExpandedCustomCommand::Direct { language, message } => {
            let message = resolve_direct_message(&language, &message, app).await?;
            Ok(Some(ResolvedCustomCommand::Direct(message)))
        }
    }
}

fn deliver_proactive_direct_with(
    body: &str,
    deliver: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, RiotError> {
    deliver(body).map_err(RiotError::InvalidCommand)?;
    Ok("Dummy Bot sent you a direct message.".into())
}

fn deliver_proactive_direct(body: &str) -> Result<String, RiotError> {
    deliver_proactive_direct_with(body, |message| {
        crate::presence_proxy::send_bot_direct(message)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

fn deliver_source_reply_direct(body: String) -> String {
    body
}

pub(crate) async fn resolve_custom_command_for_bot(
    input: &str,
    app: Option<&AppHandle>,
) -> Result<Option<ResolvedCustomCommand>, RiotError> {
    let commands = load_custom_commands(app);
    let Some(command) = chat_command::find_custom_command(input, &commands) else {
        return Ok(None);
    };
    resolve_matched_custom_command(&command, app).await
}

pub async fn execute_maybe_custom_command(
    input: &str,
    app: Option<&AppHandle>,
) -> Option<Result<String, crate::riot::error::RiotError>> {
    let resolved = match resolve_custom_command_for_bot(input, app).await {
        Ok(Some(resolved)) => resolved,
        Ok(None) => return None,
        Err(error) => return Some(Err(error)),
    };
    match resolved {
        ResolvedCustomCommand::History(command) => {
            Some(execute_history_translation(&command, app).await)
        }
        ResolvedCustomCommand::Group(command) => Some(
            execute_typed_translation(&command, app)
                .await
                .map(|outcome| format_translation_reply(&outcome)),
        ),
        ResolvedCustomCommand::Direct(body) => Some(Ok(deliver_source_reply_direct(body))),
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
    /// A saved `Send` command whose message may still contain templates.
    Custom(chat_command::CustomBotCommand),
    /// `.dodge` — leave agent select.
    Dodge,
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
    if let Some(command) = chat_command::find_custom_command(trimmed, commands) {
        if command.action.trim().eq_ignore_ascii_case("send") {
            return ComposerCommand::Custom(command);
        }
    }
    let expanded = chat_command::expand_custom_command(trimmed, commands)
        .unwrap_or_else(|| trimmed.to_string());
    if chat_command::is_history_translate_command(&expanded) {
        ComposerCommand::History(expanded)
    } else if chat_command::is_translation_command(&expanded) {
        ComposerCommand::Translate(expanded)
    } else if chat_command::is_dodge_command(&expanded) {
        ComposerCommand::Dodge
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
        ComposerCommand::History(command) => {
            execute_history_translation(&command, Some(&app)).await
        }
        ComposerCommand::Translate(command) => execute_typed_translation(&command, Some(&app))
            .await
            .map(|outcome| format_translation_reply(&outcome)),
        ComposerCommand::Custom(command) => {
            match resolve_matched_custom_command(&command, Some(&app)).await {
                Ok(Some(ResolvedCustomCommand::History(command))) => {
                    execute_history_translation(&command, Some(&app)).await
                }
                Ok(Some(ResolvedCustomCommand::Group(command))) => {
                    execute_typed_translation(&command, Some(&app))
                        .await
                        .map(|outcome| format_translation_reply(&outcome))
                }
                Ok(Some(ResolvedCustomCommand::Direct(body))) => deliver_proactive_direct(&body),
                Ok(None) => Err(RiotError::InvalidCommand(
                    "Saved custom command is invalid.".into(),
                )),
                Err(error) => Err(error),
            }
        }
        ComposerCommand::Dodge => execute_dodge(Some(&app)).await,
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

/// Leaves the current pre-game lobby via GLZ `POST /pregame/v1/matches/{id}/quit`.
pub async fn execute_dodge(app: Option<&AppHandle>) -> Result<String, RiotError> {
    let Some(app) = app else {
        return Err(RiotError::RiotClientNotRunning);
    };
    let Some(riot) = app.try_state::<crate::riot::client::RiotState>() else {
        return Err(RiotError::RiotClientNotRunning);
    };

    let result = crate::riot::api::with_api(&riot, |api| async move {
        let pre = match api.pregame_get_player(&api.puuid).await {
            Ok(pre) => pre,
            Err(error) => {
                return if is_not_in_game_error(&error) {
                    Ok(DodgeResult::NotInPregame)
                } else {
                    Err(error)
                };
            }
        };
        let Some(match_id) = pre
            .get("MatchID")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return Ok(DodgeResult::NotInPregame);
        };
        match api.pregame_quit(match_id).await {
            Ok(_) => Ok(DodgeResult::Left),
            Err(error) if is_not_in_game_error(&error) => Ok(DodgeResult::NotInPregame),
            Err(error) => Err(error),
        }
    })
    .await;

    match result {
        Ok(DodgeResult::Left) => Ok("Left agent select.".into()),
        Ok(DodgeResult::NotInPregame) => {
            Err(RiotError::InvalidCommand("Not in agent select.".into()))
        }
        Err(error) => Err(dodge_api_error(error)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DodgeResult {
    Left,
    NotInPregame,
}

fn dodge_api_error(error: String) -> RiotError {
    if crate::riot::client::is_login_required_error(&error) {
        RiotError::RiotClientNotRunning
    } else if is_not_in_game_error(&error) {
        RiotError::InvalidCommand("Not in agent select.".into())
    } else {
        RiotError::InvalidCommand("Could not leave agent select.".into())
    }
}

fn is_not_in_game_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("\"status\":404") || lower.contains("resource_not_found")
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
        match crate::translate::translate_text(
            &message.body,
            &config.provider,
            "auto",
            &parsed.language,
            &config.deepl_api_key,
        )
        .await
        {
            Ok(translated) => parts.push(format_history_translation_line(
                index + 1,
                &translated.source_language,
                &message.body,
                &translated.text,
            )),
            Err(_) => parts.push(format!("{}. Translation failed.", index + 1)),
        }
    }
    Ok(parts.join("\n"))
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

const WHISPER_LINE_LIMIT: usize = 80;
const WHISPER_PREVIEW_LIMIT: usize = 28;

fn format_history_translation_line(
    index: usize,
    source_language: &str,
    original: &str,
    translated: &str,
) -> String {
    let original = preview_history_line(original);
    let translated = preview_history_line(translated);
    let line = if source_language.is_empty() || source_language.eq_ignore_ascii_case("auto") {
        format!("{index}. {original} -> {translated}")
    } else {
        format!("{index}. [{source_language}] {original} -> {translated}")
    };
    preview_chars(&line, WHISPER_LINE_LIMIT)
}

fn preview_history_line(body: &str) -> String {
    preview_chars(
        &body.split_whitespace().collect::<Vec<_>>().join(" "),
        WHISPER_PREVIEW_LIMIT,
    )
}

fn preview_chars(value: &str, limit: usize) -> String {
    let compact = value.trim();
    if compact.chars().count() <= limit {
        return compact.to_string();
    }
    let take = limit.saturating_sub(3);
    let mut preview: String = compact.chars().take(take).collect();
    preview.push_str("...");
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
    let prepared = prepare_translation_command(client, parsed, config, app, None, true).await?;
    deliver_translated_line(
        client,
        prepared.outcome.channel,
        &prepared.rest_cid,
        &prepared.live_cid,
        &prepared.body,
        app,
    )
    .await?;

    Ok(prepared.outcome)
}

struct InternalPreparedTranslation {
    outcome: TranslationOutcome,
    rest_cid: String,
    live_cid: String,
    body: String,
}

async fn prepare_translation_command(
    client: &RiotChatClient,
    parsed: &TranslationCommand,
    config: &TranslatorConfig,
    app: Option<&AppHandle>,
    pinned_live_cid: Option<&str>,
    use_observed_room: bool,
) -> Result<InternalPreparedTranslation, RiotError> {
    let channel = effective_send_channel(parsed.channel);
    // Resolve and snapshot the destination before the external translation
    // request. The live relay already knows its joined MUC, so it deliberately
    // skips REST resolution when that pinned room matches the requested channel.
    let pinned_live_cid = pinned_live_cid.filter(|cid| channel.matches_cid(cid));
    let (rest_cid, live_cid) = if let Some(cid) = pinned_live_cid {
        (cid.to_string(), cid.to_string())
    } else {
        let rest_cid = resolve_send_cid(client, channel, app).await?;
        let live_cid = live_room_for_send(channel, &rest_cid, use_observed_room)
            .ok_or(RiotError::ChannelUnavailable { channel })?;
        (rest_cid, live_cid)
    };
    let (body, target_language) = if let Some(body) = no_translation_body(parsed) {
        (body.to_string(), "none".to_string())
    } else {
        let translated = crate::translate::translate_text(
            &parsed.message,
            &config.provider,
            "auto",
            &parsed.language,
            &config.deepl_api_key,
        )
        .await
        .map_err(RiotError::InvalidCommand)?;
        (translated.text, translated.target_language)
    };

    Ok(InternalPreparedTranslation {
        outcome: TranslationOutcome {
            channel,
            language: target_language,
            original: parsed.message.clone(),
            translated: body.clone(),
        },
        rest_cid,
        live_cid,
        body,
    })
}

fn no_translation_body(parsed: &TranslationCommand) -> Option<&str> {
    parsed
        .language
        .eq_ignore_ascii_case("none")
        .then_some(parsed.message.as_str())
}

fn effective_send_channel(channel: ChatChannel) -> ChatChannel {
    channel
}

fn party_live_room(rest_cid: &str, observed_cid: Option<&str>) -> Option<String> {
    observed_cid
        .filter(|observed| crate::riot::models::same_party_room(rest_cid, observed))
        .map(str::to_string)
}

fn party_room_for_send(
    rest_cid: &str,
    observed_cid: Option<&str>,
    require_observed: bool,
) -> Option<String> {
    party_live_room(rest_cid, observed_cid)
        .or_else(|| (!require_observed).then(|| crate::riot::models::party_xmpp_jid(rest_cid)))
}

fn match_live_room(rest_cid: &str, observed_cid: Option<&str>) -> Option<String> {
    observed_cid
        .filter(|observed| crate::riot::models::same_side_room(rest_cid, observed))
        .map(str::to_string)
}

fn match_room_for_send(
    rest_cid: &str,
    observed_cid: Option<&str>,
    require_observed: bool,
) -> Option<String> {
    match_live_room(rest_cid, observed_cid)
        .or_else(|| (!require_observed).then(|| crate::riot::models::game_xmpp_jid(rest_cid)))
}

fn live_room_for_send(
    channel: ChatChannel,
    rest_cid: &str,
    use_observed_room: bool,
) -> Option<String> {
    match channel {
        ChatChannel::Party => party_room_for_send(
            rest_cid,
            crate::presence_proxy::last_group_muc_jid(ChatChannel::Party).as_deref(),
            !use_observed_room,
        ),
        ChatChannel::Team => Some(rest_cid.to_string()),
        ChatChannel::Pregame => match_room_for_send(
            rest_cid,
            crate::presence_proxy::last_group_muc_jid(ChatChannel::Pregame).as_deref(),
            !use_observed_room,
        ),
        ChatChannel::All if use_observed_room => Some(inject_cid_for_send(channel, rest_cid)),
        ChatChannel::All => Some(rest_cid.to_string()),
    }
}

fn prefer_active_xmpp_room(channel: ChatChannel) -> bool {
    matches!(
        channel,
        ChatChannel::Party | ChatChannel::Team | ChatChannel::Pregame
    )
}

pub fn inject_cid_for_send(channel: ChatChannel, rest_cid: &str) -> String {
    crate::presence_proxy::last_group_muc_jid(channel).unwrap_or_else(|| rest_cid.to_string())
}

async fn deliver_translated_line(
    client: &RiotChatClient,
    channel: ChatChannel,
    rest_cid: &str,
    live_cid: &str,
    body: &str,
    app: Option<&AppHandle>,
) -> Result<(), RiotError> {
    let sent = if crate::presence_proxy::send_group_through_game(channel, live_cid, body) {
        true
    } else if client.send_to_cid(rest_cid, body).await.is_ok() {
        true
    } else {
        send_via_xmpp(app, channel, body).await?;
        true
    };
    if sent {
        if let Some(app) = app {
            emit_sent_chat_message(app, live_cid, body, channel);
        }
    }
    Ok(())
}

async fn resolve_send_cid(
    client: &RiotChatClient,
    channel: ChatChannel,
    app: Option<&AppHandle>,
) -> Result<String, RiotError> {
    if prefer_active_xmpp_room(channel) {
        if let Some(app) = app {
            if let Some(riot) = app.try_state::<crate::riot::client::RiotState>() {
                let active_room = match channel {
                    ChatChannel::Party => {
                        let (room, _) = crate::xmpp::ensure_party_xmpp_chat(&riot).await;
                        (!room.is_empty()).then_some(room)
                    }
                    ChatChannel::Team | ChatChannel::Pregame => {
                        crate::xmpp::ensure_match_xmpp_chat(&riot)
                            .await
                            .ok()
                            .and_then(|(team, _)| team)
                            .filter(|room| !room.is_empty())
                    }
                    _ => None,
                };
                if let Some(room) = active_room {
                    return Ok(room);
                }
            }
        }
    }
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
    lifecycle: LifecycleTracker,
    prepared_match_end: Option<PreparedMatchEnd>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedMatchEnd {
    match_id: String,
    language: String,
    body: String,
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

const LIVE_TRANSLATION_ECHO_TTL: std::time::Duration = std::time::Duration::from_secs(30);

fn live_translation_echoes(
) -> &'static std::sync::Mutex<VecDeque<(String, String, std::time::Instant)>> {
    static ECHOES: std::sync::OnceLock<
        std::sync::Mutex<VecDeque<(String, String, std::time::Instant)>>,
    > = std::sync::OnceLock::new();
    ECHOES.get_or_init(|| std::sync::Mutex::new(VecDeque::new()))
}

fn live_echo_cid_key(cid: &str) -> String {
    if ChatChannel::Party.matches_cid(cid) {
        crate::riot::models::party_xmpp_jid(cid).to_ascii_lowercase()
    } else {
        cid.to_ascii_lowercase()
    }
}

fn prune_live_translation_echoes(echoes: &mut VecDeque<(String, String, std::time::Instant)>) {
    while echoes
        .front()
        .is_some_and(|(_, _, created)| created.elapsed() >= LIVE_TRANSLATION_ECHO_TTL)
    {
        echoes.pop_front();
    }
}

pub(crate) fn record_live_translation_echo(cid: &str, body: &str) {
    if let Ok(mut echoes) = live_translation_echoes().lock() {
        prune_live_translation_echoes(&mut echoes);
        echoes.push_back((
            live_echo_cid_key(cid),
            normalize_echo(body),
            std::time::Instant::now(),
        ));
        while echoes.len() > PendingEchoes::CAPACITY {
            echoes.pop_front();
        }
    }
}

pub(crate) fn discard_live_translation_echo(cid: &str, body: &str) {
    if let Ok(mut echoes) = live_translation_echoes().lock() {
        prune_live_translation_echoes(&mut echoes);
        let wanted = (live_echo_cid_key(cid), normalize_echo(body));
        if let Some(index) = echoes.iter().position(|(entry_cid, entry_body, _)| {
            (entry_cid, entry_body) == (&wanted.0, &wanted.1)
        }) {
            echoes.remove(index);
        }
    }
}

fn consume_live_translation_echo(cid: &str, body: &str) -> bool {
    let wanted = (live_echo_cid_key(cid), normalize_echo(body));
    live_translation_echoes().lock().is_ok_and(|mut echoes| {
        prune_live_translation_echoes(&mut echoes);
        let Some(index) = echoes.iter().position(|(entry_cid, entry_body, _)| {
            (entry_cid, entry_body) == (&wanted.0, &wanted.1)
        }) else {
            return false;
        };
        echoes.remove(index);
        true
    })
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
    /// A saved `Send` command whose message may still contain templates.
    Custom(chat_command::CustomBotCommand),
    /// `.dodge` — leave agent select.
    Dodge,
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
    if chat_command::is_dodge_command(body) {
        return OwnMessage::Dodge;
    }
    // A custom trigger expands to a full command. Triggers whose action is
    // `tran` expand to `.tran ...`, which produces a text summary with nowhere
    // to show it in-game, so those stay a UI-only feature and fall through.
    match chat_command::find_custom_command(body, commands) {
        Some(command) if command.action.trim().eq_ignore_ascii_case("send") => {
            OwnMessage::Custom(command)
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
        let cid = match client.resolve_cid(channel).await {
            Ok(cid) => cid,
            Err(RiotError::ChannelUnavailable { .. }) => {
                memory.cids.remove(&channel);
                continue;
            }
            Err(error) => return Err(error),
        };

        // A changed CID means a new match or party. Priming below handles the
        // history; recording it here keeps the map honest for the next tick.
        memory.cids.insert(channel, cid.clone());

        let messages = match client.get_messages_for_cid(&cid, channel).await {
            Ok(messages) => messages,
            Err(
                RiotError::ChannelUnavailable { .. }
                | RiotError::StaleConversation { .. }
                | RiotError::ConversationNotFound,
            ) => {
                memory.cids.remove(&channel);
                continue;
            }
            Err(error) => return Err(error),
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

    let commands = load_custom_commands(Some(app));
    if commands
        .iter()
        .any(|command| command.when != chat_command::CustomCommandWhen::Command)
    {
        let observation = observe_lifecycle_phase(app).await?;
        let transitions = memory.lifecycle.observe(observation);
        process_lifecycle_transitions(app, memory, transitions).await;
    }

    Ok(())
}

fn player_match_id(payload: &Value) -> Option<String> {
    payload
        .get("MatchID")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|match_id| !match_id.is_empty())
        .map(str::to_string)
}

async fn observe_lifecycle_phase(app: &AppHandle) -> Result<PhaseObservation, RiotError> {
    let Some(riot) = app.try_state::<crate::riot::client::RiotState>() else {
        return Err(RiotError::RiotClientNotRunning);
    };
    let result = crate::riot::api::with_api(&riot, |api| async move {
        let match_id = match api.coregame_get_player(&api.puuid).await {
            Ok(payload) => player_match_id(&payload),
            Err(error) if is_not_in_game_error(&error) => None,
            Err(error) => return Err(error),
        };
        let pregame_id = if match_id.is_none() {
            match api.pregame_get_player(&api.puuid).await {
                Ok(payload) => player_match_id(&payload),
                Err(error) if is_not_in_game_error(&error) => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        Ok(phase_observation(pregame_id, match_id))
    })
    .await;

    match result {
        Ok(observation) => Ok(observation),
        Err(error) if crate::riot::client::is_login_required_error(&error) => {
            Err(RiotError::RiotClientNotRunning)
        }
        Err(_) => Err(RiotError::InvalidCommand(
            "Could not check the live game phase.".into(),
        )),
    }
}

fn phase_observation(pregame_id: Option<String>, match_id: Option<String>) -> PhaseObservation {
    PhaseObservation {
        connected: true,
        pregame_id,
        match_id,
    }
}

fn lifecycle_warning(app: &AppHandle, event: &str, error: impl std::fmt::Display) {
    let warning = format!("Dummy Bot {event} message skipped: {error}");
    log::warn!("{warning}");
    let _ = app.emit(EVENT_ERROR, warning);
}

async fn deliver_lifecycle_direct(app: &AppHandle, event: &str, language: &str, body: &str) {
    match resolve_direct_message(language, body, Some(app)).await {
        Ok(body) => {
            if let Err(error) = deliver_proactive_direct(&body) {
                lifecycle_warning(app, event, error);
            }
        }
        Err(error) => lifecycle_warning(app, event, error),
    }
}

fn take_prepared_match_end(memory: &mut PollMemory, match_id: &str) -> Option<PreparedMatchEnd> {
    if memory
        .prepared_match_end
        .as_ref()
        .map(|prepared| prepared.match_id.as_str())
        != Some(match_id)
    {
        return None;
    }
    memory.prepared_match_end.take()
}

async fn process_lifecycle_transitions(
    app: &AppHandle,
    memory: &mut PollMemory,
    transitions: Vec<LifecycleTransition>,
) {
    if transitions.is_empty() {
        return;
    }
    let commands = load_custom_commands(Some(app));
    for transition in transitions {
        match transition {
            LifecycleTransition::PregameStarted { .. } => {
                let Some(command) = chat_command::find_lifecycle_command(
                    &commands,
                    chat_command::CustomCommandWhen::OnPregame,
                ) else {
                    continue;
                };
                match super::bot_template::resolve_custom_messages(
                    app,
                    std::slice::from_ref(&command.message),
                )
                .await
                {
                    Ok(messages) => {
                        if let Some(body) = messages.first() {
                            deliver_lifecycle_direct(app, "onPregame", &command.language, body)
                                .await;
                        }
                    }
                    Err(error) => lifecycle_warning(app, "onPregame", error),
                }
            }
            LifecycleTransition::MatchStarted { match_id } => {
                memory.prepared_match_end = None;
                let start = chat_command::find_lifecycle_command(
                    &commands,
                    chat_command::CustomCommandWhen::OnMatchStart,
                );
                let end = chat_command::find_lifecycle_command(
                    &commands,
                    chat_command::CustomCommandWhen::OnMatchEnd,
                );
                let messages: Vec<String> = start
                    .iter()
                    .chain(end.iter())
                    .map(|command| command.message.clone())
                    .collect();
                if messages.is_empty() {
                    continue;
                }
                let resolved =
                    match super::bot_template::resolve_custom_messages(app, &messages).await {
                        Ok(resolved) => resolved,
                        Err(error) => {
                            lifecycle_warning(app, "onMatchStart", error);
                            continue;
                        }
                    };
                let mut resolved = resolved.into_iter();
                if let Some(command) = start {
                    if let Some(body) = resolved.next() {
                        deliver_lifecycle_direct(app, "onMatchStart", &command.language, &body)
                            .await;
                    }
                }
                if let Some(command) = end {
                    if let Some(body) = resolved.next() {
                        memory.prepared_match_end = Some(PreparedMatchEnd {
                            match_id,
                            language: command.language,
                            body,
                        });
                    }
                }
            }
            LifecycleTransition::MatchEnded { match_id } => {
                let Some(prepared) = take_prepared_match_end(memory, &match_id) else {
                    continue;
                };
                deliver_lifecycle_direct(app, "onMatchEnd", &prepared.language, &prepared.body)
                    .await;
            }
        }
    }
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
/// or `.dodge` command or a custom trigger. What keeps a translated reply from
/// being translated again is the echo list: the body the bot posts is recorded
/// on the way out and consumed when the poller reads it back.
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
        if consume_live_translation_echo(&message.cid, &message.body) {
            return;
        }
        let commands = load_custom_commands(Some(app));
        match plan_own_message(&message.body, &commands, &mut memory.echoes) {
            OwnMessage::Ignore => return,
            OwnMessage::Dodge => match execute_dodge(Some(app)).await {
                Ok(reply) => {
                    let _ = app.emit(EVENT_COMMAND, reply);
                }
                Err(error) => {
                    let _ = app.emit(EVENT_ERROR, error.to_string());
                }
            },
            OwnMessage::Translate(command) => {
                dispatch_translation_command(app, client, &command, memory).await;
            }
            OwnMessage::Custom(command) => {
                match resolve_matched_custom_command(&command, Some(app)).await {
                    Ok(Some(ResolvedCustomCommand::Group(command))) => {
                        dispatch_translation_command(app, client, &command, memory).await;
                    }
                    Ok(Some(ResolvedCustomCommand::Direct(body))) => {
                        match deliver_proactive_direct(&body) {
                            Ok(reply) => {
                                let _ = app.emit(EVENT_COMMAND, reply);
                            }
                            Err(error) => {
                                let _ = app.emit(EVENT_ERROR, error.to_string());
                            }
                        }
                    }
                    Ok(Some(ResolvedCustomCommand::History(_))) | Ok(None) => {
                        let _ = app.emit(EVENT_ERROR, "Saved custom command is invalid.");
                    }
                    Err(error) => {
                        let _ = app.emit(EVENT_ERROR, error.to_string());
                    }
                }
            }
        }
        return;
    }

    emit_polled_chat_message(app, message, false);
}

async fn dispatch_translation_command(
    app: &AppHandle,
    client: &RiotChatClient,
    command: &str,
    memory: &mut PollMemory,
) {
    let config = translator_config(app);
    match chat_command::parse_translation_command_with_fallback(
        command,
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
}

fn frontend_chat_message_json(
    conversation_id: &str,
    id: &str,
    sender: &str,
    sender_name: &str,
    body: &str,
    timestamp: &str,
    channel: ChatChannel,
    is_self: bool,
) -> Value {
    let (msg_type, scope) = match channel {
        ChatChannel::Party => ("groupchat", "party"),
        ChatChannel::Pregame | ChatChannel::Team | ChatChannel::All => ("groupchat", "match"),
    };
    json!({
        "id": id,
        "conversationId": conversation_id,
        "sender": sender,
        "senderName": sender_name,
        "body": body,
        "timestamp": timestamp,
        "type": msg_type,
        "scope": scope,
        "isSelf": is_self,
    })
}

fn emit_ui_chat_message(app: &AppHandle, payload: &Value) {
    if let Ok(text) = serde_json::to_string(payload) {
        let _ = app.emit("chat:message", text);
    }
}

fn emit_polled_chat_message(app: &AppHandle, message: &ChatMessage, is_self: bool) {
    let sender_name = if message.sender_tag.is_empty() {
        message.sender_name.clone()
    } else {
        format!("{}#{}", message.sender_name, message.sender_tag)
    };
    let payload = frontend_chat_message_json(
        &message.cid,
        &message.key,
        &message.sender_puuid,
        &sender_name,
        &message.body,
        &message.timestamp,
        message.channel,
        is_self,
    );
    emit_ui_chat_message(app, &payload);
    let _ = app.emit(EVENT_MESSAGE, message.clone());
}

fn emit_sent_chat_message(
    app: &AppHandle,
    conversation_id: &str,
    body: &str,
    channel: ChatChannel,
) {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let payload = frontend_chat_message_json(
        conversation_id,
        &format!("sent:{conversation_id}:{millis}"),
        "",
        "",
        body,
        &millis.to_string(),
        channel,
        true,
    );
    emit_ui_chat_message(app, &payload);
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

    fn direct_custom_command(language: &str, message: &str) -> chat_command::CustomBotCommand {
        chat_command::CustomBotCommand {
            when: chat_command::CustomCommandWhen::Command,
            trigger: "dm".into(),
            action: "send".into(),
            channel: "direct".into(),
            language: language.into(),
            message: message.into(),
            count: 0,
        }
    }

    #[tokio::test]
    async fn direct_language_none_preserves_the_resolved_message() {
        let resolved =
            resolve_matched_custom_command(&direct_custom_command("none", "hello exactly"), None)
                .await
                .unwrap()
                .unwrap();

        assert_eq!(
            resolved,
            ResolvedCustomCommand::Direct("hello exactly".into())
        );
    }

    #[test]
    fn translated_direct_requests_use_auto_source_and_configured_provider() {
        let config = TranslatorConfig {
            provider: "google".into(),
            deepl_api_key: "secret".into(),
            target_language: "en".into(),
        };
        let request = direct_translation_request("french", "hello", &config)
            .unwrap()
            .unwrap();

        assert_eq!(request.provider, "google");
        assert_eq!(request.source_language, "auto");
        assert_eq!(request.target_language, "fr");
        assert_eq!(request.message, "hello");
        assert_eq!(request.deepl_api_key, "secret");
    }

    #[test]
    fn proactive_direct_returns_confirmation_after_one_delivery() {
        let mut deliveries = 0;
        let reply = deliver_proactive_direct_with("hello", |body| {
            deliveries += 1;
            assert_eq!(body, "hello");
            Ok(())
        })
        .unwrap();

        assert_eq!(deliveries, 1);
        assert_eq!(reply, "Dummy Bot sent you a direct message.");
    }

    #[test]
    fn proactive_direct_surfaces_an_absent_relay() {
        let error = deliver_proactive_direct_with("hello", |_| {
            Err("Dummy Bot direct messages require an active Riot relay connection.".into())
        })
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "Dummy Bot direct messages require an active Riot relay connection."
        );
    }

    #[test]
    fn a_direct_command_from_the_bot_whisper_path_is_only_a_source_reply() {
        assert_eq!(
            deliver_source_reply_direct("reply once".into()),
            "reply once"
        );
    }

    #[test]
    fn lifecycle_observation_uses_glz_player_state() {
        assert_eq!(
            phase_observation(Some("glz-pregame-a".into()), Some("glz-match-a".into())),
            PhaseObservation {
                connected: true,
                pregame_id: Some("glz-pregame-a".into()),
                match_id: Some("glz-match-a".into()),
            }
        );
    }

    #[test]
    fn player_match_id_requires_a_non_empty_match_id() {
        assert_eq!(
            player_match_id(&json!({ "MatchID": "  pregame-a  " })),
            Some("pregame-a".into())
        );
        assert_eq!(player_match_id(&json!({ "MatchID": "  " })), None);
        assert_eq!(player_match_id(&json!({})), None);
    }

    #[test]
    fn prepared_match_end_keeps_start_snapshot_and_is_consumed_once() {
        let mut memory = PollMemory {
            prepared_match_end: Some(PreparedMatchEnd {
                match_id: "match-a".into(),
                language: "none".into(),
                body: "Start map was Ascent with 10 players".into(),
            }),
            ..PollMemory::default()
        };

        assert_eq!(take_prepared_match_end(&mut memory, "match-b"), None);
        assert!(memory.prepared_match_end.is_some());
        assert_eq!(
            take_prepared_match_end(&mut memory, "match-a"),
            Some(PreparedMatchEnd {
                match_id: "match-a".into(),
                language: "none".into(),
                body: "Start map was Ascent with 10 players".into(),
            })
        );
        assert_eq!(take_prepared_match_end(&mut memory, "match-a"), None);
    }

    fn custom_commands() -> Vec<chat_command::CustomBotCommand> {
        vec![
            chat_command::CustomBotCommand {
                when: chat_command::CustomCommandWhen::Command,
                trigger: "gg".into(),
                action: "send".into(),
                channel: "team".into(),
                language: "french".into(),
                message: "good game".into(),
                count: 0,
            },
            chat_command::CustomBotCommand {
                when: chat_command::CustomCommandWhen::Command,
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
            OwnMessage::Custom(commands[0].clone())
        );
        // The dotted spelling keeps working.
        assert_eq!(
            plan_own_message(".gg", &commands, &mut echoes),
            OwnMessage::Custom(commands[0].clone())
        );
        // As does a literal command.
        assert_eq!(
            plan_own_message(".send all french push a", &commands, &mut echoes),
            OwnMessage::Translate(".send all french push a".into())
        );
        assert_eq!(
            plan_own_message(".dodge", &commands, &mut echoes),
            OwnMessage::Dodge
        );
    }

    #[test]
    fn in_game_custom_send_keeps_its_template_until_execution() {
        let mut echoes = PendingEchoes::default();
        let command = chat_command::CustomBotCommand {
            when: chat_command::CustomCommandWhen::Command,
            trigger: "scout".into(),
            action: "send".into(),
            channel: "team".into(),
            language: "none".into(),
            message: "Enemy KDA: {{enemy_team_kda}}".into(),
            count: 0,
        };

        assert_eq!(
            plan_own_message("scout", &[command.clone()], &mut echoes),
            OwnMessage::Custom(command)
        );
    }

    #[test]
    fn polled_messages_are_shaped_for_the_chat_ui() {
        let payload = frontend_chat_message_json(
            "blue@ares-coregame.ap",
            "msg-1",
            "player-1",
            "Name#TAG",
            "hello",
            "123",
            ChatChannel::Team,
            false,
        );
        assert_eq!(payload["id"], "msg-1");
        assert_eq!(payload["conversationId"], "blue@ares-coregame.ap");
        assert_eq!(payload["sender"], "player-1");
        assert_eq!(payload["senderName"], "Name#TAG");
        assert_eq!(payload["body"], "hello");
        assert_eq!(payload["type"], "groupchat");
        assert_eq!(payload["scope"], "match");
        assert_eq!(payload["isSelf"], false);

        let party = frontend_chat_message_json(
            "p@ares-parties.ap",
            "m2",
            "s",
            "n",
            "hi",
            "1",
            ChatChannel::Party,
            true,
        );
        assert_eq!(party["scope"], "party");
        assert_eq!(party["isSelf"], true);
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
            when: chat_command::CustomCommandWhen::Command,
            trigger: "gg".into(),
            action: "send".into(),
            channel: "team".into(),
            language: "french".into(),
            message: "gg wp".into(),
            count: 0,
        }];

        assert!(matches!(
            plan_own_message("gg", &commands, &mut echoes),
            OwnMessage::Custom(_)
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
        assert_eq!(
            plan_own_message("gg", &commands, &mut echoes),
            OwnMessage::Ignore
        );
        assert!(
            matches!(
                plan_own_message("gg", &commands, &mut echoes),
                OwnMessage::Custom(_)
            ),
            "a single echo must not mute the trigger for the rest of the session"
        );
    }

    #[test]
    fn a_live_relay_echo_cannot_execute_the_same_command_twice() {
        let cid = "relay-all@ares-coregame.ap1.pvp.net";
        let body = ".send all french relay-echo-unique";

        record_live_translation_echo(cid, body);
        assert!(!consume_live_translation_echo(
            "different-all@ares-coregame.ap1.pvp.net",
            body
        ));
        assert!(consume_live_translation_echo(cid, body));
        assert!(!consume_live_translation_echo(cid, body));

        record_live_translation_echo("party-1@ares-parties.ap", body);
        assert!(consume_live_translation_echo(
            "party-1@ares-parties.ap1.pvp.net",
            body
        ));
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
        assert_eq!(
            classify_composer_command(".dodge", &commands),
            ComposerCommand::Dodge
        );
        assert_eq!(
            classify_composer_command("  .DODGE", &commands),
            ComposerCommand::Dodge
        );
    }

    #[test]
    fn the_composer_expands_a_dotted_custom_trigger() {
        let commands = custom_commands();
        assert_eq!(
            classify_composer_command(".gg", &commands),
            ComposerCommand::Custom(commands[0].clone())
        );
        // A `tran` trigger has somewhere to print here, unlike in-game.
        assert_eq!(
            classify_composer_command(".last", &commands),
            ComposerCommand::History(".tran team 3".into())
        );
    }

    #[test]
    fn the_composer_keeps_custom_send_templates_until_execution() {
        let command = chat_command::CustomBotCommand {
            when: chat_command::CustomCommandWhen::Command,
            trigger: "scout".into(),
            action: "send".into(),
            channel: "team".into(),
            language: "none".into(),
            message: "Enemy KDA: {{enemy_team_kda}}".into(),
            count: 0,
        };

        assert_eq!(
            classify_composer_command(".scout", &[command.clone()]),
            ComposerCommand::Custom(command)
        );
    }

    #[test]
    fn a_bare_word_is_never_a_command_in_the_composer() {
        // In-game a bare trigger fires. Here it must not, or the player could
        // never send "gg" as an ordinary message.
        let commands = custom_commands();
        assert_eq!(
            classify_composer_command("gg", &commands),
            ComposerCommand::Unknown
        );
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
        assert_eq!(
            classify_composer_command(".", &commands),
            ComposerCommand::Unknown
        );
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
        assert!(history_channel_matches(None, "abc@ares-parties.ap"));
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
    fn inject_uses_the_room_the_game_already_spoke_in() {
        crate::presence_proxy::record_group_muc_from_stanza(
            r#"<message to="9f2e-blue@ares-coregame.ap1.pvp.net" type="groupchat"><body>lol</body></message>"#,
        );
        crate::presence_proxy::record_group_muc_from_stanza(
            r#"<presence to="live@ares-parties.ap1.pvp.net/me"/>"#,
        );
        assert_eq!(
            inject_cid_for_send(ChatChannel::Team, "9f2e-red@ares-coregame.ap1.pvp.net"),
            "9f2e-blue@ares-coregame.ap1.pvp.net"
        );
        assert_eq!(
            inject_cid_for_send(ChatChannel::Party, "other@ares-parties.ap1.pvp.net"),
            "live@ares-parties.ap1.pvp.net"
        );
        assert_eq!(
            inject_cid_for_send(ChatChannel::All, "m-all@ares-coregame.ap1.pvp.net"),
            "m-all@ares-coregame.ap1.pvp.net"
        );
    }

    #[test]
    fn party_live_room_accepts_the_current_room_in_either_cid_spelling() {
        let current = "party-1@ares-parties.ap1.pvp.net";

        assert_eq!(
            party_live_room(current, Some("party-1@ares-parties.ap")).as_deref(),
            Some("party-1@ares-parties.ap")
        );
        assert_eq!(
            party_live_room(current, Some("party-1@ares-parties.ap1.pvp.net")).as_deref(),
            Some("party-1@ares-parties.ap1.pvp.net")
        );
    }

    #[test]
    fn pregame_404s_are_not_in_agent_select() {
        assert!(is_not_in_game_error(
            r#"{"status":404,"path":"/pregame/v1/players/abc","message":"RESOURCE_NOT_FOUND"}"#
        ));
        assert!(!is_not_in_game_error(
            r#"{"status":403,"path":"/pregame/v1/matches/abc/quit","message":"FORBIDDEN"}"#
        ));
        assert_eq!(
            dodge_api_error("Riot Client is not running.".into()).to_string(),
            "Riot Client is not running."
        );
        assert_eq!(
            dodge_api_error(r#"{"status":500,"path":"/pregame/v1/matches/abc/quit"}"#.into())
                .to_string(),
            "Could not leave agent select."
        );
    }

    #[test]
    fn party_live_room_rejects_a_stale_party() {
        assert_eq!(
            party_live_room(
                "party-current@ares-parties.ap1.pvp.net",
                Some("party-old@ares-parties.ap")
            ),
            None
        );
    }

    #[test]
    fn ordinary_party_send_can_fall_back_to_the_active_resolved_room() {
        assert_eq!(
            party_room_for_send("party-1@ares-parties.ap1.pvp.net", None, false).as_deref(),
            Some("party-1@ares-parties.ap")
        );
        assert_eq!(
            party_room_for_send(
                "party-1@ares-parties.ap1.pvp.net",
                Some("party-old@ares-parties.ap"),
                true,
            ),
            None,
            "a game-socket send must not fall back to a room it has not joined"
        );
    }

    #[test]
    fn active_team_resolution_is_not_overwritten_by_a_stale_coregame_room() {
        crate::presence_proxy::record_group_muc_from_stanza(
            r#"<presence to="old-blue@ares-coregame.ap1.pvp.net/me"/>"#,
        );
        assert_eq!(
            live_room_for_send(
                ChatChannel::Team,
                "current-blue@ares-pregame.ap1.pvp.net",
                true,
            )
            .as_deref(),
            Some("current-blue@ares-pregame.ap1.pvp.net")
        );
    }

    #[test]
    fn pregame_send_stays_on_the_pregame_room() {
        assert_eq!(
            effective_send_channel(ChatChannel::Pregame),
            ChatChannel::Pregame
        );
        assert!(prefer_active_xmpp_room(ChatChannel::Pregame));
        assert_eq!(
            live_room_for_send(
                ChatChannel::Pregame,
                "m-blue@ares-pregame.ap1.pvp.net",
                true,
            )
            .as_deref(),
            Some("m-blue@ares-pregame.ap")
        );
        let payload = frontend_chat_message_json(
            "m-blue@ares-pregame.ap",
            "msg-1",
            "player-1",
            "Name#TAG",
            "hello",
            "123",
            ChatChannel::Pregame,
            false,
        );
        assert_eq!(payload["scope"], "match");
        assert_eq!(payload["type"], "groupchat");
    }

    #[test]
    fn live_party_and_team_prefer_the_active_xmpp_room() {
        assert!(prefer_active_xmpp_room(ChatChannel::Party));
        assert!(prefer_active_xmpp_room(ChatChannel::Team));
        assert!(prefer_active_xmpp_room(ChatChannel::Pregame));
        assert!(!prefer_active_xmpp_room(ChatChannel::All));
    }

    #[test]
    fn history_translation_line_shows_the_original_language_code() {
        assert_eq!(
            format_history_translation_line(1, "ko", "gl hf", "잘 부탁해"),
            "1. [ko] gl hf -> 잘 부탁해"
        );
        assert_eq!(
            format_history_translation_line(2, "auto", "hello", "你好"),
            "2. hello -> 你好"
        );
    }

    #[test]
    fn history_translation_lines_fit_valorant_whispers() {
        let long = "alpha ".repeat(40);
        let line = format_history_translation_line(1, "en", &long, &long);
        assert!(
            line.chars().count() <= 80,
            "line too long for Valorant HUD: {line:?} ({} chars)",
            line.chars().count()
        );
        assert!(!line.contains('·'));
        assert!(!line.contains('→'));
        let reply = ["1. hi -> 안녕", "2. gg -> 잘가"].join("\n");
        assert!(!reply.contains('·'));
        assert_eq!(reply.lines().count(), 2);
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
    fn none_language_uses_the_original_message_without_translation() {
        let parsed = TranslationCommand {
            channel: ChatChannel::All,
            language: "none".into(),
            language_input: "none".into(),
            message: "keep this exact text".into(),
        };

        assert_eq!(no_translation_body(&parsed), Some("keep this exact text"));
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
