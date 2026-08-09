use crate::xmpp::regions::{region_by_lookup_name, XmppRegion};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::Mutex as AsyncMutex;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

#[derive(Clone, serde::Serialize)]
pub struct ChatMessage {
    pub id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub sender: String,
    #[serde(rename = "senderName")]
    pub sender_name: String,
    pub body: String,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub scope: String,
    #[serde(rename = "isSelf")]
    pub is_self: bool,
}

const MAX_BUFFERED_MESSAGES: usize = 200;

type Stream = TlsStream<tokio::net::TcpStream>;

/// A live XMPP session. Reconnection is handled one layer up (in
/// xmpp::state::ensure_*): if `alive` goes false, the caller logs in fresh
/// rather than hot-swapping the socket inside this handle, which is simpler
/// to reason about than in-place reconnection and behaves the same from the
/// polling-based chat UI's perspective (it re-checks aliveness on every poll).
pub struct XmppHandle {
    write: AsyncMutex<WriteHalf<Stream>>,
    alive: Arc<AtomicBool>,
    pub puuid: String,
    pub messages: Arc<std::sync::Mutex<VecDeque<ChatMessage>>>,
}

impl XmppHandle {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    async fn send_raw(&self, data: &str) -> Result<(), String> {
        let mut write = self.write.lock().await;
        write
            .write_all(data.as_bytes())
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn join_match_muc(
        &self,
        muc_jid: &str,
        match_token: Option<&str>,
    ) -> Result<(), String> {
        let token_el = match match_token {
            Some(t) if !t.is_empty() => format!(
                r#"<token xmlns="urn:riotgames:match:token">{}</token>"#,
                escape_xml(t)
            ),
            _ => String::new(),
        };
        let stanza = format!(
            r#"<presence to="{}/{}"><x xmlns="http://jabber.org/protocol/muc"><history maxstanzas="0"/></x>{}</presence>"#,
            escape_xml(muc_jid),
            escape_xml(&self.puuid),
            token_el
        );
        self.send_raw(&stanza).await
    }

    pub async fn leave_match_muc(&self, muc_jid: &str) -> Result<(), String> {
        let stanza = format!(
            r#"<presence to="{}/{}" type="unavailable"/>"#,
            escape_xml(muc_jid),
            escape_xml(&self.puuid)
        );
        self.send_raw(&stanza).await
    }

    pub async fn send_muc_message(&self, muc_jid: &str, content: &str) -> Result<(), String> {
        let stanza = format!(
            r#"<message id="{}:1" to="{}" type="groupchat"><body>{}</body></message>"#,
            epoch_secs(),
            escape_xml(muc_jid),
            escape_xml(content)
        );
        self.send_raw(&stanza).await
    }

