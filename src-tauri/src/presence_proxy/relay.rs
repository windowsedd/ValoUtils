use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;
#[cfg(not(test))]
use tokio_native_tls::TlsAcceptor;
#[cfg(test)]
use tokio_rustls::TlsAcceptor;
use tokio_rustls::TlsConnector;

use crate::presence_proxy::xml::{
    bot_command_frames, bot_message_body, bot_presence, bot_reply, inject_bot_roster,
    is_global_presence, is_muc_presence, parse_bot_message, rewrite_presence, BotCommand,
    XmppFramer,
};
use crate::presence_proxy::MaskingState;

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
    crate::presence_proxy::local_ca::load_acceptor().await
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
    let client_loop = client_to_remote(
        local_read,
        local_write.clone(),
        remote_write.clone(),
        &domain,
        bot_inserted.clone(),
        welcome_sent.clone(),
        bot_version.clone(),
    );
    let server_loop = remote_to_client(
        remote_read,
        local_write.clone(),
        &domain,
        bot_inserted,
        welcome_sent,
        bot_version,
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
) -> Result<(), String> {
    let mut framer = XmppFramer::new(256 * 1024);
    let mut buffer = vec![0u8; 16 * 1024];
    let mut last_presence: Option<String> = None;
    let mut states = crate::presence_proxy::controller().subscribe_state();
    let mut outbound = crate::presence_proxy::subscribe_outbound();
    let mut reply_sequence = 0u64;

    loop {
        tokio::select! {
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
                    if stanza.to_ascii_lowercase().contains(crate::fake_player::PUUID) {
                        if let Some((bot_jid, command)) = parse_bot_message(stanza).map_err(|error| format!("Bot command parse failed: {error}"))? {
                            if command != BotCommand::Consume {
                                reply_sequence += 1;
                                let body = bot_message_body(stanza).unwrap_or_default();
                                crate::fake_player::record_message(&body, true);
                                let reply = if command == BotCommand::Translate {
                                    match crate::commands::riot_chat::execute_typed_translation(
                                        &body,
                                        crate::presence_proxy::app_handle(),
                                    )
                                    .await
                                    {
                                        Ok(outcome) => {
                                            crate::commands::riot_chat::format_translation_reply(
                                                &outcome,
                                            )
                                        }
                                        Err(error) => error.to_string(),
                                    }
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
                                } else if let Some(custom) =
                                    crate::commands::riot_chat::execute_maybe_custom_command(
                                        &body,
                                        crate::presence_proxy::app_handle(),
                                    )
                                    .await
                                {
                                    match custom {
                                        Ok(reply) => reply,
                                        Err(error) => error.to_string(),
                                    }
                                } else {
                                    crate::presence_proxy::apply_command(
                                        crate::fake_player::parse_command(&body),
                                    )
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
                        write_frame(&remote_write, rewritten.as_bytes()).await?;
                    } else {
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

async fn remote_to_client(
    mut read: ReadHalf<RemoteTls>,
    local_write: Arc<AsyncMutex<WriteHalf<LocalTls>>>,
    account_domain: &str,
    bot_inserted: Arc<AtomicBool>,
    welcome_sent: Arc<AtomicBool>,
    bot_version: Arc<AsyncMutex<Option<String>>>,
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

pub async fn stop() {
    if let Some(active) = runtime().lock().unwrap().take() {
        active.handle.abort();
    }
    crate::presence_proxy::controller().set_relay_port(None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presence_proxy::{self, PresenceMode, UpstreamTarget};

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
    fn welcome_waits_for_roster_and_valorant_presence_readiness() {
        assert!(!should_send_welcome(false, true, false));
        assert!(!should_send_welcome(true, false, false));
        assert!(should_send_welcome(true, true, false));
        assert!(!should_send_welcome(true, true, true));
    }

    #[tokio::test]
    async fn starts_on_an_ephemeral_loopback_port() {
        let _ = presence_proxy::init(true, PresenceMode::Offline, true);
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
