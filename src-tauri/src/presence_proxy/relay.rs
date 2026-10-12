use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex as AsyncMutex};
#[cfg(not(test))]
use tokio_native_tls::TlsAcceptor;
#[cfg(test)]
use tokio_rustls::TlsAcceptor;
use tokio_rustls::TlsConnector;

use crate::commands::riot_chat::ResolvedCustomCommand;
use crate::presence_proxy::xml::{
    bot_command_frames, bot_message_body, bot_presence, bot_reply, inject_bot_roster,
    is_global_presence, is_muc_presence, parse_bot_message, rewrite_presence, BotCommand,
    XmppFramer,
};
use crate::presence_proxy::{BotDirectMessage, MaskingState};

const LIVE_TRANSLATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

struct RelayRuntime {
    handle: tauri::async_runtime::JoinHandle<()>,
    port: u16,
}

fn runtime() -> &'static Mutex<Option<RelayRuntime>> {
    static RUNTIME: OnceLock<Mutex<Option<RelayRuntime>>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(None))
}

fn start_lock() -> &'static AsyncMutex<()> {
    static START_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    START_LOCK.get_or_init(|| AsyncMutex::new(()))
}

pub async fn start() -> Result<u16, String> {
    let _start_guard = start_lock().lock().await;
    if let Some(active) = runtime().lock().unwrap().as_ref() {
        return Ok(active.port);
    }
    let acceptor = local_acceptor().await?;
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| format!("Could not bind the XMPP relay: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let handle = tauri::async_runtime::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((socket, _)) = accepted else { break };
                    let acceptor = acceptor.clone();
                    connections.spawn(async move {
                        if let Err(error) = handle_socket(socket, acceptor).await {
                            crate::presence_proxy::controller().set_warning(Some(error));
                        }
                    });
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
    });
    *runtime().lock().unwrap() = Some(RelayRuntime { handle, port });
    crate::presence_proxy::controller().set_relay_port(Some(port));
    Ok(port)
}

#[cfg(not(test))]
async fn local_acceptor() -> Result<TlsAcceptor, String> {
    crate::presence_proxy::local_ca::load_acceptor(crate::presence_proxy::controller().cert()).await
}

#[cfg(test)]
async fn local_acceptor() -> Result<TlsAcceptor, String> {
    crate::presence_proxy::local_ca::generate_test_acceptor()
}

fn build_connector() -> Result<TlsConnector, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| error.to_string())?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

#[cfg(not(test))]
type LocalTls = tokio_native_tls::TlsStream<TcpStream>;
#[cfg(test)]
type LocalTls = tokio_rustls::server::TlsStream<TcpStream>;
type RemoteTls = tokio_rustls::client::TlsStream<TcpStream>;

async fn handle_socket(socket: TcpStream, acceptor: TlsAcceptor) -> Result<(), String> {
    let local = acceptor
        .accept(socket)
        .await
        .map_err(|error| format!("Local XMPP TLS failed: {error}"))?;
    let target = crate::presence_proxy::controller()
        .upstream()
        .ok_or_else(|| {
            "Riot chat target is not ready. Wait for client-config to load.".to_string()
        })?;
    let tcp = TcpStream::connect((target.host.as_str(), target.port))
        .await
        .map_err(|error| format!("Riot chat connection failed: {error}"))?;
    let server_name = rustls::pki_types::ServerName::try_from(target.host.clone())
        .map_err(|error| format!("Invalid Riot chat host: {error}"))?;
    let remote = build_connector()?
        .connect(server_name, tcp)
        .await
        .map_err(|error| format!("Riot chat TLS failed: {error}"))?;

    let domain = account_domain_for_target(&target);
    let (local_read, local_write) = tokio::io::split(local);
    let (remote_read, remote_write) = tokio::io::split(remote);
    let local_write = Arc::new(AsyncMutex::new(local_write));
    let remote_write = Arc::new(AsyncMutex::new(remote_write));
    let bot_inserted = Arc::new(AtomicBool::new(false));
    let welcome_sent = Arc::new(AtomicBool::new(false));
    let bot_version = Arc::new(AsyncMutex::new(None));

    crate::presence_proxy::controller().connection_opened();
    let warning = crate::presence_proxy::controller().snapshot().last_warning;
    if !warning
        .as_deref()
        .is_some_and(|value| value.starts_with("Could not refresh the XMPP certificate"))
    {
        crate::presence_proxy::controller().set_warning(None);
    }
    let (gui_connection, gui_packets) = super::gui_chat_hub().register();
    let client_loop = client_to_remote(
        local_read,
        local_write.clone(),
        remote_write.clone(),
        &domain,
        bot_inserted.clone(),
        welcome_sent.clone(),
        bot_version.clone(),
        gui_connection.id,
        gui_packets,
    );
    let server_loop = remote_to_client(
        remote_read,
        local_write.clone(),
        &domain,
        bot_inserted,
        welcome_sent,
        bot_version,
        gui_connection.id,
    );
    tokio::pin!(client_loop);
    tokio::pin!(server_loop);
    let result = tokio::select! {
        result = &mut client_loop => result,
        result = &mut server_loop => result,
    };
    crate::presence_proxy::controller().connection_closed();
    let _ = local_write.lock().await.shutdown().await;
    let _ = remote_write.lock().await.shutdown().await;
    result
}

