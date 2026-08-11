# Chat Friend Game Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct-chat message previews with localized Riot/VALORANT presence states and show the same state beneath the selected friend's Riot ID.

**Architecture:** The Rust Chat normalizer exposes the raw semantic `sessionLoopState` from the VALORANT presence blob. A pure TypeScript resolver converts Chat friend data into one of six stable status keys. Conversation rows and the selected thread header consume that same resolved key through localized labels.

**Tech Stack:** Rust/serde_json/base64, Tauri 2, React 19, TypeScript 6, i18next, Bun tests, Rust unit tests.

## Global Constraints

- Friends conversation rows replace the latest-message preview; they do not add a third line.
- Direct-chat headers show the same friend state as the row; Party, Team, and All keep their channel labels.
- State priority is Offline, In Match, Agent Select, In Lobby, Away, Online.
- Raw Riot values such as `MENUS`, `PREGAME`, and `INGAME` are never rendered.
- Reuse existing `friends.inMatch`, `friends.agentSelect`, `friends.inLobby`, `friends.away`, `friends.online`, and `friends.offline` translations.
- Do not change presence polling frequency, conversation sorting, or group-chat UI.
- Preserve unrelated dirty-worktree changes and stage only files named by each task.

---

### Task 1: Expose VALORANT session state to Chat

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src/types/chat.ts`
- Test: `src-tauri/src/commands/chat.rs` (`commands::chat::tests`)

**Interfaces:**
- Consumes: Riot v4 presence `private` base64 JSON with `matchPresenceData.sessionLoopState` and legacy root `sessionLoopState`.
- Produces: `ChatFriend.sessionLoopState: string` in the `chat:get` response.

- [ ] **Step 1: Write failing Rust tests for current and legacy blob locations**

Add these tests inside `commands::chat::tests`:

```rust
#[test]
fn extracts_chat_friend_session_loop_state_from_match_presence() {
    let private = base64::engine::general_purpose::STANDARD.encode(
        json!({ "matchPresenceData": { "sessionLoopState": "INGAME" } }).to_string(),
    );
    let result = normalize_friends(
        &[json!({ "puuid": "friend", "game_name": "Friend" })],
        &[json!({
            "puuid": "friend",
            "product": "valorant",
            "state": "dnd",
            "private": private
        })],
    );
    assert_eq!(result[0]["sessionLoopState"], "INGAME");
}

#[test]
fn falls_back_to_legacy_root_session_loop_state() {
    let private = base64::engine::general_purpose::STANDARD
        .encode(json!({ "sessionLoopState": "MENUS" }).to_string());
    let result = normalize_friends(
        &[json!({ "puuid": "friend", "game_name": "Friend" })],
        &[json!({
            "puuid": "friend",
            "product": "valorant",
            "state": "chat",
            "private": private
        })],
    );
    assert_eq!(result[0]["sessionLoopState"], "MENUS");
}
```

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests::extracts_chat_friend_session_loop_state_from_match_presence --lib
cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests::falls_back_to_legacy_root_session_loop_state --lib
```

Expected: both fail because `sessionLoopState` is absent or null.

- [ ] **Step 3: Normalize and return the session state**

In `normalize_friends`, after decoding `priv_val`, select the current location first:

```rust
let match_data = priv_val.get("matchPresenceData").unwrap_or(&priv_val);
let session_loop_state = pick_string([
    match_data.get("sessionLoopState").and_then(|value| value.as_str()),
    priv_val.get("sessionLoopState").and_then(|value| value.as_str()),
]);
```

Add the field to the normalized friend JSON:

```rust
"sessionLoopState": session_loop_state,
```

Add the required frontend property in `src/types/chat.ts`:

```ts
export type ChatFriend = {
  // existing fields
  sessionLoopState: string;
};
```

Update every `ChatFriend` fixture to include `sessionLoopState: ""` until Task 2 adds meaningful values.

- [ ] **Step 4: Verify Task 1 GREEN**

Run:

```powershell
rustfmt --edition 2021 src-tauri/src/commands/chat.rs
cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests --lib
bunx tsc --noEmit
```

