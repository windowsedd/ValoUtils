# Native Riot Presence Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native loopback TLS/XMPP relay that lets ValoUtils users appear Online, Offline, or Mobile through UI controls or a synthetic Riot chat contact.

**Architecture:** The existing client-config proxy captures Riot's real chat target and rewrites chat endpoints to a new loopback relay. A shared Rust controller filters global presence, injects a local control contact, and exposes JSON-string Tauri commands. The existing launch flow starts both listeners before Riot Client.

**Tech Stack:** Rust 2021, Tokio, rustls 0.23, tokio-rustls 0.26, rcgen 0.14, xmltree 0.12, Tauri 2, React 19, TypeScript 6, HeroUI 3.

## Global Constraints

- Windows only.
- Keep the client-config proxy on `127.0.0.1:8000`.
- Bind the XMPP relay to an operating-system-assigned loopback port.
- Accept `online`, `offline`, and `mobile`; default to `offline`.
- Rewrite global presence only. Pass presence with a `to` attribute unchanged.
- Never send the synthetic bot PUUID or bot messages to Riot.
- Never persist or log tokens, raw XMPP streams, presence blobs, or TLS keys.
- Do not copy, translate, or mechanically port GPL-3.0 Deceive source.
- Preserve unrelated uncommitted user changes.
- Use Bun for frontend commands.

---

## File Structure

- Create `src-tauri/src/presence_proxy/mod.rs`: controller and service API.
- Create `src-tauri/src/presence_proxy/xml.rs`: bounded XMPP framing and stanza transforms.
- Create `src-tauri/src/presence_proxy/relay.rs`: TLS listener and bidirectional relay.
- Create `src-tauri/src/commands/presence.rs`: JSON-string Tauri commands.
- Modify `src-tauri/src/client_config.rs`: capture and rewrite chat targets.
- Modify `src-tauri/src/commands/riot_launch.rs`: start, stop, rollback, and status.
- Modify `src-tauri/src/dummy_bot.rs`: share bot identity and presence commands.
- Modify `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, and `Cargo.lock`.
- Modify `src/components/riot-status-bar.tsx`, `src/pages/DummyBot.tsx`, and three locale JSON files.
- Modify `CLAUDE.md`: document IPC and relay lifecycle.

---

### Task 1: Presence controller

**Files:**
- Create: `src-tauri/src/presence_proxy/mod.rs`
- Modify: `src-tauri/src/lib.rs:1-60`
- Modify: `src-tauri/Cargo.toml:20-45`

**Interfaces:**
- Produces: `PresenceMode`, `PresenceController`, `PresenceSnapshot`, `UpstreamTarget`, `init()`, and `controller()`.
- Consumes: existing `ConfigStore`.

- [ ] **Step 1: Add dependencies**

```toml
rcgen = "0.14"
xmltree = "0.12"
```

Run: `cargo check` from `src-tauri`.
Expected: exit 0 and both crates appear in `Cargo.lock`.

- [ ] **Step 2: Write failing model tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_modes() {
        assert_eq!(PresenceMode::parse("online"), Some(PresenceMode::Online));
        assert_eq!(PresenceMode::parse(" OFFLINE "), Some(PresenceMode::Offline));
        assert_eq!(PresenceMode::parse("mobile"), Some(PresenceMode::Mobile));
        assert_eq!(PresenceMode::parse("away"), None);
    }

    #[test]
    fn starts_offline_without_connections() {
        let state = PresenceController::new(PresenceMode::Offline).snapshot();
        assert_eq!(state.mode, PresenceMode::Offline);
        assert_eq!(state.active_connections, 0);
        assert!(!state.relay_running);
    }
}
```

