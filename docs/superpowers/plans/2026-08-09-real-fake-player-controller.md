# Real FakePlayer Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local dummy-bot simulator with one Deceive-style FakePlayer whose roster entry, commands, replies, state, and transcript all flow through the Riot XMPP relay.

**Architecture:** `presence_proxy::PresenceController` becomes the source of truth for enabled/mode/MUC state and broadcasts a complete masking state to every relay connection. A focused `fake_player` module owns the stable identity and bounded real transcript; `xml` remains pure stanza parsing/serialization, and `relay` performs routing. The Tauri page becomes a read-only diagnostic surface.

**Tech Stack:** Rust 2021, Tokio broadcast/TLS relay, Tauri commands/events, React 19, TypeScript 6, Tailwind CSS 4.

## Global Constraints

- Bot-directed XMPP stanzas must never reach Riot upstream.
- Upstream Riot TLS remains hostname-verified; local TLS continues using the validated cached Deceive PFX.
- Commands are case-insensitive and accept an optional `$` prefix.
- Supported commands are `online`, `offline`, `mobile`, `enable`, `disable`, `status`, and `help`.
- Unknown body-bearing messages return the complete help text; bodyless stanzas are consumed silently.
- The local simulator, its fabricated friends/messages, and its mutation controls are removed.
- Existing dirty-worktree changes outside the named files must not be staged, reverted, or reformatted.

---

### Task 1: Pure FakePlayer command protocol and real transcript

**Files:**
- Create: `src-tauri/src/fake_player.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/presence_proxy/xml.rs`
- Delete: `src-tauri/src/dummy_bot.rs`

**Interfaces:**
- Produces: `FakePlayerCommand`, `parse_command(&str) -> FakePlayerCommand`, `help_text() -> &'static str`, `record_user_message`, `record_bot_message`, `messages() -> Vec<FakePlayerMessage>`, `PUUID`, `GAME_NAME`, and `TAG_LINE`.
- Consumes: no Tauri state; transcript entries use `crate::util_time` for timestamps.

- [ ] **Step 1: Write failing command and transcript tests**

Add tests in `fake_player.rs` that require optional prefixes, unknown-help fallback, silent protocol consumption to remain in `xml`, and a 200-entry bounded transcript:

```rust
#[test]
fn parses_controller_commands_with_optional_prefix() {
    assert_eq!(parse_command("$offline"), FakePlayerCommand::Offline);
    assert_eq!(parse_command(" MOBILE "), FakePlayerCommand::Mobile);
    assert_eq!(parse_command("enable"), FakePlayerCommand::Enable);
    assert_eq!(parse_command("$disable"), FakePlayerCommand::Disable);
    assert_eq!(parse_command("status"), FakePlayerCommand::Status);
    assert_eq!(parse_command("help"), FakePlayerCommand::Help);
    assert_eq!(parse_command("hello"), FakePlayerCommand::Help);
}

#[test]
fn transcript_contains_real_user_and_bot_messages_and_is_bounded() {
    clear_messages();
    record_user_message("$offline");
    record_bot_message("You are now appearing offline.");
    for index in 0..205 { record_bot_message(&format!("reply-{index}")); }
    let entries = messages();
    assert_eq!(entries.len(), 200);
    assert!(entries.iter().any(|entry| entry.body == "You are now appearing offline."));
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `cargo test fake_player::tests --lib`

Expected: compilation fails because `fake_player` and its API do not exist.

- [ ] **Step 3: Implement the focused module**

Move only the identity constants from `dummy_bot.rs`; define:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakePlayerCommand { Online, Offline, Mobile, Enable, Disable, Status, Help }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FakePlayerMessage {
    pub id: String,
    pub body: String,
    pub timestamp: String,
    pub is_self: bool,
}

pub fn parse_command(body: &str) -> FakePlayerCommand {
    match body.trim().trim_start_matches('$').to_ascii_lowercase().as_str() {
        "online" => FakePlayerCommand::Online,
        "offline" => FakePlayerCommand::Offline,
        "mobile" => FakePlayerCommand::Mobile,
        "enable" => FakePlayerCommand::Enable,
        "disable" => FakePlayerCommand::Disable,
        "status" => FakePlayerCommand::Status,
        "help" => FakePlayerCommand::Help,
        _ => FakePlayerCommand::Help,
    }
}

pub fn help_text() -> &'static str {
    "Commands: online, offline, mobile, enable, disable, status, help"
}
```

