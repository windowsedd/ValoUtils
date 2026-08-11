# Chat Realtime Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stale REST-derived Chat friend liveness with realtime XMPP resource presence across Riot Client, League of Legends, and VALORANT.

**Architecture:** A pure Rust presence parser/reducer converts Riot XMPP roster and presence stanzas into a generation-scoped snapshot. The existing XMPP connection publishes snapshots through the Chat backend and a `chat:presence` Tauri event; React overlays those snapshots onto its REST-backed friend metadata immediately.

**Tech Stack:** Rust, Tokio broadcast channels, `xmltree`, Tauri 2 events, React 19, TypeScript 6, Bun tests, i18next.

## Global Constraints

- XMPP is the sole authority for Online/Offline after the initial roster sync.
- REST presence may enrich only a resource already confirmed active by XMPP; it cannot establish liveness.
- Supported Online products are Riot Client/Keystone, League of Legends, and VALORANT.
- Presence is tracked per friend and XMPP resource; only removal of the final supported resource makes a friend Offline.
- Initial state is `syncing`; a lost XMPP connection is `reconnecting`; neither may display stale Online state as confirmed.
- Party, Team, All, direct-message history, and direct-message sending behavior must remain unchanged.
- Do not add an inactivity-based Offline timeout.
- Use existing dependencies; do not add a second XMPP or Riot local WebSocket connection.

---

## File Structure

- Create `src-tauri/src/xmpp/presence.rs`: pure XMPP presence XML parsing, supported-product normalization, resource reducer, sync snapshot types, and unit tests.
- Modify `src-tauri/src/xmpp/client.rs`: publish parsed roster/presence/disconnect signals from the existing socket read loop.
- Modify `src-tauri/src/xmpp/mod.rs`: own connection generations, initial-settle lifecycle, presence snapshots, and explicit Chat connection startup.
- Modify `src-tauri/src/commands/chat.rs`: merge friend metadata with the authoritative XMPP snapshot and forward `chat:presence` events.
- Modify `src/types/chat.ts`: define sync state, presence update, and response/event contracts.
- Modify `src/pages/chat/chat-model.ts`: resolve syncing/reconnecting labels and apply pushed snapshots to current friends.
- Modify `src/pages/chat/use-chat-controller.ts`: subscribe to and clean up `chat:presence` with the existing IPC lifecycle.
- Modify `src/pages/Chat.tsx`: provide localized Checking/Reconnecting labels.
- Modify `src/pages/chat/chat-friends-panel.tsx`: render non-authoritative sync states without a green Online indicator.
- Modify `src/i18n/locales/en.json`, `src/i18n/locales/zh-TW.json`, and `src/i18n/locales/ko.json`: add Checking/Reconnecting copy.
- Modify `src/pages/chat/chat-model.test.ts`, `src/pages/chat/use-chat-controller.test.ts`, and `src/pages/chat/chat-components.test.tsx`: verify event overlay, status priority, listener cleanup, and visible copy.

---

### Task 1: Pure XMPP Presence Parser and Resource Reducer

**Files:**
- Create: `src-tauri/src/xmpp/presence.rs`
- Modify: `src-tauri/src/xmpp/mod.rs`

**Interfaces:**
- Produces: `parse_presence_signals(xml: &str, generation: u64) -> Vec<PresenceSignal>`
- Produces: `PresenceSignal::{RosterReceived, Available, Unavailable, Disconnected}`
- Produces: `PresenceReducer::{begin_generation, apply, mark_ready, snapshot}`
- Produces: serializable `PresenceSnapshot { state, generation, friends }`

- [ ] **Step 1: Add failing parser tests with Riot-shaped XML**

Add a `#[cfg(test)]` module to the new file with fixtures that use the same `<games>` layout already exercised by `presence_proxy/xml.rs`:

```rust
#[test]
fn parses_supported_resources_and_valorant_state() {
    let private = base64::engine::general_purpose::STANDARD.encode(
        r#"{"matchPresenceData":{"sessionLoopState":"INGAME"}}"#,
    );
    let xml = format!(r#"<presence from="friend@jp1.pvp.net/RC-1"><show>chat</show><status>ready</status><games><keystone><st>chat</st><s.p>keystone</s.p></keystone><league_of_legends><st>chat</st><s.p>league_of_legends</s.p></league_of_legends><valorant><st>chat</st><s.p>valorant</s.p><p>{private}</p></valorant></games></presence>"#);
    let events = parse_presence_signals(&xml, 7);
    let resources: Vec<_> = events.iter().filter_map(|event| match event {
        PresenceSignal::Available { resource, .. } => Some(resource),
        _ => None,
    }).collect();
    assert_eq!(resources.iter().map(|item| item.product.as_str()).collect::<Vec<_>>(), vec!["riot_client", "league_of_legends", "valorant"]);
    assert_eq!(resources.last().map(|item| item.session_loop_state.as_str()), Some("INGAME"));
}

#[test]
fn parses_unavailable_for_one_resource_and_roster_completion() {
    let xml = r#"<iq type="result"><query xmlns="jabber:iq:riotgames:roster"><item jid="friend@jp1.pvp.net" puuid="friend"/></query></iq><presence from="friend@jp1.pvp.net/RC-1" type="unavailable"/>"#;
    assert!(matches!(parse_presence_signals(xml, 3)[0], PresenceSignal::RosterReceived { .. }));
    assert!(matches!(parse_presence_signals(xml, 3)[1], PresenceSignal::Unavailable { .. }));
}
```

- [ ] **Step 2: Run the parser tests and verify they fail**

Run: `cargo test xmpp::presence::tests::parses_ --lib` from `src-tauri`.

Expected: FAIL because `xmpp::presence` and its interfaces do not exist.

- [ ] **Step 3: Implement the parser and serialized contracts**