Run: `cargo test presence_proxy::tests --lib`.
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the model and state**

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceMode { Online, Offline, Mobile }

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
        match self { Self::Online => "online", Self::Offline => "offline", Self::Mobile => "mobile" }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpstreamTarget { pub host: String, pub port: u16 }

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshot {
    pub mode: PresenceMode,
    pub relay_running: bool,
    pub relay_port: Option<u16>,
    pub active_connections: usize,
    pub upstream_ready: bool,
    pub last_warning: Option<String>,
}
```

`PresenceController` uses `std::sync::Mutex<Inner>` plus a `tokio::sync::broadcast::Sender<PresenceMode>`. `Inner` contains the fields above plus `upstream: Option<UpstreamTarget>` and `last_presence: Option<String>`. Expose these exact signatures:

```rust
pub fn mode(&self) -> PresenceMode;
pub fn set_mode(&self, mode: PresenceMode) { self.inner.lock().unwrap().mode = mode; let _ = self.mode_tx.send(mode); }
pub fn subscribe_modes(&self) -> tokio::sync::broadcast::Receiver<PresenceMode>;
pub fn set_upstream(&self, target: UpstreamTarget);
pub fn upstream(&self) -> Option<UpstreamTarget>;
pub fn set_relay_port(&self, port: Option<u16>);
pub fn relay_port(&self) -> Option<u16>;
pub fn connection_opened(&self);
pub fn connection_closed(&self);
pub fn capture_presence(&self, stanza: String);
pub fn last_presence(&self) -> Option<String>;
pub fn set_warning(&self, warning: Option<String>);
pub fn snapshot(&self) -> PresenceSnapshot;
```

- [ ] **Step 4: Initialize from config**

```rust
mod presence_proxy;
config_defaults.insert("presenceMode".into(), json!("offline"));
let presence_mode = config_store
    .get("presenceMode")
    .and_then(|v| v.as_str().and_then(presence_proxy::PresenceMode::parse))
    .unwrap_or(presence_proxy::PresenceMode::Offline);
presence_proxy::init(presence_mode).expect("presence controller initialized once");
```

Run: `cargo test presence_proxy::tests --lib`.
Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/presence_proxy/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add presence controller state"
```

---

### Task 2: Client-config capture and rewrite

**Files:**
- Modify: `src-tauri/src/client_config.rs:1-135`
- Modify: `src-tauri/src/presence_proxy/mod.rs`

**Interfaces:**
- Consumes: controller relay port and `set_upstream`.
- Produces: loopback chat config and a real `UpstreamTarget`.

- [ ] **Step 1: Write failing pure-function tests**

```rust
#[test]
fn patches_chat_config() {
    let input = br#"{"chat.host":"na2.chat.si.riotgames.com","chat.port":5223,
      "chat.affinities":{"na1":"na2.chat.si.riotgames.com"}}"#;
    let result = patch_config_json(input, 43123, Some("na1")).unwrap();
    assert_eq!(result.json["chat.host"], "127.0.0.1");
    assert_eq!(result.json["chat.port"], 43123);
    assert_eq!(result.json["chat.affinities"]["na1"], "127.0.0.1");
    assert_eq!(result.json["chat.allow_bad_cert.enabled"], true);
    assert_eq!(result.upstream.unwrap().host, "na2.chat.si.riotgames.com");
}

#[test]
fn malformed_body_is_not_patched() {
    assert!(patch_config_json(b"upstream error", 43123, None).is_err());
}
```

Run: `cargo test client_config::tests --lib`.
Expected: FAIL because `patch_config_json` does not exist.

- [ ] **Step 2: Implement JSON patching**

```rust
struct PatchedConfig { json: Value, upstream: Option<UpstreamTarget> }

fn patch_config_json(body: &[u8], relay_port: u16, affinity: Option<&str>) -> Result<PatchedConfig, String> {
    let mut json: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let port = json.get("chat.port").and_then(Value::as_u64).unwrap_or(5223) as u16;
    let fallback = json.get("chat.host").and_then(Value::as_str).map(str::to_owned);
    let affinity_host = affinity.and_then(|key| json.get("chat.affinities")?.get(key)?.as_str().map(str::to_owned));
    let upstream = affinity_host.or(fallback).map(|host| UpstreamTarget { host, port });
    json["chat.host"] = json!("127.0.0.1");
    json["chat.port"] = json!(relay_port);
    json["chat.allow_bad_cert.enabled"] = json!(true);
    if let Some(values) = json.get_mut("chat.affinities").and_then(Value::as_object_mut) {
        for value in values.values_mut() { *value = json!("127.0.0.1"); }
    }
    Ok(PatchedConfig { json, upstream })
}
```

- [ ] **Step 3: Resolve affinity without retaining credentials**

Add `resolve_affinity(&HeaderValue) -> Result<String, String>`. Call Riot's PAS chat endpoint with the Authorization header, decode the JWT middle segment using `base64::URL_SAFE_NO_PAD`, and return only the `affinity` claim. Never log the header or response token. On failure, record a warning and use `chat.host`.

- [ ] **Step 4: Patch only successful JSON responses**

```rust
if status.is_success() {
    if let Some(port) = presence_proxy::controller().relay_port() {
        let affinity = resolve_affinity_header(&headers).await.ok();
        if let Ok(patched) = patch_config_json(&bytes, port, affinity.as_deref()) {
            if let Some(upstream) = patched.upstream { presence_proxy::controller().set_upstream(upstream); }
            bytes = serde_json::to_vec(&patched.json).map_err(|e| e.to_string())?;
        }
    }
}
```