Expected: all Chat Rust tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src-tauri/src/commands/chat.rs src/types/chat.ts src/pages/chat/chat-model.test.ts src/pages/chat/chat-components.test.tsx
git commit -m "feat: expose chat friend game state"
```

---

### Task 2: Resolve one shared semantic friend status

**Files:**
- Modify: `src/pages/chat/chat-model.ts`
- Modify: `src/pages/chat/use-chat-controller.ts`
- Test: `src/pages/chat/chat-model.test.ts`

**Interfaces:**
- Consumes: `ChatFriend.isOnline`, `ChatFriend.status`, and `ChatFriend.sessionLoopState`.
- Produces: `FriendGameStatus`, `resolveFriendGameStatus(friend)`, `FriendConversation.statusKey`, and `selectedFriendConversation` from the controller.

- [ ] **Step 1: Write failing resolver and conversation tests**

Import `resolveFriendGameStatus`, then add:

```ts
test("resolves localized friend game status keys in priority order", () => {
  expect(resolveFriendGameStatus({ ...friend, isOnline: false })).toBe("offline");
  expect(resolveFriendGameStatus({ ...friend, sessionLoopState: "INGAME", status: "away" })).toBe("inMatch");
  expect(resolveFriendGameStatus({ ...friend, sessionLoopState: "PREGAME", status: "away" })).toBe("agentSelect");
  expect(resolveFriendGameStatus({ ...friend, sessionLoopState: "MENUS", status: "away" })).toBe("inLobby");
  expect(resolveFriendGameStatus({ ...friend, sessionLoopState: "", status: "away" })).toBe("away");
  expect(resolveFriendGameStatus({ ...friend, sessionLoopState: "", status: "chat" })).toBe("online");
});

test("attaches the matched friend's status to a direct conversation", () => {
  const result = buildFriendConversations([], [{
    cid: "friend-puuid@jp1.pvp.net",
    channel: "friends",
    type: "chat",
    title: "",
    participantPuuid: "friend-puuid",
    unreadCount: 0,
    messageHistory: true,
    muted: false,
  }], [{ ...friend, sessionLoopState: "INGAME" }]);
  expect(result[0]?.statusKey).toBe("inMatch");
});
```

- [ ] **Step 2: Run the model test and verify RED**

Run:

```powershell
bun test src/pages/chat/chat-model.test.ts
```

Expected: fail because `resolveFriendGameStatus` and `statusKey` do not exist.

- [ ] **Step 3: Implement the pure status resolver and conversation field**

Add:

```ts
export type FriendGameStatus =
  | "offline"
  | "inMatch"
  | "agentSelect"
  | "inLobby"
  | "away"
  | "online";

export const resolveFriendGameStatus = (
  friend: ChatFriend | undefined,
): FriendGameStatus => {
  if (!friend?.isOnline) return "offline";
  if (friend.sessionLoopState === "INGAME") return "inMatch";
  if (friend.sessionLoopState === "PREGAME") return "agentSelect";
  if (friend.sessionLoopState === "MENUS") return "inLobby";
  if (friend.status.toLowerCase() === "away") return "away";
  return "online";
};
```

Extend `FriendConversation`:

```ts
statusKey: FriendGameStatus;
```

Set it while building each conversation:

```ts
statusKey: resolveFriendGameStatus(friend),
```

- [ ] **Step 4: Return the unfiltered selected friend conversation**

In `use-chat-controller.ts`, keep the existing unfiltered `conversations` value and derive:

```ts
const selectedFriendConversation = useMemo(
  () => conversations.find((item) => item.cid === state.selectedCid) ?? null,
  [conversations, state.selectedCid],
);
```

Return `selectedFriendConversation` alongside the existing raw `selectedConversation`. This keeps the header stable even when the search filter hides the selected row.

- [ ] **Step 5: Verify Task 2 GREEN**

Run:

```powershell
bun test src/pages/chat/chat-model.test.ts src/pages/chat/use-chat-controller.test.ts
bunx tsc --noEmit
```

Expected: focused tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- src/pages/chat/chat-model.ts src/pages/chat/chat-model.test.ts src/pages/chat/use-chat-controller.ts
git commit -m "feat: resolve chat friend game status"
```