Use `xmltree::Element` instead of extending the hand-written message parser. Implement these exact public contracts:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceSyncState { Syncing, Ready, Reconnecting }

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendPresenceResource {
    pub puuid: String,
    pub resource: String,
    pub product: String,
    pub status: String,
    pub status_message: String,
    pub session_loop_state: String,
    pub private: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PresenceSignal {
    RosterReceived { generation: u64, friends: HashSet<String> },
    Available { generation: u64, resource: FriendPresenceResource },
    Unavailable { generation: u64, puuid: String, resource: String },
    Disconnected { generation: u64 },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshot {
    pub state: PresenceSyncState,
    pub generation: u64,
    pub friends: HashMap<String, Vec<FriendPresenceResource>>,
}
```

Parse every supported child under `<games>` as a separate `FriendPresenceResource` sharing the raw JID resource name. Normalize `keystone` to `riot_client`; preserve `league_of_legends` and `valorant`. Decode VALORANT `<p>` as base64 JSON and read `matchPresenceData.sessionLoopState`. Split concatenated top-level stanzas by wrapping the fragment in `<root>...</root>` before `xmltree::Element::parse`.

If an incoming presence/roster fragment is malformed, log one diagnostic at debug level and return an empty event list. Parsing failure must not terminate the socket read loop or suppress group-chat message handling.

- [ ] **Step 4: Add failing reducer tests for multi-resource and generations**

```rust
#[test]
fn removes_only_the_unavailable_resource() {
    let mut reducer = PresenceReducer::default();
    reducer.begin_generation(4);
    reducer.apply(available(4, "friend", "RC-1", "riot_client"));
    reducer.apply(available(4, "friend", "VAL-2", "valorant"));
    reducer.apply(PresenceSignal::Unavailable {
        generation: 4, puuid: "friend".into(), resource: "RC-1".into(),
    });
    assert_eq!(reducer.snapshot().friends["friend"].len(), 1);
}

#[test]
fn ignores_old_generation_and_invalidates_on_disconnect() {
    let mut reducer = PresenceReducer::default();
    reducer.begin_generation(9);
    reducer.apply(available(8, "friend", "old", "valorant"));
    assert!(reducer.snapshot().friends.is_empty());
    reducer.apply(available(9, "friend", "new", "valorant"));
    reducer.apply(PresenceSignal::Disconnected { generation: 9 });
    assert_eq!(reducer.snapshot().state, PresenceSyncState::Reconnecting);
    assert!(reducer.snapshot().friends.is_empty());
}
```

- [ ] **Step 5: Run reducer tests and verify they fail**

Run: `cargo test xmpp::presence::tests --lib` from `src-tauri`.

Expected: parser tests PASS; reducer tests FAIL because `PresenceReducer` is missing.

- [ ] **Step 6: Implement the reducer**

Store resources as `HashMap<(String, String, String), FriendPresenceResource>`, where the tuple is `(puuid, raw_resource, product)`. `apply` must ignore a generation different from `self.generation`; `Unavailable` removes every product with the same PUUID and raw resource; `Disconnected` clears resources and sets `Reconnecting`. `mark_ready(generation)` changes only the current generation to `Ready`. `snapshot()` groups and sorts resources deterministically by product and resource.

- [ ] **Step 7: Run focused tests and commit**

Run: `cargo test xmpp::presence::tests --lib` from `src-tauri`.

Expected: all presence parser/reducer tests PASS.

Commit:

```bash
git add src-tauri/src/xmpp/presence.rs src-tauri/src/xmpp/mod.rs
git commit -m "feat: parse realtime XMPP friend presence"
```

---

### Task 2: Connect the Existing XMPP Session to Presence State

**Files:**
- Modify: `src-tauri/src/xmpp/client.rs`
- Modify: `src-tauri/src/xmpp/mod.rs`
- Test: `src-tauri/src/xmpp/client.rs`

**Interfaces:**
- Consumes: `PresenceSignal`, `PresenceReducer`, and `PresenceSnapshot` from Task 1.
- Produces: `ensure_connected(riot: &RiotState) -> Result<(), String>`
- Produces: `presence_snapshot() -> PresenceSnapshot`
- Produces: `subscribe_presence() -> broadcast::Receiver<PresenceSnapshot>`

- [ ] **Step 1: Write failing stanza-dispatch and explicit-connect source tests**

Extend the client unit tests so one mixed read buffers a group message and publishes presence signals, and add a module test asserting a Chat-only connection enters `Syncing` without joining a MUC:

```rust
#[test]
fn incoming_presence_is_published_without_affecting_group_messages() {
    let (presence_tx, mut presence_rx) = broadcast::channel(8);
    handle_incoming_stanza(
        r#"<presence from="friend@jp1/RC-1"><show>chat</show><games><keystone><st>chat</st></keystone></games></presence>"#,
        &messages, &message_tx, &presence_tx, 5, "self", "Self#1",
    );
    assert!(matches!(presence_rx.try_recv().unwrap(), PresenceSignal::Available { generation: 5, .. }));
    assert!(messages.lock().unwrap().is_empty());
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run `cargo test xmpp::client::tests --lib`, then `cargo test xmpp::tests --lib`, from `src-tauri`.

Expected: FAIL because the client has no presence publisher/generation and `ensure_connected` is absent.

- [ ] **Step 3: Thread presence signals through the existing login and reader**

Change `client::login` and `run_background` to accept `generation: u64` and `broadcast::Sender<PresenceSignal>`. In `handle_incoming_stanza`, call `parse_presence_signals(stanza, generation)` and publish each result before processing group messages. When the loop exits, publish exactly one `PresenceSignal::Disconnected { generation }` before marking the handle dead.

Keep the existing message signatures and buffering behavior otherwise unchanged.

- [ ] **Step 4: Add the singleton presence runtime and initial-settle loop**

In `xmpp/mod.rs`, add a runtime containing an atomic generation counter, `std::sync::Mutex<PresenceReducer>`, a signal broadcast sender, and a snapshot broadcast sender. Start one reducer task with `OnceLock`/an atomic guard. Its loop must:

```rust
match signal {
    PresenceSignal::RosterReceived { generation, .. } => {
        reducer.apply(signal);
        settle_generation = Some(generation);
        settle_deadline = Some(Instant::now() + Duration::from_millis(500));
    }
    PresenceSignal::Available { generation, .. } if reducer.state() == PresenceSyncState::Syncing => {
        reducer.apply(signal);
        if settle_generation == Some(generation) {
            settle_deadline = Some(Instant::now() + Duration::from_millis(500));
        }
    }
    _ => reducer.apply(signal),
}
```

On the deadline, call `mark_ready(generation)` and publish the complete snapshot. Publish immediate snapshots for later Available/Unavailable/Disconnected events. A new login must increment the generation and call `begin_generation` before the socket is created.

- [ ] **Step 5: Expose Chat-only connection startup**

Add:

```rust
pub async fn ensure_connected(riot: &RiotState) -> Result<(), String> {
    let mut inner = STATE.get_or_init(Default::default).inner.lock().await;
    login_xmpp(riot, &mut inner).await.map(|_| ())
}

pub fn presence_snapshot() -> PresenceSnapshot { runtime().snapshot() }
pub fn subscribe_presence() -> broadcast::Receiver<PresenceSnapshot> { runtime().subscribe() }
```

Do not join party or match rooms from `ensure_connected`. Continue reusing the same live handle when party/match functions run.

- [ ] **Step 6: Run XMPP tests and commit**

Run: `cargo test xmpp:: --lib` from `src-tauri`.

Expected: all XMPP tests PASS, including the pre-existing group-message tests.

Commit:

```bash
git add src-tauri/src/xmpp/client.rs src-tauri/src/xmpp/mod.rs
git commit -m "feat: track live XMPP presence state"
```

---

### Task 3: Make Chat Backend Use and Push Authoritative Presence

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`

**Interfaces:**
- Consumes: `xmpp::ensure_connected`, `xmpp::presence_snapshot`, and `xmpp::subscribe_presence`.
- Produces: `chat:get` field `presenceState` on every friend.
- Produces: event `chat:presence` with serialized `PresenceSnapshot`.

- [ ] **Step 1: Add failing Chat normalization tests**

Replace REST-only expectations with explicit snapshots:

```rust
#[test]
fn ready_xmpp_snapshot_overrides_stale_rest_online() {
    let snapshot = ready_snapshot(HashMap::new());
    let result = normalize_friends(&[friend("friend")], &[stale_rest_presence("friend")], &snapshot);
    assert_eq!(result[0]["presenceState"], "ready");
    assert_eq!(result[0]["isOnline"], false);
}

#[test]
fn live_xmpp_resource_can_use_matching_rest_details() {
    let snapshot = ready_snapshot(resources("friend", "valorant", "INGAME"));
    let result = normalize_friends(&[friend("friend")], &[], &snapshot);
    assert_eq!(result[0]["isOnline"], true);
    assert_eq!(result[0]["sessionLoopState"], "INGAME");
}

#[test]
fn syncing_snapshot_never_confirms_stale_online() {
    let result = normalize_friends(&[friend("friend")], &[stale_rest_presence("friend")], &syncing_snapshot());
    assert_eq!(result[0]["presenceState"], "syncing");
    assert_eq!(result[0]["isOnline"], false);
}
```

- [ ] **Step 2: Run focused Chat Rust tests and verify they fail**

Run: `cargo test commands::chat::tests --lib` from `src-tauri`.

Expected: FAIL because `normalize_friends` does not accept a live snapshot and does not emit `presenceState`.

- [ ] **Step 3: Refactor friend normalization around the XMPP snapshot**

Change the signature to:

```rust
fn normalize_friends(
    friends_payload: &[Value],
    rest_presences_payload: &[Value],
    live: &xmpp::presence::PresenceSnapshot,
) -> Vec<Value>
```

For each friend, select only resources in `live.friends[id_root(puuid)]`. Rank VALORANT above League above Riot Client for displayed details, but compute `isOnline` as `live.state == Ready && !resources.is_empty()`. Set `presenceState` from the snapshot. Decode current XMPP private data first; use a REST record only when its PUUID and normalized product match the selected live resource. Sort confirmed Online friends first only while `Ready`.

- [ ] **Step 4: Start XMPP and forward snapshot events**

Generalize `ensure_chat_message_forwarder` into `ensure_chat_forwarders`. Keep the existing `chat:message` loop and add one `xmpp::subscribe_presence()` loop that emits `app.emit("chat:presence", serde_json::to_string(&snapshot)?)`. Use separate atomic guards or one initializer that starts both exactly once.

At the beginning of `chat_get`, call `xmpp::ensure_connected(&riot).await?`, then obtain `let presence = xmpp::presence_snapshot();` and pass it to `normalize_friends`. Do this before party/match room discovery so Chat-only usage always owns a live session.

- [ ] **Step 5: Run backend tests and commit**

Run `cargo test commands::chat::tests --lib`, then `cargo test xmpp:: --lib`, from `src-tauri`.

Expected: all focused backend tests PASS.

Commit:

```bash
git add src-tauri/src/commands/chat.rs
git commit -m "feat: expose authoritative chat presence"
```

---

### Task 4: Apply Presence Events Immediately in React

**Files:**
- Modify: `src/types/chat.ts`
- Modify: `src/pages/chat/chat-model.ts`
- Modify: `src/pages/chat/chat-model.test.ts`
- Modify: `src/pages/chat/use-chat-controller.ts`
- Modify: `src/pages/chat/use-chat-controller.test.ts`

**Interfaces:**
- Consumes: backend `chat:presence` snapshot from Task 3.
- Produces: `applyPresenceSnapshot(friends, snapshot) -> ChatFriend[]`.
- Produces: `FriendGameStatus` values `checking` and `reconnecting`.

- [ ] **Step 1: Write failing TypeScript model tests**

```ts
test("sync state has priority over stale online data", () => {
  expect(resolveFriendGameStatus({ ...friend, presenceState: "syncing", isOnline: true })).toBe("checking");
  expect(resolveFriendGameStatus({ ...friend, presenceState: "reconnecting", isOnline: true })).toBe("reconnecting");
});

test("applies a ready snapshot and offlines absent friends", () => {
  const result = applyPresenceSnapshot([friend, { ...friend, puuid: "offline" }], {
    state: "ready", generation: 2,
    friends: { [friend.puuid]: [{ puuid: friend.puuid, resource: "RC-1:valorant", product: "valorant", status: "chat", statusMessage: "", sessionLoopState: "INGAME", private: {} }] },
  });
  expect(result[0]).toMatchObject({ presenceState: "ready", isOnline: true, sessionLoopState: "INGAME" });
  expect(result[1]).toMatchObject({ presenceState: "ready", isOnline: false });
});
```

- [ ] **Step 2: Run the model tests and verify they fail**

Run: `bun test src/pages/chat/chat-model.test.ts`.

Expected: FAIL because the new types, status keys, and overlay function do not exist.

- [ ] **Step 3: Add frontend contracts and pure overlay logic**

Add exact types to `src/types/chat.ts`:

```ts
export type ChatPresenceState = "syncing" | "ready" | "reconnecting";
export type ChatPresenceResource = Pick<ChatFriend, "puuid" | "product" | "status" | "statusMessage" | "sessionLoopState"> & { resource: string; private: unknown };
export type ChatPresenceSnapshot = { state: ChatPresenceState; generation: number; friends: Record<string, ChatPresenceResource[]> };
```

Add `presenceState: ChatPresenceState` to `ChatFriend`. Add `checking` and `reconnecting` to `FriendGameStatus`; resolve them before `isOnline`. Implement `applyPresenceSnapshot` with case-insensitive PUUID matching, VALORANT > League > Riot Client display priority, and `isOnline: snapshot.state === "ready" && resources.length > 0`. When state is not `ready`, clear `sessionLoopState` and force `isOnline` false.

- [ ] **Step 4: Add the failing IPC lifecycle assertions**

In `use-chat-controller.test.ts`, assert:

```ts
expect(source).toContain('window.Main.on("chat:presence", onPresence)');
expect(source).toContain('window.Main.removeListener("chat:presence", onPresence)');
expect(source).toContain("friends: applyPresenceSnapshot(current.friends, snapshot)");
```

Run: `bun test src/pages/chat/use-chat-controller.test.ts`.

Expected: FAIL because no presence listener exists.

- [ ] **Step 5: Subscribe and update friend state in place**

In the controller effect, parse `ChatPresenceSnapshot`, reject missing `state`/`generation`, and update only friends:

```ts
const onPresence = (payload: string) => {
  const snapshot = parsePayload<ChatPresenceSnapshot>(payload);
  if (!snapshot?.state || !Number.isFinite(snapshot.generation)) return;
  setSummary((current) => ({
    ...current,
    friends: applyPresenceSnapshot(current.friends, snapshot),
  }));
};
```

Register and remove the exact same callback beside `chat:message`. Do not select a conversation or request history in response to presence.

- [ ] **Step 6: Run model/controller tests and commit**

Run: `bun test src/pages/chat/chat-model.test.ts src/pages/chat/use-chat-controller.test.ts`.

Expected: all focused TypeScript tests PASS.

Commit:

```bash
git add src/types/chat.ts src/pages/chat/chat-model.ts src/pages/chat/chat-model.test.ts src/pages/chat/use-chat-controller.ts src/pages/chat/use-chat-controller.test.ts
git commit -m "feat: apply realtime presence in chat"
```

---

### Task 5: Render Checking and Reconnecting States

**Files:**
- Modify: `src/pages/Chat.tsx`
- Modify: `src/pages/chat/chat-friends-panel.tsx`
- Modify: `src/pages/chat/chat-components.test.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/ko.json`

**Interfaces:**
- Consumes: `FriendGameStatus` and `ChatFriend.presenceState` from Task 4.
- Produces: localized visible `Checking...` and `Reconnecting...` states.

- [ ] **Step 1: Write failing component assertions**

Render a syncing conversation and friends panel, then assert it does not claim Online:

```tsx
expect(renderToStaticMarkup(<ChatConversationList
  conversations={[{ ...conversation, statusKey: "checking" }]}
  statusLabels={{ ...statusLabels, checking: "Checking...", reconnecting: "Reconnecting..." }}
  {...listProps}
/>)).toContain("Checking...");

expect(renderFriendsPanel({ ...friend, presenceState: "reconnecting", isOnline: false }))
  .toContain("Reconnecting...");
```

- [ ] **Step 2: Run component tests and verify they fail**

Run: `bun test src/pages/chat/chat-components.test.tsx`.

Expected: FAIL because labels and friends-panel rendering do not support the new states.

- [ ] **Step 3: Add localized labels and sync-safe indicators**

Add these locale values under `friends`:

```json
// en
"checking": "Checking...", "reconnecting": "Reconnecting..."
// zh-TW
"checking": "正在確認…", "reconnecting": "重新連線中…"
// ko
"checking": "확인 중...", "reconnecting": "다시 연결 중..."
```

Extend `friendStatusLabels` in `Chat.tsx`. Pass the same labels into `ChatFriendsPanel`. In the friends panel, use `resolveFriendGameStatus(friend)` for visible status and accessibility text. Use emerald only for ready Online resources, gray for ready Offline, and amber for syncing/reconnecting. Do not render a stale `statusMessage` while the state is not ready.

- [ ] **Step 4: Run focused UI tests and commit**

Run: `bun test src/pages/chat/chat-components.test.tsx src/pages/chat/chat-model.test.ts`.

Expected: all focused UI tests PASS.

Commit:

```bash
git add src/pages/Chat.tsx src/pages/chat/chat-friends-panel.tsx src/pages/chat/chat-components.test.tsx
git commit -m "feat: show chat presence sync states"
```

The locale files already contain unrelated user edits. Stage only the six newly added `checking`/`reconnecting` key-value lines with a narrow cached patch, verify them with `git diff --cached -- src/i18n/locales`, and include those exact hunks in this commit. Never stage the complete locale files.

---

### Task 6: Regression and Live Verification

**Files:**
- Modify only if a verification failure identifies a defect in the files owned by Tasks 1–5.

**Interfaces:**
- Consumes: the complete backend/frontend realtime presence flow.
- Produces: test and live evidence that stale REST records no longer control Chat liveness.

- [ ] **Step 1: Run focused Rust formatting and tests**

Run from `src-tauri`:

```bash
cargo fmt --check
cargo test xmpp:: --lib
cargo test commands::chat::tests --lib
cargo check
```

Expected: exit code 0 for every command.

- [ ] **Step 2: Run the full frontend suite and production build**

Run from repository root:

```bash
bun test
bun run build:vite
```

Expected: all Bun tests PASS and the Vite production build exits 0. Existing non-fatal native-config/chunk-size warnings are acceptable.

- [ ] **Step 3: Perform live Riot verification**

With Riot Client running and ValoUtils Chat open:

1. Confirm the friend list briefly shows `Checking...`, then reaches ready statuses.
2. Have a test friend sign into any agreed product and confirm Online appears from an XMPP Available event.
3. Have that friend fully exit Riot Client and confirm Offline appears after the XMPP Unavailable event without waiting for the five-second Chat poll.
4. If the friend has VALORANT plus Riot Client resources, close VALORANT only and confirm they remain Online until the final Riot resource disconnects.
5. Interrupt and restore the network; confirm `Reconnecting...` replaces confirmed status and the next generation cannot accept stale events.
6. Confirm direct, Party, Team, and All messages still send and appear immediately.

Expected: the stale `/chat/v4/presences` record may remain, but it never keeps the friend Online.

- [ ] **Step 4: Review the final diff and commit any verification-only fix**

Run:

```bash
git diff --check
git status --short
git log -6 --oneline
```

Expected: no whitespace errors; only known unrelated user files remain dirty; the realtime presence files are committed. If verification required a scoped correction, stage only the affected Task 1–5 files and commit with `fix: correct realtime chat presence`.