Run: `cargo test client_config::tests --lib`.
Expected: PASS for affinity, fallback, malformed JSON, and unrelated-field preservation.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/client_config.rs src-tauri/src/presence_proxy/mod.rs
git commit -m "feat: redirect Riot chat config to local relay"
```

---

### Task 3: XMPP framing and presence rewrite

**Files:**
- Create: `src-tauri/src/presence_proxy/xml.rs`
- Modify: `src-tauri/src/presence_proxy/mod.rs`

**Interfaces:**
- Produces: `XmppFramer::push(&[u8]) -> Result<Vec<Vec<u8>>, FrameError>`.
- Produces: `rewrite_presence(&str, PresenceMode) -> Result<Option<String>, String>`.
- `Ok(None)` means pass through unchanged.

- [ ] **Step 1: Write failing framing tests**

```rust
#[test]
fn frames_split_and_joined_stanzas() {
    let mut framer = XmppFramer::new(256 * 1024);
    assert!(framer.push(b"<presence><show>off").unwrap().is_empty());
    let frames = framer.push(b"line</show></presence><message><body>x</body></message>").unwrap();
    assert_eq!(frames.len(), 2);
}

#[test]
fn bounds_unclosed_input() {
    let mut framer = XmppFramer::new(16);
    assert!(matches!(framer.push(b"<presence>123456789"), Err(FrameError::TooLarge)));
}
```

Run: `cargo test presence_proxy::xml::tests --lib`.
Expected: FAIL because the framer does not exist.

- [ ] **Step 2: Implement the bounded scanner**

Implement `XmppFramer { buffer: Vec<u8>, max_bytes: usize }`. Scan byte-by-byte while tracking quotes, comments, CDATA, open tags, close tags, and self-closing tags. Return XML declarations and `<stream:stream>` headers as complete frames. Keep incomplete bytes. Return `TooLarge` after the configured limit.

- [ ] **Step 3: Write failing presence tests**

```rust
#[test]
fn preserves_muc_presence() {
    let stanza = r#"<presence to="room@ares-parties.na1.pvp.net/me"><show>chat</show></presence>"#;
    assert_eq!(rewrite_presence(stanza, PresenceMode::Offline).unwrap(), None);
}

#[test]
fn offline_removes_products() {
    let stanza = r#"<presence><show>chat</show><status>ready</status><games><valorant><p>secret</p></valorant><keystone/></games></presence>"#;
    let output = rewrite_presence(stanza, PresenceMode::Offline).unwrap().unwrap();
    assert!(output.contains("<show>offline</show>"));
    assert!(!output.contains("<status>"));
    assert!(!output.contains("<valorant>"));
}
```

Run: `cargo test presence_proxy::xml::tests --lib`.
Expected: FAIL because rewriting does not exist.

- [ ] **Step 4: Implement xmltree mutation**

Parse one `Element`. Return `None` for non-presence or `to`-addressed presence. Return the exact input for Online. For Offline and Mobile, set `show`, remove `status`, then remove product elements named `valorant`, `keystone`, `riot_client`, `league_of_legends`, `bacon`, or `lion`. Serialize without an XML declaration.

Run: `cargo test presence_proxy::xml::tests --lib`.
Expected: PASS for framing, MUC, Online, Offline, Mobile, and malformed XML.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/presence_proxy/xml.rs src-tauri/src/presence_proxy/mod.rs
git commit -m "feat: filter global XMPP presence"
```

---

### Task 4: TLS relay and control contact

**Files:**
- Create: `src-tauri/src/presence_proxy/relay.rs`
- Modify: `src-tauri/src/presence_proxy/xml.rs`
- Modify: `src-tauri/src/presence_proxy/mod.rs`
- Modify: `src-tauri/src/dummy_bot.rs:20-25,236-330`

**Interfaces:**
- Produces: `start() -> Result<u16, String>`, `stop().await`, connection registration, and live mode reapply.
- Produces: `BotCommand::{SetMode(PresenceMode), Status, Help}`.

- [ ] **Step 1: Write failing command tests**

```rust
#[test]
fn parses_presence_commands() {
    assert_eq!(parse_bot_command(" $OFFLINE "), Some(BotCommand::SetMode(PresenceMode::Offline)));
    assert_eq!(parse_bot_command("$mobile"), Some(BotCommand::SetMode(PresenceMode::Mobile)));
    assert_eq!(parse_bot_command("$status"), Some(BotCommand::Status));
    assert_eq!(parse_bot_command("$rank 27"), None);
}
```

Run: `cargo test presence_proxy::xml::tests::parses_presence_commands --lib`.
Expected: FAIL because `BotCommand` does not exist.