async fn client_to_remote(
    mut read: ReadHalf<LocalTls>,
    local_write: Arc<AsyncMutex<WriteHalf<LocalTls>>>,
    remote_write: Arc<AsyncMutex<WriteHalf<RemoteTls>>>,
    account_domain: &str,
    bot_inserted: Arc<AtomicBool>,
    welcome_sent: Arc<AtomicBool>,
    bot_version: Arc<AsyncMutex<Option<String>>>,
    gui_connection: u64,
    mut gui_packets: mpsc::Receiver<super::gui_chat::Packet>,
) -> Result<(), String> {
    let mut framer = XmppFramer::new(256 * 1024);
    let mut buffer = vec![0u8; 16 * 1024];
    let mut last_presence: Option<String> = None;
    let mut states = crate::presence_proxy::controller().subscribe_state();
    let mut outbound = crate::presence_proxy::subscribe_outbound();
    let mut bot_direct = crate::presence_proxy::subscribe_bot_direct();
    let mut reply_sequence = 0u64;

    loop {
        tokio::select! {
            Some(packet) = gui_packets.recv() => {
                if super::gui_chat_hub().is_pending(&packet.id) {
                    write_frame(&remote_write, packet.stanza.as_bytes()).await?;
                }
            }
            direct_result = bot_direct.recv() => {
                match direct_result {
                    Ok(message) => {
                        let version = bot_version.lock().await.clone();
                        for frame in direct_message_frames(
                            account_domain,
                            version.as_deref(),
                            &message,
                        ) {
                            write_frame(&local_write, frame.as_bytes()).await?;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        log::warn!(
                            "Dummy Bot direct relay lagged; skipped {skipped} message(s)"
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err("Dummy Bot direct relay closed unexpectedly.".into());
                    }
                }
            }
            inject = outbound.recv() => {
                if let Ok(stanza) = inject {
                    write_frame(&remote_write, stanza.as_bytes()).await?;
                }
            }
            read_result = read.read(&mut buffer) => {
                let count = read_result.map_err(|error| error.to_string())?;
                if count == 0 { return Ok(()); }
                let frames = framer.push(&buffer[..count]).map_err(|_| "Client XMPP stanza exceeded 256 KiB".to_string())?;
                for frame in frames {
                    let Ok(stanza) = std::str::from_utf8(&frame) else {
                        write_frame(&remote_write, &frame).await?;
                        continue;
                    };
                    crate::presence_proxy::record_live_chat(stanza);
                    // Commands typed in a group room never reach it and never
                    // run: they only work when whispered to the Dummy Bot.
                    if let Some(body) = outgoing_group_command(stanza) {
                        let hint = crate::riot::chat_command::group_command_hint(&body);
                        if let Err(error) = crate::presence_proxy::send_bot_direct(&hint) {
                            log::warn!("Group command hint could not be delivered: {error:?}");
                        }
                        continue;
                    }
                    if stanza.to_ascii_lowercase().contains(crate::fake_player::PUUID) {
                        if let Some((bot_jid, command)) = parse_bot_message(stanza).map_err(|error| format!("Bot command parse failed: {error}"))? {
                            if command != BotCommand::Consume {
                                reply_sequence += 1;
                                let body = bot_message_body(stanza).unwrap_or_default();
                                crate::fake_player::record_message(&body, true);
                                let reply = if command == BotCommand::Translate {
                                    translate_bot_command_on_connection(&body, &remote_write).await
                                } else if command == BotCommand::TranslateHistory {
                                    match crate::commands::riot_chat::execute_history_translation(
                                        &body,
                                        crate::presence_proxy::app_handle(),
                                    )
                                    .await
                                    {
                                        Ok(reply) => reply,
                                        Err(error) => error.to_string(),
                                    }
                                } else if command == BotCommand::Ascii {
                                    ascii_command_on_connection(&body, &remote_write).await
                                } else if command == BotCommand::Ai || command == BotCommand::Ask {
                                    ai_command_on_connection(&body, &remote_write).await
                                } else if command == BotCommand::Dodge {
                                    match crate::commands::riot_chat::execute_dodge(
                                        crate::presence_proxy::app_handle(),
                                    )
                                    .await
                                    {
                                        Ok(reply) => reply,
                                        Err(error) => error.to_string(),
                                    }
                                } else {
                                    match crate::commands::riot_chat::resolve_custom_command_for_bot(
                                        &body,
                                        crate::presence_proxy::app_handle(),
                                    )
                                    .await
                                    {
                                        Ok(Some(ResolvedCustomCommand::History(expanded))) => {
                                            match crate::commands::riot_chat::execute_history_translation(
                                                &expanded,
                                                crate::presence_proxy::app_handle(),
                                            )
                                            .await
                                            {
                                                Ok(reply) => reply,
                                                Err(error) => error.to_string(),
                                            }
                                        }
                                        Ok(Some(ResolvedCustomCommand::Group(expanded))) => {
                                            translate_bot_command_on_connection(
                                                &expanded,
                                                &remote_write,
                                            )
                                            .await
                                        }
                                        Ok(Some(ResolvedCustomCommand::Direct(reply))) => reply,
                                        Ok(None) => crate::presence_proxy::apply_command(
                                            crate::fake_player::parse_command(&body),
                                        ),
                                        Err(error) => error.to_string(),
                                    }
                                };
                                crate::fake_player::record_message(&reply, false);
                                let version = bot_version.lock().await.clone();
                                for client_frame in bot_command_frames(
                                    account_domain,
                                    version.as_deref(),
                                    &bot_jid,
                                    &reply,
                                    reply_sequence,
                                ) {
                                    write_frame(&local_write, client_frame.as_bytes()).await?;
                                }
                            }
                            continue;
                        }
                    }
                    let state = crate::presence_proxy::controller().state();
                    if is_muc_presence(stanza) && !state.connect_to_muc {
                        continue;
                    }
                    if is_global_presence(stanza) {
                        if let Some(state) =
                            crate::presence_proxy::xml::extract_presence_match_state(stanza)
                        {
                            crate::presence_proxy::record_presence_match_state(state);
                        }
                        if let Some(version) = crate::presence_proxy::xml::extract_valorant_version(stanza) {
                            let mut current = bot_version.lock().await;
                            if current.as_deref() != Some(version.as_str()) {
                                *current = Some(version.clone());
                                if bot_inserted.load(Ordering::Acquire) {
                                    write_frame(
                                        &local_write,
                                        bot_presence(account_domain, Some(&version)).as_bytes(),
                                    )
                                    .await?;
                                    if welcome_sent
                                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                                        .is_ok()
                                    {
                                        let welcome = crate::fake_player::help_text();
                                        crate::fake_player::record_message(welcome, false);
                                        let bot_jid = format!("{}@{account_domain}", crate::fake_player::PUUID);
                                        write_frame(
                                            &local_write,
                                            bot_reply(&bot_jid, welcome, 0).as_bytes(),
                                        )
                                        .await?;
                                    }
                                }
                            }
                        }
                        last_presence = Some(stanza.to_string());
                        crate::presence_proxy::controller().capture_presence(stanza.to_string());
                        let rewritten = presence_for_state(stanza, state)
                            .map_err(|error| format!("Presence rewrite failed: {error}"))?
                            .unwrap_or_else(|| stanza.to_string());
                        super::gui_chat_hub().outgoing(gui_connection, stanza);
                        write_frame(&remote_write, rewritten.as_bytes()).await?;
                    } else {
                        super::gui_chat_hub().outgoing(gui_connection, stanza);
                        write_frame(&remote_write, &frame).await?;
                    }
                }
            }
            state_result = states.recv() => {
                let state = state_result.map_err(|error| error.to_string())?;
                if let Some(stanza) = last_presence.as_deref() {
                    let rewritten = presence_for_state(stanza, state)
                        .map_err(|error| format!("Presence rewrite failed: {error}"))?
                        .unwrap_or_else(|| stanza.to_string());
                    write_frame(&remote_write, rewritten.as_bytes()).await?;
                }
            }
        }
    }
}

fn direct_message_frames(
    account_domain: &str,
    version: Option<&str>,
    message: &BotDirectMessage,
) -> Vec<String> {
    let bot_jid = format!("{}@{account_domain}", crate::fake_player::PUUID);
    bot_command_frames(
        account_domain,
        version,
        &bot_jid,
        &message.body,
        message.sequence,
    )
}

async fn translate_bot_command_on_connection(
    command: &str,
    remote_write: &Arc<AsyncMutex<WriteHalf<RemoteTls>>>,
) -> String {
    let prepared = match tokio::time::timeout(
        LIVE_TRANSLATION_TIMEOUT,
        crate::commands::riot_chat::prepare_typed_translation(
            command,
            crate::presence_proxy::app_handle(),
            None,
        ),
    )
    .await
    {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(error)) => return error.to_string(),
        Err(_) => return "Translation timed out. Please try again.".to_string(),
    };

    let stanza = crate::presence_proxy::game_groupchat_stanza(&prepared.live_cid, &prepared.body);
    if let Err(error) = write_frame(remote_write, stanza.as_bytes()).await {
        return format!("Could not send translated message: {error}");
    }

    prepared.reply
}

/// Runs `.ascii` from a whisper or a group room.
///
/// Like `.ai`, the artwork is private by default: without a channel it is
/// returned for a DM. With one it mirrors [`translate_bot_command_on_connection`]:
/// render and resolve first, then write the artwork on this connection so it
/// leaves as an ordinary game message. Nothing is written when it is invalid.
async fn ascii_command_on_connection(
    command: &str,
    remote_write: &Arc<AsyncMutex<WriteHalf<RemoteTls>>>,
) -> String {
    let parsed = match crate::riot::ascii_art::parse_ascii_command(command) {
        Ok(parsed) => parsed,
        Err(error) => return error.to_string(),
    };
    let Some(channel) = parsed.channel else {
        return parsed.payload;
    };
    let prepared = match tokio::time::timeout(
        LIVE_TRANSLATION_TIMEOUT,
        crate::commands::riot_chat::prepare_ascii_for_bot(
            channel,
            parsed.payload,
            crate::presence_proxy::app_handle(),
        ),
    )
    .await
    {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(error)) => return error.to_string(),
        Err(_) => return "ASCII art timed out. Please try again.".to_string(),
    };

    let stanza = crate::presence_proxy::game_groupchat_stanza(&prepared.live_cid, &prepared.body);
    if let Err(error) = write_frame(remote_write, stanza.as_bytes()).await {
        return format!("Could not send ASCII art: {error}");
    }

    prepared.reply
}