---

### Task 3: Render status in conversation rows and direct-chat headers

**Files:**
- Modify: `src/pages/chat/chat-conversation-list.tsx`
- Modify: `src/pages/chat/chat-thread.tsx`
- Modify: `src/pages/Chat.tsx`
- Test: `src/pages/chat/chat-components.test.tsx`

**Interfaces:**
- Consumes: `FriendConversation.statusKey`, `selectedFriendConversation`, and existing `friends.*` translations.
- Produces: status-only conversation subtitles and direct-chat header subtitles.

- [ ] **Step 1: Write failing conversation-list and thread-header tests**

Define the test labels:

```ts
const statusLabels = {
  offline: "Offline",
  inMatch: "In Match",
  agentSelect: "Agent Select",
  inLobby: "In Lobby",
  away: "Away",
  online: "Online",
};
```

Update the conversation fixture with `statusKey: "inMatch"`, pass `statusLabels`, and change assertions to:

```ts
expect(markup).toContain("In Match");
expect(markup).not.toContain("hello");
```

Pass `subtitle="In Match"` to the direct `ChatThread` test and assert:

```ts
expect(markup).toContain("In Match");
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```powershell
bun test src/pages/chat/chat-components.test.tsx
```

Expected: fail because the list still renders the latest message and `ChatThread` still renders the raw channel.

- [ ] **Step 3: Replace the row preview with the localized status**

Export the shared label type from `chat-conversation-list.tsx`:

```ts
import type { FriendGameStatus, FriendConversation } from "./chat-model";

export type FriendStatusLabels = Record<FriendGameStatus, string>;
```

Add `statusLabels: FriendStatusLabels` to the component props. Remove `latest` and replace the subtitle content with:

```tsx
<span className="min-w-0 flex-1 truncate text-xs text-gray-500">
  {statusLabels[conversation.statusKey]}
</span>
```

- [ ] **Step 4: Let the thread receive a display subtitle**

Replace the header's raw channel text with a required `subtitle: string` prop:

```tsx
<p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-400/70">
  {subtitle}
</p>
```

Remove the now-unused `channel` prop and `ChatChannel` type import from `ChatThread`, then remove `channel={...}` from the `Chat.tsx` call site and component tests. The new `subtitle` prop is the sole header-subtitle source.

- [ ] **Step 5: Build localized labels and choose the direct-chat subtitle**

In `Chat.tsx`, create:

```ts
const friendStatusLabels = {
  offline: t("friends.offline"),
  inMatch: t("friends.inMatch"),
  agentSelect: t("friends.agentSelect"),
  inLobby: t("friends.inLobby"),
  away: t("friends.away"),
  online: t("friends.online"),
};
```

Pass it to `ChatConversationList`. Derive the header subtitle without showing `Offline` when no direct conversation is selected:

```ts
const threadSubtitle =
  controller.selectedChannel === "friends" && controller.selectedFriendConversation
    ? friendStatusLabels[controller.selectedFriendConversation.statusKey]
    : channelLabels[controller.selectedChannel];
```

Pass `subtitle={threadSubtitle}` to `ChatThread`.

- [ ] **Step 6: Verify Task 3 GREEN**

Run:

```powershell
bun test src/pages/chat/chat-components.test.tsx src/pages/chat/chat-model.test.ts src/pages/chat/use-chat-controller.test.ts
bunx tsc --noEmit
```

Expected: all focused Chat tests pass and TypeScript exits 0.

- [ ] **Step 7: Run full verification**

Run:

```powershell
bun test
bun run build:vite
cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests --lib
rustfmt --edition 2021 --check src-tauri/src/commands/chat.rs
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Bun tests pass with zero failures, Vite production build succeeds, Chat Rust tests pass, focused Rust formatting passes, and `cargo check` exits 0. Existing Vite native-config and large-chunk warnings are allowed.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- src/pages/Chat.tsx src/pages/chat/chat-conversation-list.tsx src/pages/chat/chat-thread.tsx src/pages/chat/chat-components.test.tsx
git commit -m "feat: show friend game status in chat"
```