- [ ] **Step 2: Implement bot stanza helpers**

```rust
pub const BOT_PUUID: &str = crate::dummy_bot::PUUID;
pub fn parse_bot_message(stanza: &str) -> Result<Option<(String, BotCommand)>, String>;
pub fn inject_bot_roster(stanza: &str) -> Result<Option<String>, String>;
pub fn bot_presence(account_domain: &str) -> String;
pub fn bot_reply(to: &str, body: &str, sequence: u64) -> String;
```

Intercept only direct chat messages addressed to `BOT_PUUID`. Escape generated XML. Prevent duplicate roster injection.

- [ ] **Step 3: Build TLS configs**

```rust
let rcgen::CertifiedKey { cert, signing_key } =
    rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()])
        .map_err(|e| e.to_string())?;
let certs = vec![rustls::pki_types::CertificateDer::from(cert.der().to_vec())];
let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
    rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der())
);
let config = rustls::ServerConfig::builder_with_provider(
    std::sync::Arc::new(rustls::crypto::ring::default_provider())
)
.with_safe_default_protocol_versions().map_err(|e| e.to_string())?
.with_no_client_auth()
.with_single_cert(certs, key).map_err(|e| e.to_string())?;
let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));
```

Build upstream TLS with `webpki_roots::TLS_SERVER_ROOTS`, as in `xmpp/client.rs`. Flush after each rewritten frame.

- [ ] **Step 4: Implement listener and relay**

Bind `127.0.0.1:0`, return its assigned port, and retain the task handle. Each connection calls `subscribe_modes()` and uses `tokio::select!` to handle socket frames or a new mode. A mode update rewrites and sends that connection's captured global presence. For client-to-upstream frames: capture global presence, intercept bot messages, rewrite global presence, and pass everything else. For upstream-to-client frames: inject the roster item once, send bot presence once, and pass everything else. Parse failures pass through with a warning; oversized frames close the connection.

- [ ] **Step 5: Add mock TLS tests**

Use a test-only upstream TLS server and trust its test certificate. Verify ordinary forwarding, Offline rewrite, unchanged MUC presence, bot command suppression, bot replies, and live mode reapply.

Run: `cargo test presence_proxy::relay::tests --lib -- --nocapture`.
Expected: PASS without Riot or internet access.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/presence_proxy src-tauri/src/dummy_bot.rs
git commit -m "feat: relay Riot XMPP presence locally"
```

---

### Task 5: IPC and launch lifecycle

**Files:**
- Create: `src-tauri/src/commands/presence.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/riot_launch.rs:62-135`
- Modify: `src-tauri/src/client_config.rs:45-65`
- Modify: `src-tauri/src/lib.rs:80-130`

**Interfaces:**
- Produces: `presence:status:get`, `presence:status:set`, and `presence:status-changed`.
- Extends `client:config-status` with relay and presence fields.

- [ ] **Step 1: Write failing mode argument tests**

```rust
#[test]
fn validates_mode_arguments() {
    assert_eq!(mode_arg(&[json!("mobile")]), Ok(PresenceMode::Mobile));
    assert!(mode_arg(&[json!("away")]).is_err());
    assert!(mode_arg(&[]).is_err());
}
```

Run: `cargo test commands::presence::tests --lib`.
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement commands**

```rust
#[tauri::command]
pub async fn presence_status_get() -> Result<String, ()> {
    Ok(json!({ "success": true, "presence": controller().snapshot() }).to_string())
}

#[tauri::command]
pub async fn presence_status_set(args: Vec<Value>, config: State<'_, ConfigStore>) -> Result<String, ()> {
    let mode = match mode_arg(&args) {
        Ok(mode) => mode,
        Err(error) => return Ok(json!({ "success": false, "error": error }).to_string()),
    };
    controller().set_mode(mode);
    config.set("presenceMode", json!(mode.as_str()));
    Ok(json!({ "success": true, "presence": controller().snapshot() }).to_string())
}
```

Register the module and commands.

- [ ] **Step 3: Start services with rollback**

```rust
let relay_port = presence_proxy::start().await?;
if let Err(error) = client_config::start(client_config::DEFAULT_PORT).await {
    presence_proxy::stop().await;
    return Err(error);
}
```

If Riot `Command::spawn` fails, stop both. `client_config_stop` stops both. App exit closes sockets and listeners. Emit `presence:status-changed` after state changes.

- [ ] **Step 4: Run backend gates**

```powershell
cargo fmt --check
cargo test --lib
cargo clippy --lib -- -D warnings
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/commands/presence.rs src-tauri/src/commands/mod.rs src-tauri/src/commands/riot_launch.rs src-tauri/src/client_config.rs src-tauri/src/lib.rs
git commit -m "feat: expose presence relay controls"
```

---

### Task 6: Tauri UI

**Files:**
- Modify: `src/components/riot-status-bar.tsx:8-115`
- Modify: `src/pages/DummyBot.tsx:39-240`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`