/// Runs `.ai` / `.ask` from a whisper or a group room. The answer is private
/// (returned for a DM) unless `.ai` names a room, in which case the line is
/// posted on this connection like a whispered `.ascii`.
async fn ai_command_on_connection(
    command: &str,
    remote_write: &Arc<AsyncMutex<WriteHalf<RemoteTls>>>,
) -> String {
    if !crate::commands::riot_chat::ai_posts_to_room(command) {
        return match crate::commands::riot_chat::ai_command_reply(command).await {
            Ok(answer) => answer,
            Err(error) => error.to_string(),
        };
    }
    let prepared = match crate::commands::riot_chat::prepare_ai_for_bot(
        command,
        crate::presence_proxy::app_handle(),
    )
    .await
    {
        Ok(prepared) => prepared,
        Err(error) => return error.to_string(),
    };

    let stanza = crate::presence_proxy::game_groupchat_stanza(&prepared.live_cid, &prepared.body);
    if let Err(error) = write_frame(remote_write, stanza.as_bytes()).await {
        return format!("Could not send AI message: {error}");
    }

    prepared.reply
}

async fn remote_to_client(
    mut read: ReadHalf<RemoteTls>,
    local_write: Arc<AsyncMutex<WriteHalf<LocalTls>>>,
    account_domain: &str,
    bot_inserted: Arc<AtomicBool>,
    welcome_sent: Arc<AtomicBool>,
    bot_version: Arc<AsyncMutex<Option<String>>>,
    gui_connection: u64,
) -> Result<(), String> {
    let mut framer = XmppFramer::new(256 * 1024);
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let count = read
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(());
        }
        for frame in framer
            .push(&buffer[..count])
            .map_err(|_| "Server XMPP stanza exceeded 256 KiB".to_string())?
        {
            if !bot_inserted.load(Ordering::Acquire) {
                if let Ok(stanza) = std::str::from_utf8(&frame) {
                    if let Some(patched) = inject_bot_roster(stanza, account_domain)
                        .map_err(|error| format!("Bot roster injection failed: {error}"))?
                    {
                        write_frame(&local_write, patched.as_bytes()).await?;
                        bot_inserted.store(true, Ordering::Release);
                        let version = bot_version.lock().await.clone();
                        write_frame(
                            &local_write,
                            bot_presence(account_domain, version.as_deref()).as_bytes(),
                        )
                        .await?;
                        if should_send_welcome(
                            true,
                            version.is_some(),
                            welcome_sent.load(Ordering::Acquire),
                        ) && welcome_sent
                            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                            .is_ok()
                        {
                            let bot_jid = format!("{}@{account_domain}", crate::fake_player::PUUID);
                            let welcome = crate::fake_player::help_text();
                            crate::fake_player::record_message(welcome, false);
                            write_frame(&local_write, bot_reply(&bot_jid, welcome, 0).as_bytes())
                                .await?;
                        }
                        continue;
                    }
                }
            }
            if let Ok(stanza) = std::str::from_utf8(&frame) {
                super::gui_chat_hub().incoming(gui_connection, stanza);
                crate::presence_proxy::record_live_chat(stanza);
            }
            write_frame(&local_write, &frame).await?;
        }
    }
}