Back transcript storage with `OnceLock<Mutex<VecDeque<FakePlayerMessage>>>`, allocate monotonic ids with `AtomicU64`, and remove the oldest entry after 200 messages. Replace `crate::dummy_bot::*` identity references in `xml.rs` with `crate::fake_player::*`. Register `mod fake_player` and remove `mod dummy_bot` in `lib.rs`.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
cargo test fake_player::tests --lib
cargo test presence_proxy::xml::tests --lib
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the isolated protocol change**

```powershell
git add src-tauri/src/fake_player.rs src-tauri/src/dummy_bot.rs src-tauri/src/lib.rs src-tauri/src/presence_proxy/xml.rs
git commit -m "refactor: replace dummy simulator with fakeplayer protocol"
```

### Task 2: Deceive-style controller state and persistence

**Files:**
- Modify: `src-tauri/src/presence_proxy/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/presence.rs`
- Test: inline Rust tests in `presence_proxy/mod.rs` and `commands/presence.rs`

**Interfaces:**
- Produces: `MaskingState { enabled, mode, connect_to_muc }`, `set_mode`, `set_enabled`, `set_connect_to_muc`, `apply_command(FakePlayerCommand) -> String`, and `subscribe_state() -> broadcast::Receiver<MaskingState>`.
- Consumes: `crate::fake_player::{FakePlayerCommand, help_text}` and `ConfigStore` through the attached Tauri handle.

- [ ] **Step 1: Write failing controller tests**

```rust
#[test]
fn status_commands_enable_masking_and_broadcast_complete_state() {
    let controller = PresenceController::new(false, PresenceMode::Offline, true);
    let mut updates = controller.subscribe_state();
    assert_eq!(controller.apply_command(FakePlayerCommand::Mobile), "You are now appearing mobile.");
    assert!(controller.snapshot().enabled);
    assert_eq!(controller.snapshot().mode, PresenceMode::Mobile);
    assert_eq!(updates.try_recv().unwrap().mode, PresenceMode::Mobile);
}

#[test]
fn disable_passes_original_presence_through() {
    let controller = PresenceController::new(true, PresenceMode::Offline, true);
    assert_eq!(controller.apply_command(FakePlayerCommand::Disable), "Presence masking is now disabled.");
    assert!(!controller.snapshot().enabled);
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test presence_proxy::tests --lib`

Expected: compilation fails because the complete state and command methods are absent.

- [ ] **Step 3: Implement state, persistence, and shared command handling**

Extend serialized `PresenceSnapshot` with `enabled` and `connect_to_muc`. Replace the mode-only sender with `broadcast::Sender<MaskingState>`. Implement one internal `persist_and_emit()` path that stores `presenceEnabled`, `presenceMode`, and `presenceMucEnabled`, then emits `presence:status-changed`. `apply_command` must return exact replies:

```rust
match command {
    Online => { self.set_mode_and_enable(PresenceMode::Online); "You are now appearing online." }
    Offline => { self.set_mode_and_enable(PresenceMode::Offline); "You are now appearing offline." }
    Mobile => { self.set_mode_and_enable(PresenceMode::Mobile); "You are now appearing mobile." }
    Enable => { self.set_enabled(true); "Presence masking is now enabled." }
    Disable => { self.set_enabled(false); "Presence masking is now disabled." }
    Status => return format!("Masking: {}. Status: {}.", if self.enabled() { "enabled" } else { "disabled" }, self.mode().as_str()),
    Help => return crate::fake_player::help_text().into(),
}
```

Add defaults in `lib.rs`: `presenceEnabled=true`, `presenceMode="offline"`, `presenceStartup="last"`, `presenceMucEnabled=true`, and initialize the controller from them. Extend `presence_status_set(args)` without duplicating controller logic. A first argument of `online`, `offline`, or `mobile` selects and enables that mode; `enable` and `disable` toggle masking; `muc` requires a boolean second argument; `startup` requires a second argument in `online|offline|mobile|last`. Persist `presenceStartup` when that action is selected. During setup, select an explicit startup mode when configured, otherwise load the last persisted `presenceMode`.

