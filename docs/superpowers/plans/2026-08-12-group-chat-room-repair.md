# Group Chat Room Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Party room discovery and prevent unsupported REST-history requests for Party, Team, and All chat.

**Architecture:** GLZ party details become the authoritative Party MUC source through `MUCName`. Conversation metadata explicitly distinguishes REST-backed direct chats from live-only XMPP group rooms, and the React controller consults that metadata before requesting history.

**Tech Stack:** Rust, Tauri 2, serde_json, React 19, TypeScript 6, Bun test.

## Global Constraints

- Party, Team, and All show messages observed through summary/realtime XMPP while ValoUtils is connected.
- Friend chats retain Riot Local REST history and retry behavior.
- Group-message sending remains on XMPP; direct-message sending remains on Riot Local REST.
- Existing unrelated worktree changes must remain untouched.

---

### Task 1: Party MUC discovery from GLZ party details

**Files:**
- Modify: `src-tauri/src/riot/api.rs`
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src-tauri/src/xmpp/mod.rs`
- Test: `src-tauri/src/riot/api.rs`

**Interfaces:**
- Produces: `pub fn party_muc_name(party: &Value) -> Option<&str>` extracts a non-empty `MUCName` or compatible `mucName` value.
- Consumes: existing `RiotApiClient::party_get_by_player` and `RiotApiClient::party_get` methods.

- [ ] **Step 1: Write the failing Rust tests**

Add to `src-tauri/src/riot/api.rs` tests:

```rust
#[test]
fn extracts_party_muc_name_from_party_details() {
    let party = serde_json::json!({ "MUCName": "party@ares-parties.ap" });
    assert_eq!(party_muc_name(&party), Some("party@ares-parties.ap"));
}

#[test]
fn rejects_missing_or_empty_party_muc_name() {
    assert_eq!(party_muc_name(&serde_json::json!({})), None);
    assert_eq!(party_muc_name(&serde_json::json!({ "MUCName": "" })), None);
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `cargo test riot::api::tests::extracts_party_muc_name_from_party_details riot::api::tests::rejects_missing_or_empty_party_muc_name` from `src-tauri/`.

Expected: compilation fails because `party_muc_name` does not exist.

- [ ] **Step 3: Implement the extractor**

Add to `src-tauri/src/riot/api.rs`:

```rust
pub fn party_muc_name(party: &Value) -> Option<&str> {
    party
        .get("MUCName")
        .or_else(|| party.get("mucName"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}
```

- [ ] **Step 4: Replace the removed MUC-token lookup**

In `add_party_room_from_active_party`, fetch `api.party_get(&party_id)` and insert `api::party_muc_name(&details)` when present.

In `ensure_party_xmpp_chat`, handle player and party-detail errors with `match`, write the error into `_partyXmppDebug`, extract the room with `api::party_muc_name`, and call `join_match_muc(&room, None)`. Remove the call to `party_get_chat_token` from this flow.

- [ ] **Step 5: Run focused and module tests**

Run: `cargo test riot::api::tests` and `cargo test commands::chat::tests` from `src-tauri/`.

Expected: PASS.

- [ ] **Step 6: Commit the Party repair**

```powershell
git add src-tauri/src/riot/api.rs src-tauri/src/commands/chat.rs src-tauri/src/xmpp/mod.rs
git commit -m "fix: restore party chat room discovery"
```

### Task 2: Skip REST history for XMPP-only group rooms

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src/types/chat.ts`
- Modify: `src/pages/chat/chat-model.ts`
- Modify: `src/pages/chat/chat-model.test.ts`
- Modify: `src/pages/chat/use-chat-controller.ts`

**Interfaces:**
- Produces: `ChatConversation.supportsHistory: boolean`.
- Produces: `supportsConversationHistory(conversation: ChatConversation | null | undefined): boolean`.
- Consumes: normalized and synthesized conversation metadata returned by `chat_get`.

- [ ] **Step 1: Write failing backend metadata assertions**

Extend the existing Rust conversation tests so Riot direct metadata asserts `supportsHistory == true`, while `merge_room_conversations` assertions require Party, Team, and All to have `supportsHistory == false`.

- [ ] **Step 2: Verify backend RED**

Run: `cargo test commands::chat::tests` from `src-tauri/`.

Expected: assertions fail because `supportsHistory` is absent.

- [ ] **Step 3: Add backend metadata**

Add `"supportsHistory": channel == "friends"` to `normalize_conversations` and `"supportsHistory": false` to `room_conversation`.

- [ ] **Step 4: Write the failing frontend decision test**

In `src/pages/chat/chat-model.test.ts`, import `supportsConversationHistory` and add:

```ts
test("requests REST history only for supported direct conversations", () => {
  expect(supportsConversationHistory({
    cid: "friend@jp1.pvp.net", channel: "friends", type: "chat", title: "",
    participantPuuid: "friend", unreadCount: 0, messageHistory: true,
    muted: false, supportsHistory: true,
  })).toBe(true);
  expect(supportsConversationHistory({
    cid: "game-blue@ares-coregame.jp1.pvp.net", channel: "team", type: "groupchat",
    title: "", participantPuuid: "", unreadCount: 0, messageHistory: null,
    muted: false, supportsHistory: false,
  })).toBe(false);
});
```

- [ ] **Step 5: Verify frontend RED**

Run: `bun test src/pages/chat/chat-model.test.ts`.

Expected: compilation fails because `supportsConversationHistory` and the type field do not exist.

- [ ] **Step 6: Implement the frontend guard**

Add `supportsHistory: boolean` to `ChatConversation`. Add this helper to `chat-model.ts`:

```ts
export const supportsConversationHistory = (
  conversation: ChatConversation | null | undefined,
) => conversation?.supportsHistory === true;
```

Update existing test fixtures with `supportsHistory`. In `use-chat-controller.ts`, resolve the selected conversation before dispatching `historyStarted`; call `requestHistory` only when `supportsConversationHistory(...)` returns true. Apply the same guard after a successful send so XMPP group sends do not trigger a REST 404.

- [ ] **Step 7: Run focused tests**

Run: `bun test src/pages/chat/chat-model.test.ts src/pages/chat/use-chat-controller.test.ts src/pages/chat/chat-controller-state.test.ts`.

Expected: PASS.

- [ ] **Step 8: Commit the group-history repair**

```powershell
git add src-tauri/src/commands/chat.rs src/types/chat.ts src/pages/chat/chat-model.ts src/pages/chat/chat-model.test.ts src/pages/chat/use-chat-controller.ts
git commit -m "fix: keep group chat history on XMPP"
```

### Task 3: Full verification

**Files:**
- Verify only; no production files should change.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: verification evidence for the completed repair.

- [ ] **Step 1: Run all Rust tests and type checking**

Run from `src-tauri/`: `cargo test` then `cargo check`.

Expected: both commands exit 0.

- [ ] **Step 2: Run all frontend tests**

Run from repository root: `bun test`.

Expected: all tests pass.

- [ ] **Step 3: Run the frontend production build**

Run: `bun run build:vite`.

Expected: TypeScript and Vite complete successfully.

- [ ] **Step 4: Inspect the final diff**

Run: `git status --short`, `git diff --check HEAD~2`, and `git diff HEAD~2 -- src-tauri/src/riot/api.rs src-tauri/src/commands/chat.rs src-tauri/src/xmpp/mod.rs src/types/chat.ts src/pages/chat/chat-model.ts src/pages/chat/chat-model.test.ts src/pages/chat/use-chat-controller.ts`.

Expected: only the scoped chat repair appears; no whitespace errors or unrelated user files are included.