**Interfaces:**
- Consumes the three presence channels and extended launch status.

- [ ] **Step 1: Add types and listeners**

```tsx
type PresenceMode = "online" | "offline" | "mobile";
type PresenceSnapshot = {
  mode: PresenceMode;
  relayRunning: boolean;
  relayPort: number | null;
  activeConnections: number;
  upstreamReady: boolean;
  lastWarning: string | null;
};
```

Register one listener per channel in `useEffect` and remove each on cleanup. The backend reply shape is `{ success, presence }`; store its `presence` property.

- [ ] **Step 2: Add selector**

```tsx
{(["online", "offline", "mobile"] as const).map((mode) => (
  <button
    key={mode}
    disabled={!presence?.relayRunning || presence.activeConnections === 0}
    onClick={() => {
      window.Main.send("presence:status:set", mode);
      window.Main.send("analytics:track", "presence_mode_change", JSON.stringify({ mode }));
    }}
    aria-pressed={presence?.mode === mode}
  >
    <span className={presenceDot[mode]} />
    {t(`presence.${mode}`)}
    {presence?.mode === mode && <FaCheck />}
  </button>
))}
```

Keep the settings-view eye button and account connectivity logic.

Register a close-request listener with `getCurrentWindow().onCloseRequested`. When `activeConnections > 0`, call `event.preventDefault()`, ask for confirmation through the existing dynamic modal, and call `getCurrentWindow().destroy()` only after confirmation. Remove the listener during cleanup.

- [ ] **Step 3: Extend Dummy Bot page**

Add relay fields to `LaunchStatus`, show readiness and warnings, and add `$online`, `$offline`, `$mobile`, and `$status` to `QUICK_COMMANDS`.

- [ ] **Step 4: Add translations**

```json
"presence": {
  "online": "Online",
  "offline": "Offline",
  "mobile": "Mobile",
  "relayDisconnected": "Launch Riot through ValoUtils to change presence.",
  "relayWarning": "Presence relay warning",
  "activeConnections": "Active XMPP connections"
}
```

Write native Korean and Traditional Chinese values in their locale files.

- [ ] **Step 5: Verify and commit**

Run: `bun run build:vite`.
Expected: TypeScript and Vite exit 0.

```powershell
git add src/components/riot-status-bar.tsx src/pages/DummyBot.tsx src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json
git commit -m "feat: control Riot presence from the UI"
```

---

### Task 7: Documentation and final verification

**Files:**
- Modify: `CLAUDE.md`
- Verify: all files changed by Tasks 1-6.

**Interfaces:**
- Documents new IPC, data flow, and shutdown behavior.

- [ ] **Step 1: Update CLAUDE.md**

Add the presence commands and event to the IPC table, add `presence_proxy/` to the tree, document the config rewrite and relay, and state that the local contact is invisible to other players.

- [ ] **Step 2: Run full verification**

```powershell
Push-Location src-tauri
cargo fmt --check
cargo test --lib
cargo clippy --lib -- -D warnings
Pop-Location
bun run build:vite
git diff --check
```

Expected: every command exits 0; Rust reports 0 failed tests; Vite builds; `git diff --check` prints nothing.

- [ ] **Step 3: Audit scope**

```powershell
git status --short
git log --oneline -7
```

Expected: no replay fixtures, signing keys, tokens, generated certificates, or unrelated user changes appear in task commits.

- [ ] **Step 4: Run manual Riot smoke test when an account is available**

Close Riot Client, launch it through ValoUtils, confirm both listeners and an active relay connection, then test all bot commands and UI modes. Confirm direct, party, agent-select, and match chat. Verify public statuses from a second account. Record untested live behavior instead of claiming compatibility.

- [ ] **Step 5: Commit docs**

```powershell
git add CLAUDE.md
git commit -m "docs: document native presence relay"
```

---

## Plan Self-Review Checklist

- Tasks 1-7 cover each design requirement.
- Rust and TypeScript use the same camelCase snapshot fields.
- MUC presence and non-bot traffic pass through.
- The bot stays local.
- Secrets and generated keys stay out of storage and logs.
- Automated tests avoid Riot network access.
- Live compatibility remains a manual verification claim.
- The UI sends an anonymous mode-change analytics event and warns before closing an active relay.