async fn write_frame<T: AsyncWriteExt + Unpin>(
    writer: &Arc<AsyncMutex<T>>,
    frame: &[u8],
) -> Result<(), String> {
    let mut writer = writer.lock().await;
    writer
        .write_all(frame)
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())
}

fn presence_for_state(stanza: &str, state: MaskingState) -> Result<Option<String>, String> {
    if !state.enabled {
        return Ok(Some(stanza.to_string()));
    }
    rewrite_presence(stanza, state.mode)
}

fn account_domain_for_target(target: &crate::presence_proxy::UpstreamTarget) -> String {
    let domain = target
        .affinity
        .as_deref()
        .and_then(crate::xmpp::regions::region_by_lookup_name)
        .map(|region| region.domain)
        .unwrap_or_else(|| target.host.split('.').next().unwrap_or("riot"));
    format!("{domain}.pvp.net")
}

fn should_send_welcome(roster_inserted: bool, valorant_ready: bool, welcome_sent: bool) -> bool {
    roster_inserted && valorant_ready && !welcome_sent
}

fn outgoing_live_groupchat(stanza: &str) -> Option<String> {
    let (channel, _, _) = crate::presence_proxy::xml::group_muc_target(stanza)?;
    if !matches!(
        channel,
        crate::riot::models::ChatChannel::Party
            | crate::riot::models::ChatChannel::Pregame
            | crate::riot::models::ChatChannel::Team
            | crate::riot::models::ChatChannel::All
    ) {
        return None;
    }
    Some(crate::presence_proxy::xml::parse_groupchat_line(stanza)?.body)
}