    pub async fn end(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let mut write = self.write.lock().await;
        let _ = write.shutdown().await;
    }
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let needle = format!(r#"{attr}=""#);
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

fn extract_text(stanza: &str, tag: &str) -> Option<String> {
    let open_start = stanza.find(&format!("<{tag}"))?;
    let open_end = stanza[open_start..].find('>')? + open_start + 1;
    if stanza[open_start..open_end].ends_with("/>") {
        return Some(String::new());
    }
    let close = format!("</{tag}>");
    let close_start = stanza[open_end..].find(&close)? + open_end;
    Some(stanza[open_end..close_start].to_string())
}

/// Decodes the base64url middle segment of a JWT without verifying the
/// signature — we only need the claims (`sub`/`affinity`), and the token was
/// already validated by Riot's own PAS service that issued it to us.
fn decode_jwt_payload(jwt: &str) -> Result<Value, String> {
    use base64::Engine;
    let payload_b64 = jwt.split('.').nth(1).ok_or("malformed JWT")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(payload_b64))
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

async fn get_pas_token(access_token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("getPASToken failed: {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}

async fn tls_connect(region: &XmppRegion) -> Result<Stream, String> {
    let host = format!("{}.chat.si.riotgames.com", region.affinity);
    let tcp = tokio::net::TcpStream::connect((host.as_str(), 5223))
        .await
        .map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // Explicit provider (rather than relying on a process-wide default) so this
    // doesn't race/conflict with whatever crypto backend reqwest's rustls-tls
    // stack installs elsewhere in the process.
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("rustls: ring provider supports default protocol versions")
    .with_root_certificates(root_store)
    .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let server_name = rustls::pki_types::ServerName::try_from(host)
        .map_err(|e| e.to_string())?
        .to_owned();
    connector
        .connect(server_name, tcp)
        .await
        .map_err(|e| e.to_string())
}

/// Reads whatever is currently available on the socket in one syscall —
/// mirrors the underlying library's `read()`, which the original handshake
/// deliberately does NOT frame into complete XML stanzas (see `read_stanza`).
async fn read_once(read: &mut ReadHalf<Stream>) -> Result<String, String> {
    let mut buf = vec![0u8; 65536];
    let n = read.read(&mut buf).await.map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("connection closed".into());
    }
    Ok(String::from_utf8_lossy(&buf[..n]).to_string())
}

/// Accumulates reads until the buffer forms a balanced (well-formed-enough)
/// XML fragment, mirroring the upstream library wrapping the accumulated
/// buffer in a dummy root and checking `XMLValidator.validate`. We use a
/// lightweight tag-depth balance check instead of full validation, which is
/// sufficient for the small, attribute-only stanzas Riot's chat server sends.
async fn read_stanza(read: &mut ReadHalf<Stream>) -> Result<String, String> {
    let mut acc = String::new();
    loop {
        acc.push_str(&read_once(read).await?);
        if is_balanced(&acc) && !acc.trim().is_empty() {
            return Ok(acc);
        }
    }
}

fn is_balanced(xml: &str) -> bool {
    let mut depth: i32 = 0;
    let mut chars = xml.char_indices().peekable();
    let mut saw_any = false;
    while let Some((i, c)) = chars.next() {
        if c != '<' {
            continue;
        }
        let Some(end) = xml[i..].find('>') else {
            return false;
        };
        let tag = &xml[i..i + end + 1];
        if tag.starts_with("<?") || tag.starts_with("<!") {
            continue;
        }
        saw_any = true;
        if tag.starts_with("</") {
            depth -= 1;
        } else if tag.ends_with("/>") {
            // self-closing, no depth change
        } else {
            depth += 1;
        }
    }
    saw_any && depth <= 0
}

pub struct LoginResult {
    pub handle: Arc<XmppHandle>,
    pub display_name: Option<(String, String)>,
}

/// Full handshake: PAS token -> region -> TLS connect -> stream negotiation ->
/// SASL (X-Riot-RSO-PAS) -> bind -> session setup -> initial presence.
/// Mirrors ValorantXmppClient.login()'s token-auth path in
/// @windowsedd/valorant-api (roster/friend-request features are intentionally
/// not ported — ValoUtils only uses match/party MUC chat).
pub async fn login(
    access_token: &str,
    _entitlement_token: &str,
    puuid: &str,
) -> Result<LoginResult, String> {
    let pas_token = get_pas_token(access_token).await?;
    let claims = decode_jwt_payload(&pas_token)?;
    let affinity = claims
        .get("affinity")
        .and_then(|v| v.as_str())
        .ok_or("PAS token missing affinity claim")?;
    let region =
        region_by_lookup_name(affinity).ok_or_else(|| format!("InvalidRegion: {affinity}"))?;

    let stream = tls_connect(region).await?;
    let (mut read, mut write) = tokio::io::split(stream);

    let stream_decl = format!(
        r#"<?xml version="1.0"?><stream:stream to="{}.pvp.net" version="1.0" xmlns:stream="http://etherx.jabber.org/streams">"#,
        region.domain
    );
    write
        .write_all(stream_decl.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let first = read_once(&mut read).await?;
    if !first.contains("stream:features") {
        read_once(&mut read).await?;
    }

    let auth_stanza = format!(
        r#"<auth mechanism="X-Riot-RSO-PAS" xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><rso_token>{}</rso_token><pas_token>{}</pas_token></auth>"#,
        escape_xml(access_token),
        escape_xml(&pas_token)
    );
    write
        .write_all(auth_stanza.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let auth_response = read_stanza(&mut read).await?;
    if !auth_response.contains("<success") {
        return Err("XMPP auth error".into());
    }

    write
        .write_all(stream_decl.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let second = read_once(&mut read).await?;
    if !second.contains("stream:features") {
        read_once(&mut read).await?;
    }

    write
        .write_all(br#"<iq id="_xmpp_bind1" type="set"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><puuid-mode enabled="true"/><resource>RC-VALORANT-NODE</resource></bind></iq>"#)
        .await
        .map_err(|e| e.to_string())?;
    let bind_response = read_stanza(&mut read).await?;
    let _jid = extract_text(&bind_response, "jid");

    write
        .write_all(br#"<iq id="set_rxep_1" type="set"><rxcep xmlns="urn:riotgames:rxep"><last-online-state enabled="true"/></rxcep></iq>"#)
        .await
        .map_err(|e| e.to_string())?;
    read_once(&mut read).await?;

    write
        .write_all(br#"<iq id="_xmpp_session1" type="set"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>"#)
        .await
        .map_err(|e| e.to_string())?;
    let session_response = read_stanza(&mut read).await?;
    let display_name = extract_tag(&session_response, "id").map(|id_tag| {
        (
            extract_attr(&id_tag, "name").unwrap_or_default(),
            extract_attr(&id_tag, "tagline").unwrap_or_default(),
        )
    });

    let presence_stanza = build_presence_stanza();
    write
        .write_all(presence_stanza.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    write
        .write_all(br#"<iq type="get"><query xmlns="jabber:iq:riotgames:roster"/></iq>"#)
        .await
        .map_err(|e| e.to_string())?;

    let alive = Arc::new(AtomicBool::new(true));
    let messages = Arc::new(std::sync::Mutex::new(VecDeque::new()));
    let handle = Arc::new(XmppHandle {
        write: AsyncMutex::new(write),
        alive: alive.clone(),
        puuid: puuid.to_string(),
        messages: messages.clone(),
    });

    let write_for_presence = handle.clone();
    tokio::spawn(async move { run_background(read, alive, messages, write_for_presence).await });

    Ok(LoginResult {
        handle,
        display_name,
    })
}

fn extract_tag(stanza: &str, tag: &str) -> Option<String> {
    let open_start = stanza.find(&format!("<{tag} "))?;
    let end = stanza[open_start..].find(['>'])? + open_start + 1;
    Some(stanza[open_start..end].to_string())
}

fn build_presence_stanza() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!(
        r#"<presence id="presence_1"><show>chat</show><status/><games><keystone><st>chat</st><s.t>{ts}</s.t><m/><s.p>keystone</s.p></keystone></games></presence>"#
    )
}

/// Background read loop + presence keep-alive, mirroring `_mainLoop()`. Only
/// dispatches `groupchat` message stanzas into the shared buffer (capped at
/// 200) — ValoUtils doesn't use presence/roster/friend events.
async fn run_background(
    mut read: ReadHalf<Stream>,
    alive: Arc<AtomicBool>,
    messages: Arc<std::sync::Mutex<VecDeque<ChatMessage>>>,
    handle: Arc<XmppHandle>,
) {
    let mut presence_interval = tokio::time::interval(std::time::Duration::from_secs(120));
    presence_interval.tick().await; // first tick fires immediately; skip it, we already sent initial presence

    loop {
        tokio::select! {
            _ = presence_interval.tick() => {
                let stanza = build_presence_stanza();
                if handle.send_raw(&stanza).await.is_err() {
                    break;
                }
            }
            result = read_stanza(&mut read) => {
                match result {
                    Ok(stanza) => handle_incoming_stanza(&stanza, &messages),
                    Err(_) => break,
                }
            }
        }
    }
    alive.store(false, Ordering::SeqCst);
}

fn handle_incoming_stanza(stanza: &str, messages: &Arc<std::sync::Mutex<VecDeque<ChatMessage>>>) {
    for message_tag in split_top_level_tags(stanza, "message") {
        if extract_attr(&message_tag, "type").as_deref() != Some("groupchat") {
            continue;
        }
        let from = extract_attr(&message_tag, "from").unwrap_or_default();
        let (room, sender_nick) = match from.split_once('/') {
            Some((room, resource)) => (room.to_string(), resource.to_string()),
            None => (from.clone(), String::new()),
        };
        let body = extract_text(&message_tag, "body").unwrap_or_default();
        let id = extract_attr(&message_tag, "id")
            .unwrap_or_else(|| format!("{room}:{sender_nick}:{}", epoch_secs()));

        let scope = if room.to_lowercase().contains("ares-parties") {
            "party"
        } else {
            "match"
        };
        let mut buf = messages.lock().unwrap();
        if buf.iter().any(|m| m.id == id) {
            continue;
        }
        buf.push_back(ChatMessage {
            id,
            conversation_id: room,
            sender: sender_nick.clone(),
            sender_name: sender_nick,
            body,
            timestamp: iso8601_now(),
            msg_type: "groupchat".into(),
            scope: scope.into(),
            is_self: false, // isSelf is resolved by the caller (which knows own_puuid)
        });
        while buf.len() > MAX_BUFFERED_MESSAGES {
            buf.pop_front();
        }
    }
}

/// Finds each complete top-level `<tag ...>...</tag>` (or self-closed
/// `<tag .../>`) occurrence of `tag` within `xml`, without needing a full
/// generic XML parser — the incoming stanzas we care about are flat.
fn split_top_level_tags(xml: &str, tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut search_from = 0;
    let open_needle = format!("<{tag}");
    while let Some(rel_start) = xml[search_from..].find(&open_needle) {
        let start = search_from + rel_start;
        let Some(rel_tag_end) = xml[start..].find('>') else {
            break;
        };
        let tag_end = start + rel_tag_end + 1;
        if xml[start..tag_end].ends_with("/>") {
            out.push(xml[start..tag_end].to_string());
            search_from = tag_end;
            continue;
        }
        let close_needle = format!("</{tag}>");
        let Some(rel_close) = xml[tag_end..].find(&close_needle) else {
            break;
        };
        let close_end = tag_end + rel_close + close_needle.len();
        out.push(xml[start..close_end].to_string());
        search_from = close_end;
    }
    out
}

fn iso8601_now() -> String {
    let secs = epoch_secs() as i64;
    let (y, m, d, h, mi, s) = crate::util_time::civil_from_unix_secs(secs);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}