- [ ] **Step 4: Run and verify GREEN**

Run:

```powershell
cargo test presence_proxy::tests --lib
cargo test commands::presence::tests --lib
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit controller state**

```powershell
git add src-tauri/src/presence_proxy/mod.rs src-tauri/src/lib.rs src-tauri/src/commands/presence.rs
git commit -m "feat: add deceive style presence controller state"
```

### Task 3: Route real in-game commands and updates across relay connections

**Files:**
- Modify: `src-tauri/src/presence_proxy/xml.rs`
- Modify: `src-tauri/src/presence_proxy/relay.rs`
- Test: inline Rust tests in both files

**Interfaces:**
- Produces: `BotStanza::Command { jid, body } | Consume`, `is_muc_presence(&str) -> bool`, and relay use of `MaskingState` broadcasts.
- Consumes: Task 1 command/transcript API and Task 2 controller API.

- [ ] **Step 1: Write failing routing tests**

Add pure XML tests requiring a body to be returned without pre-parsing command policy, and add a pure relay decision helper test:

```rust
#[test]
fn classifies_fakeplayer_body_and_consumes_protocol_stanzas() {
    let jid = format!("{}@na1.pvp.net", crate::fake_player::PUUID);
    assert_eq!(classify_bot_stanza(&format!(r#"<message to="{jid}"><body>$disable</body></message>"#)).unwrap(), Some(BotStanza::Command { jid: jid.clone(), body: "$disable".into() }));
    assert_eq!(classify_bot_stanza(&format!(r#"<message to="{jid}"><received id="1"/></message>"#)).unwrap(), Some(BotStanza::Consume));
}

#[test]
fn disabled_masking_forwards_original_presence() {
    let original = "<presence><show>chat</show></presence>";
    assert_eq!(presence_for_state(original, MaskingState { enabled: false, mode: PresenceMode::Offline, connect_to_muc: true }).unwrap(), Some(original.into()));
}
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
cargo test presence_proxy::xml::tests --lib
cargo test presence_proxy::relay::tests --lib
```

Expected: compilation fails because `BotStanza`, `classify_bot_stanza`, and `presence_for_state` do not exist.

- [ ] **Step 3: Implement local routing**

In `client_to_remote`, classify any frame containing the FakePlayer PUUID before all other forwarding. For a command:

```rust
crate::fake_player::record_user_message(&body);
let command = crate::fake_player::parse_command(&body);
let reply = crate::presence_proxy::controller().apply_command(command);
crate::fake_player::record_bot_message(&reply);
write_frame(&local_write, bot_reply(&jid, &reply, next_reply_id()).as_bytes()).await?;
continue;
```

For `Consume`, immediately continue without writing upstream. Subscribe each connection to `MaskingState`, retain the untouched latest global presence, and resend `presence_for_state` on each update. When the state is disabled, send the untouched presence. When MUC forwarding is disabled, consume presence stanzas whose `to` domain contains `@ares-parties.` or the MUC namespace.

After roster insertion, emit the FakePlayer presence and a one-time welcome message containing the help text. Preserve the extracted `partyClientVersion` update behavior.

- [ ] **Step 4: Run and verify GREEN**

Run: `cargo test presence_proxy --lib`

Expected: every presence-proxy test passes; the live PFX test remains ignored in the normal run.

- [ ] **Step 5: Commit relay routing**

```powershell
git add src-tauri/src/presence_proxy/xml.rs src-tauri/src/presence_proxy/relay.rs
git commit -m "feat: control presence from in game fakeplayer chat"
```

### Task 4: Remove simulator API injection and expose read-only diagnostics

**Files:**
- Create: `src-tauri/src/commands/fake_player.rs`
- Delete: `src-tauri/src/commands/dummy_bot.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src-tauri/src/commands/friends.rs`
- Modify: `src-tauri/src/commands/app.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/pages/DummyBot.tsx`
- Modify: `src/main.tsx`
- Modify: `src/pages/Settings.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`

**Interfaces:**
- Produces: Tauri command `fake_player_state() -> Result<String, ()>` returning `{ success, displayName, messages, presence }`.
- Consumes: Task 1 transcript and Task 2 `PresenceSnapshot`.

- [ ] **Step 1: Write failing Rust diagnostics test**

```rust
#[test]
fn snapshot_contains_real_transcript_and_no_simulator_friend() {
    crate::fake_player::clear_messages();
    crate::fake_player::record_user_message("status");
    let value = snapshot_value();
    assert_eq!(value["messages"][0]["body"], "status");
    assert!(value.get("friend").is_none());
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test commands::fake_player::tests --lib`

Expected: compilation fails because the new command module does not exist.

- [ ] **Step 3: Implement the read-only backend and remove synthetic injection**

Create only `fake_player_state`; do not create send/reset commands. Remove all `dummy_bot::friend_entry`, `chat_friend_entry`, `messages`, and `handle` branches from `friends.rs` and `chat.rs`. Remove `dummyBot` from application config output/defaults and remove the old command registrations.

- [ ] **Step 4: Remove frontend controls and simulator gating**

Make the diagnostic page visible without the `dummyBot` setting. Replace `dummy_bot:*` listeners with a two-second `fake_player:state` poll. Delete `draft`, `busy`, `send`, reset, quick-command buttons, input, fake rank/state/score cards, and `FaPaperPlane`/`FaRotateLeft` imports. Render only relay status, masking state, connection warning, and the real transcript. If `activeConnections === 0`, render the translated message: `Launch Riot through the ValoUtils proxy to chat with FakePlayer in game.`

Remove the Dummy Bot toggle from Settings. Add controller-backed settings for masking enabled, startup preference (`online`, `offline`, `mobile`, `remember last`), and lobby/MUC forwarding. These controls call `presence:status-set` with the Task 2 action arguments and update from `presence:status-changed`; they must not write controller keys directly through `config:set`. Rename navigation and page copy to `FakePlayer` / `In-game FakePlayer` in all three locale files.

- [ ] **Step 5: Verify backend and frontend**

Run:

```powershell
cargo test commands::fake_player::tests --lib
cargo test commands::chat::tests --lib
cargo test commands::friends::tests --lib
bun run build:vite
bun run lint
```

Expected: Rust selections pass; TypeScript/Vite build passes; ESLint reports zero warnings.

- [ ] **Step 6: Commit simulator removal**

```powershell
git add src-tauri/src/commands src-tauri/src/lib.rs src-tauri/src/commands/chat.rs src-tauri/src/commands/friends.rs src-tauri/src/commands/app.rs src/pages/DummyBot.tsx src/main.tsx src/pages/Settings.tsx src/i18n/locales
git commit -m "feat: replace local bot simulator with relay diagnostics"
```

### Task 5: Final integration verification

**Files:**
- Verify only; modify scoped files only if a verification failure traces to this feature.

**Interfaces:**
- Consumes all previous tasks.
- Produces a verified controller/FakePlayer implementation.

- [ ] **Step 1: Run formatting and scoped tests**

```powershell
cargo fmt --check
cargo test presence_proxy --lib
cargo test fake_player::tests --lib
cargo test commands::fake_player::tests --lib
cargo test commands::presence::tests --lib
cargo check
```

Expected: formatting succeeds; all selected tests pass; production Windows compilation succeeds with no new warnings attributable to these files.

- [ ] **Step 2: Run live PFX validation**

Run: `cargo test presence_proxy::local_ca::tests::downloads_and_parses_the_default_pfx --lib -- --ignored --nocapture`

Expected: one live test passes and confirms download, Windows import, hostname, validity, and server-auth usage.

- [ ] **Step 3: Run frontend verification**

```powershell
bun run build:vite
bun run lint
```

Expected: both commands succeed.

- [ ] **Step 4: Check scoped diff and secrets**

```powershell
git diff --check
rg -n "BEGIN (RSA |EC )?PRIVATE KEY|server\.key|server\.crt|accessToken|entitlements" src-tauri/src/fake_player.rs src-tauri/src/presence_proxy src-tauri/src/commands/fake_player.rs src/pages/DummyBot.tsx
```

Expected: no scoped whitespace errors and no embedded secret/certificate material.