/// A command line typed into a party, pregame, team or all room: a built-in
/// `.` command or a dotted custom trigger. Bare trigger words such as `gg`
/// stay ordinary chat.
fn outgoing_group_command(stanza: &str) -> Option<String> {
    let body = outgoing_live_groupchat(stanza)?;
    (crate::riot::chat_command::is_builtin_command(&body)
        || crate::commands::riot_chat::is_dotted_custom_trigger(
            &body,
            crate::presence_proxy::app_handle(),
        ))
    .then_some(body)
}

pub async fn stop() {
    let active = runtime().lock().unwrap().take();
    if let Some(active) = active {
        active.handle.abort();
        let _ = active.handle.await;
    }
    crate::presence_proxy::controller().reset_chat_session();
    // Nothing observes the game's presence once the relay is down, so the last
    // state it reported must not keep answering for it.
    crate::presence_proxy::clear_presence_match_state();
    crate::presence_proxy::controller().set_relay_port(None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presence_proxy::{self, PresenceMode, UpstreamTarget};

    #[test]
    fn direct_messages_build_local_bot_presence_and_whisper_frames() {
        let frames = direct_message_frames(
            "ap1.pvp.net",
            Some("release-11.04-shipping-4-3520990"),
            &BotDirectMessage {
                sequence: 27,
                body: "hello <player>".into(),
            },
        );

        assert_eq!(frames.len(), 2);
        assert!(frames[0].starts_with("<presence"));
        assert!(frames[1].contains("hello &lt;player&gt;"));
        assert!(frames[1].contains("-27\" type=\"chat\""));
    }

    #[test]
    fn uses_the_xmpp_domain_mapped_from_the_pas_affinity() {
        let sea = UpstreamTarget {
            host: "sa1.chat.si.riotgames.com".into(),
            port: 5223,
            affinity: Some("sea1".into()),
        };
        let euw = UpstreamTarget {
            host: "eu3.chat.si.riotgames.com".into(),
            port: 5223,
            affinity: Some("euw1".into()),
        };

        assert_eq!(account_domain_for_target(&sea), "sa1.pvp.net");
        assert_eq!(account_domain_for_target(&euw), "eu1.pvp.net");
    }

    #[test]
    fn bot_translation_uses_the_source_connection_not_global_broadcast() {
        let source = include_str!("relay.rs");
        assert!(source.contains("translate_bot_command_on_connection"));
        assert!(!source.contains(concat!("outbound", ".try_recv()")));
    }

    #[test]
    fn swallows_every_builtin_command_typed_in_live_group_chat() {
        for room in [
            "party@ares-parties.ap",
            "match-blue@ares-coregame.ap1.pvp.net",
            "match-all@ares-coregame.ap1.pvp.net",
            "match-blue@ares-pregame.ap1.pvp.net",
        ] {
            for body in [
                ".send team french hello",
                ".tran [5]",
                ".dodge",
                ".ai team gl",
                ".ask comp?",
                ".ASCII gg",
            ] {
                let stanza = format!(
                    r#"<message to="{room}" type="groupchat"><body>{body}</body></message>"#
                );
                assert_eq!(
                    outgoing_group_command(&stanza).as_deref(),
                    Some(body),
                    "{room}"
                );
            }
        }

        for body in ["hello", "gg", ".asciify gg", "$online"] {
            let stanza = format!(
                r#"<message to="party@ares-parties.ap" type="groupchat"><body>{body}</body></message>"#
            );
            assert_eq!(outgoing_group_command(&stanza), None, "{body}");
        }
        assert_eq!(
            outgoing_group_command(
                r#"<message to="room@conference.example" type="groupchat"><body>.dodge</body></message>"#
            ),
            None,
            "only Riot party/pregame/team/all MUCs are checked"
        );
        assert_eq!(
            outgoing_group_command(
                r#"<message to="friend@ap1.pvp.net" type="chat"><body>.dodge</body></message>"#
            ),
            None
        );
    }

    #[test]
    fn live_translation_uses_the_native_player_message_shape() {
        let stanza = crate::presence_proxy::game_groupchat_stanza(
            "match-all@ares-coregame.ap1.pvp.net",
            "a < b & c",
        );
        assert!(stanza.starts_with("<message id=\""));
        assert!(stanza.contains(r#"to="match-all@ares-coregame.ap1.pvp.net" type="groupchat""#));
        assert!(stanza.contains("<body>a &lt; b &amp; c</body>"));
        assert!(!stanza.contains("<presence"));
    }

    #[test]
    fn welcome_waits_for_roster_and_valorant_presence_readiness() {
        assert!(!should_send_welcome(false, true, false));
        assert!(!should_send_welcome(true, false, false));
        assert!(should_send_welcome(true, true, false));
        assert!(!should_send_welcome(true, true, true));
    }

    #[tokio::test]
    async fn starts_on_an_ephemeral_loopback_port() {
        let _ = presence_proxy::init(
            true,
            PresenceMode::Offline,
            true,
            crate::chat_certs::DEFAULT,
        );
        let port = start().await.unwrap();
        assert_ne!(port, 0);
        assert_eq!(presence_proxy::controller().relay_port(), Some(port));
        stop().await;
        assert_eq!(presence_proxy::controller().relay_port(), None);
    }

    #[test]
    fn builds_an_in_memory_server_certificate() {
        assert!(crate::presence_proxy::local_ca::generate_test_acceptor().is_ok());
    }

    #[test]
    fn disabled_masking_forwards_the_original_presence() {
        let original = "<presence><show>chat</show></presence>";
        let state = MaskingState {
            enabled: false,
            mode: PresenceMode::Offline,
            connect_to_muc: true,
        };
        assert_eq!(
            presence_for_state(original, state).unwrap(),
            Some(original.into())
        );
    }
}
