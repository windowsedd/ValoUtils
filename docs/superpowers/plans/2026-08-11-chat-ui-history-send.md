# Chat UI, History, and Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Chat as a hideable navigation tab with the approved Riot-style dense UI, on-demand CID-specific history, and reliable sending for Friends, Party, Team, and All channels.

**Architecture:** Keep `chat:get` as the five-second summary, add a correlated `chat:history` IPC request for the selected CID, and extend `chat:send` with correlation and normalized response metadata. A frontend controller owns listeners, polling, per-CID caches, and mutations; pure selectors handle grouping, CID/channel mapping, message merge/sort, search, and scroll decisions; focused components render the four-panel desktop layout and responsive Friends drawer.

**Tech Stack:** Tauri 2, Rust 2021, React 19, TypeScript 6, Tailwind CSS 4, react-i18next, Bun test, Cargo test/check.

## Global Constraints

- Preserve Friends, Party, Team, All, translation, Invite, Join Party, REST send, and XMPP fallback.
- Never construct Riot conversation CIDs in the frontend.
- Fetch full history only for the selected CID; do not prefetch every conversation.
- Use `chat` for Friend messages and `groupchat` for Party, Team, and All; never send `system`.
- Use Riot-provided unread metadata only; do not fabricate unread counts.
- Keep cached/live messages visible when a history refresh fails.
- Preserve a failed send draft and prevent duplicate pending sends.
- Keep Riot credentials, authorization headers, and lockfile secrets out of frontend payloads and debug UI.
- Maintain English, Korean, and Traditional Chinese localization.
- Preserve unrelated dirty-worktree changes; every commit stages only files named by its task.

---

## Planned File Structure

- `src/types/chat.ts` — canonical frontend Chat contracts for channels, conversations, summary, history, send, and friends.
- `src/pages/chat/chat-model.ts` — pure grouping, search, sorting, merge/dedupe, channel selection, and scroll helpers.
- `src/pages/chat/chat-model.test.ts` — deterministic unit coverage for Chat data behavior.
- `src/pages/chat/use-chat-controller.ts` — IPC listener lifecycle, polling, caches, history requests, send/translate/friend actions, and state transitions.
- `src/pages/chat/chat-controller-state.ts` — pure reducer used by the controller so stale-response and draft behavior can be tested without a browser.
- `src/pages/chat/chat-controller-state.test.ts` — reducer and request-correlation tests.
- `src/pages/chat/chat-channel-rail.tsx` — Friends/Party/Team/All selection.
- `src/pages/chat/chat-conversation-list.tsx` — friend conversation search and selection.
- `src/pages/chat/chat-thread.tsx` — header, states, chronological messages, translation actions, scroll behavior, and debug disclosure.
- `src/pages/chat/chat-composer.tsx` — multiline draft and send interaction.
- `src/pages/chat/chat-friends-panel.tsx` — friend list, note/presence presentation, action menu, and drawer surface.
- `src/pages/chat/chat-components.test.tsx` — server-rendered component and accessibility contract tests.
- `src/pages/Chat.tsx` — thin page shell composing the controller and UI regions.
- `src-tauri/src/commands/chat.rs` — CID metadata normalization, history command, send response enrichment, note propagation, and Rust tests.
- `src-tauri/src/lib.rs` — register `chat_history`.
- `src/main.tsx` — restore Chat route immediately after Friends.
- `src/i18n/locales/en.json`, `ko.json`, `zh-TW.json` — complete Chat labels, states, actions, and accessible names.
- `tests/chat-navigation-and-locales.test.ts` — route order, hide-tab participation, command registration, and locale coverage.

---

### Task 1: Define Chat contracts and pure data behavior

**Files:**
- Modify: `src/types/chat.ts`
- Create: `src/pages/chat/chat-model.ts`
- Create: `src/pages/chat/chat-model.test.ts`

**Interfaces:**
- Produces: `ChatChannel`, `ChatConversation`, `ChatHistoryResponse`, correlated `ChatSendResponse`, `mergeChatMessages`, `buildFriendConversations`, `filterChatFriends`, `findFriendConversationCid`, `channelForCid`, `shouldStickToBottom`.
- Consumes: existing `ChatMessage`, `ChatFriend`, `ChatResponse`, and Riot-normalized fields.

- [ ] **Step 1: Write failing pure-model tests**

Create `src/pages/chat/chat-model.test.ts` with fixtures covering chronological sort, stable dedupe, newest-first conversation order, note search, exact channel classification, and near-bottom behavior:

```ts
import { describe, expect, test } from "bun:test";
import type { ChatFriend, ChatMessage } from "@/types/chat";
import {
	buildFriendConversations,
	channelForCid,
	filterChatFriends,
	mergeChatMessages,
	shouldStickToBottom,
} from "./chat-model";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
	id: "m-1",
	conversationId: "friend-cid",
	sender: "friend-puuid",
	senderName: "ALEKSANDAR",
	body: "hello",
	timestamp: "1000",
	type: "chat",
	scope: "friends",
	isSelf: false,
	...overrides,
});

const friend: ChatFriend = {
	puuid: "friend-puuid",
	gameName: "ALEKSANDAR",
	tagLine: "4830",
	displayName: "ALEKSANDAR#4830",
	note: "我能架住",
	status: "chat",
	statusMessage: "",
	product: "valorant",
	queueId: "competitive",
	partyId: "party-1",
	partySize: 2,
	maxPartySize: 5,
	isOnline: true,
};

describe("chat model", () => {
	test("merges REST and XMPP messages by cid and id in chronological order", () => {
		const result = mergeChatMessages(
			[message({ id: "older", timestamp: "1000" })],
			[message({ id: "older", timestamp: "1000" }), message({ id: "newer", timestamp: "2000" })],
		);
		expect(result.map((item) => item.id)).toEqual(["older", "newer"]);
	});

	test("sorts friend conversations by newest message", () => {
		const groups = buildFriendConversations([
			message({ id: "one", conversationId: "one", timestamp: "1000" }),
			message({ id: "two", conversationId: "two", timestamp: "3000", senderName: "SULAGE" }),
		]);
		expect(groups.map((group) => group.cid)).toEqual(["two", "one"]);
	});

	test("searches friends by Riot ID and note", () => {
		expect(filterChatFriends([friend], "4830")).toHaveLength(1);
		expect(filterChatFriends([friend], "架住")).toHaveLength(1);
		expect(filterChatFriends([friend], "missing")).toHaveLength(0);
	});

	test("classifies only exact Riot room families", () => {
		expect(channelForCid("party@ares-parties.ap")).toBe("party");
		expect(channelForCid("match-blue@ares-coregame.ap")).toBe("team");
		expect(channelForCid("match-red@ares-pregame.ap")).toBe("team");
		expect(channelForCid("match-all@ares-coregame.ap")).toBe("all");
		expect(channelForCid("friend-cid")).toBe("friends");
	});

	test("sticks only near the bottom or after own send", () => {
		expect(shouldStickToBottom({ scrollHeight: 1000, scrollTop: 650, clientHeight: 300 }, false)).toBe(true);
		expect(shouldStickToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 }, false)).toBe(false);
		expect(shouldStickToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 }, true)).toBe(true);
	});
});
```

- [ ] **Step 2: Run the model tests and confirm the missing-module failure**

Run: `bun test src/pages/chat/chat-model.test.ts`

Expected: FAIL because `chat-model.ts` and the extended Chat fields do not exist.

- [ ] **Step 3: Extend types and implement the pure helpers**

In `src/types/chat.ts`, add these exact contracts while retaining `TranslateResponse`:

```ts
export type ChatChannel = "friends" | "party" | "team" | "all";

export type ChatConversation = {
	cid: string;
	channel: ChatChannel;
	type: "chat" | "groupchat";
	title: string;
	participantPuuid: string;
	unreadCount: number;
	messageHistory: boolean | null;
	muted: boolean;
};

export type ChatHistoryResponse =
	| { success: true; requestId: string; cid: string; messages: ChatMessage[] }
	| { success: false; requestId: string; cid: string; code: "loginRequired" | "unavailable" | null; error: string };

export type ChatSendResponse =
	| { success: true; requestId: string; cid: string; type: "chat" | "groupchat"; transport: "rest" | "xmpp" }
	| { success: false; requestId: string; cid: string; error: string };
```

Add `note: string` to `ChatFriend`, add `conversations: ChatConversation[]` to the successful `ChatResponse`, and keep `rooms` temporarily for compatibility during the migration.

Implement `chat-model.ts` with:

```ts
import type { ChatChannel, ChatConversation, ChatFriend, ChatMessage } from "@/types/chat";

export type FriendConversation = { cid: string; title: string; participantPuuid: string; unreadCount: number; latestTime: number; messages: ChatMessage[] };
type ScrollMetrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

const messageTime = (message: ChatMessage) => {
	const numeric = Number(message.timestamp);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = message.timestamp ? Date.parse(message.timestamp) : 0;
	return Number.isNaN(parsed) ? 0 : parsed;
};

const fallbackKey = (message: ChatMessage) =>
	`${message.conversationId}:${message.timestamp ?? ""}:${message.sender}:${message.body}`;

export const mergeChatMessages = (...sets: ChatMessage[][]) => {
	const byKey = new Map<string, ChatMessage>();
	for (const item of sets.flat()) {
		const key = item.id ? `${item.conversationId}:${item.id}` : fallbackKey(item);
		byKey.set(key, { ...byKey.get(key), ...item });
	}
	return [...byKey.values()].sort((a, b) => messageTime(a) - messageTime(b) || a.id.localeCompare(b.id));
};

export const buildFriendConversations = (messages: ChatMessage[], metadata: ChatConversation[] = []): FriendConversation[] => {
	const grouped = new Map<string, ChatMessage[]>();
	for (const item of messages.filter((entry) => entry.scope === "friends" && entry.conversationId)) {
		grouped.set(item.conversationId, [...(grouped.get(item.conversationId) ?? []), item]);
	}
	return [...grouped.entries()].map(([cid, values]) => {
		const ordered = mergeChatMessages(values);
		const other = [...ordered].reverse().find((entry) => !entry.isSelf);
		const conversation = metadata.find((item) => item.cid === cid);
		return {
			cid,
			title: conversation?.title || other?.senderName || other?.sender || cid,
			participantPuuid: conversation?.participantPuuid || "",
			unreadCount: conversation?.unreadCount ?? 0,
			latestTime: Math.max(0, ...ordered.map(messageTime)),
			messages: ordered,
		};
	}).sort((a, b) => b.latestTime - a.latestTime || a.title.localeCompare(b.title));
};

export const filterChatFriends = (friends: ChatFriend[], search: string) => {
	const query = search.trim().toLocaleLowerCase();
	if (!query) return friends;
	return friends.filter((friend) => `${friend.displayName} ${friend.gameName} ${friend.tagLine} ${friend.note}`.toLocaleLowerCase().includes(query));
};

const idRoot = (value: string) => value.split("@")[0].toLocaleLowerCase();

export const findFriendConversationCid = (friend: ChatFriend, conversations: ChatConversation[]) =>
	conversations.find((conversation) =>
		conversation.channel === "friends" && idRoot(conversation.participantPuuid) === idRoot(friend.puuid)
	)?.cid ?? null;

export const channelForCid = (cid: string): ChatChannel => {
	const value = cid.toLocaleLowerCase();
	if (value.includes("@ares-parties.")) return "party";
	if (/-(blue|red)@ares-(coregame|pregame)\./.test(value)) return "team";
	if (/-all@ares-coregame\./.test(value)) return "all";
	return "friends";
};

export const shouldStickToBottom = (metrics: ScrollMetrics, sentBySelf: boolean) =>
	sentBySelf || metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 64;
```

- [ ] **Step 4: Run the model tests**

Run: `bun test src/pages/chat/chat-model.test.ts`

Expected: all five tests PASS.

- [ ] **Step 5: Commit the contracts and pure model**

```bash
git add src/types/chat.ts src/pages/chat/chat-model.ts src/pages/chat/chat-model.test.ts
git commit -m "feat: add chat conversation model"
```

---

### Task 2: Normalize real conversation metadata and expose CID history

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `riot_client::get_chat_messages(&riot, Some(cid))`, existing room discovery, token subject, and `normalize_messages`.
- Produces: `chat_history(args, riot)` returning the `ChatHistoryResponse` contract; successful `chat_get` now includes `conversations` and friend notes.

- [ ] **Step 1: Add failing Rust tests for CID classification and metadata**

Append a `#[cfg(test)] mod tests` in `chat.rs` with deterministic JSON fixtures:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_party_team_all_without_substitution() {
        assert_eq!(channel_for_cid("party@ares-parties.ap"), "party");
        assert_eq!(channel_for_cid("game-blue@ares-coregame.ap"), "team");
        assert_eq!(channel_for_cid("game-red@ares-pregame.ap"), "team");
        assert_eq!(channel_for_cid("game-all@ares-coregame.ap"), "all");
        assert_eq!(channel_for_cid("friend-cid"), "friends");
    }

    #[test]
    fn preserves_history_and_unread_metadata() {
        let payload = json!({"conversations": [{
            "cid": "party@ares-parties.ap",
            "type": "groupchat",
            "message_history": true,
            "unread_count": 3,
            "muted": false
        }]});
        let result = normalize_conversations(&payload);
        assert_eq!(result[0]["channel"], "party");
        assert_eq!(result[0]["unreadCount"], 3);
        assert_eq!(result[0]["messageHistory"], true);
    }

    #[test]
    fn history_error_keeps_request_identity() {
        let value = history_error("request-7", "room-7", "unavailable", "No room");
        assert_eq!(value["requestId"], "request-7");
        assert_eq!(value["cid"], "room-7");
        assert_eq!(value["code"], "unavailable");
    }
}
```

- [ ] **Step 2: Run focused Rust tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests --lib`

Expected: FAIL because `channel_for_cid`, `normalize_conversations`, and `history_error` do not exist.

- [ ] **Step 3: Implement conversation normalization helpers**

Add helpers next to `conversations_array`:

```rust
fn channel_for_cid(cid: &str) -> &'static str {
    let value = cid.to_lowercase();
    if value.contains("@ares-parties.") {
        "party"
    } else if (value.contains("-blue@ares-coregame.")
        || value.contains("-red@ares-coregame.")
        || value.contains("-blue@ares-pregame.")
        || value.contains("-red@ares-pregame."))
    {
        "team"
    } else if value.contains("-all@ares-coregame.") {
        "all"
    } else {
        "friends"
    }
}

fn normalize_conversations(payload: &Value) -> Vec<Value> {
    conversations_array(payload).into_iter().filter_map(|item| {
        let cid = pick_string([
            item.get("cid"), item.get("id"), item.get("conversationId")
        ].map(|value| value.and_then(|value| value.as_str())));
        if cid.is_empty() { return None; }
        let kind = if channel_for_cid(&cid) == "friends" { "chat" } else { "groupchat" };
        Some(json!({
            "cid": cid,
            "channel": channel_for_cid(&cid),
            "type": item.get("type").and_then(|value| value.as_str()).unwrap_or(kind),
            "title": item.get("name").and_then(|value| value.as_str()).unwrap_or(""),
            "participantPuuid": if channel_for_cid(&cid) == "friends" { id_root(&cid) } else { String::new() },
            "unreadCount": item.get("unread_count").and_then(|value| value.as_u64()).unwrap_or(0),
            "messageHistory": item.get("message_history").cloned().unwrap_or(Value::Null),
            "muted": item.get("muted").and_then(|value| value.as_bool()).unwrap_or(false),
        }))
    }).collect()
}

fn history_error(request_id: &str, cid: &str, code: &str, error: &str) -> Value {
    json!({ "success": false, "requestId": request_id, "cid": cid, "code": code, "error": error })
}
```

Merge normalized metadata from general, Party, Pregame, and Coregame conversation payloads by CID before returning `chat:get`. Preserve each endpoint's real `unread_count`, `message_history`, and `muted`, then set channel from `channel_for_cid`. Do not use `rooms.match` as an All/Team fallback in the new `conversations` array.

In `normalize_friends`, carry the Riot response's `note`/`Note` field:

```rust
let note = pick_string(
    [friend.get("note"), friend.get("Note")]
        .map(|value| value.and_then(|value| value.as_str())),
);
```

and add `"note": note` to the normalized friend JSON.

- [ ] **Step 4: Add the correlated `chat_history` command**

Add this command after `chat_get`, reusing summary normalization inputs so history and live messages share the same shape:

```rust
#[tauri::command]
pub async fn chat_history(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let request_id = arg(&args, 0).unwrap_or_default();
    let cid = arg(&args, 1).unwrap_or_default().trim().to_string();
    if cid.is_empty() {
        return Ok(history_error(&request_id, &cid, "unavailable", "No chat room selected.").to_string());
    }

    let result: Result<Value, String> = async {
        let payload = riot_client::get_chat_messages(&riot, Some(&cid)).await?;
        let conversations_payload = riot_client::get_chat_conversations(&riot).await.ok();
        let conversations = conversations_payload.as_ref().map(normalize_conversation_map).unwrap_or_default();
        let scopes = get_chat_room_scopes(&riot, conversations_payload.as_ref()).await;
        let match_player_ids = get_current_match_player_ids(&riot).await;
        let tokens = riot_client::get_tokens(&riot, false).await?;
        let own_puuid = tokens.get("subject").and_then(|value| value.as_str()).unwrap_or("");
        let messages = normalize_messages(&payload, &conversations, &scopes, &match_player_ids, own_puuid);
        Ok(json!({ "success": true, "requestId": request_id, "cid": cid, "messages": unique_messages(messages) }))
    }.await;

    Ok(match result {
        Ok(value) => value.to_string(),
        Err(error) => {
            let code = if error.contains("lockfile") { "loginRequired" } else { "" };
            history_error(&request_id, &cid, code, &error).to_string()
        }
    })
}
```

Register `commands::chat::chat_history` immediately after `chat_get` in `src-tauri/src/lib.rs`.

- [ ] **Step 5: Run Rust formatting and focused tests**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: PASS after formatting with `cargo fmt --manifest-path src-tauri/Cargo.toml` if the first check reports diffs.

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests --lib`

Expected: all Chat tests PASS.

- [ ] **Step 6: Commit backend history and metadata**

```bash
git add src-tauri/src/commands/chat.rs src-tauri/src/lib.rs
git commit -m "feat: expose chat history by conversation"
```

---

### Task 3: Correlate sends and preserve drafts in controller state

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`
- Create: `src/pages/chat/chat-controller-state.ts`
- Create: `src/pages/chat/chat-controller-state.test.ts`

**Interfaces:**
- Consumes: `ChatHistoryResponse`, `ChatSendResponse`, `mergeChatMessages`.
- Produces: `ChatControllerState`, `chatControllerReducer`, correlated `chat:send` response fields, and per-CID cache transitions used by the hook.

- [ ] **Step 1: Write failing reducer tests**

Create tests that prove stale history remains cached without replacing selection and failed send preserves the draft:

```ts
import { describe, expect, test } from "bun:test";
import { chatControllerReducer, initialChatControllerState } from "./chat-controller-state";

describe("chat controller state", () => {
	test("stores stale history under its own cid without changing selection", () => {
		const selected = { ...initialChatControllerState, selectedCid: "new-cid" };
		const result = chatControllerReducer(selected, {
			type: "historySucceeded",
			cid: "old-cid",
			requestId: "history-old",
			messages: [],
		});
		expect(result.selectedCid).toBe("new-cid");
		expect(result.historyByCid["old-cid"]).toEqual([]);
	});

	test("retains draft after send failure", () => {
		const sending = { ...initialChatControllerState, selectedCid: "room", draft: "keep me", pendingSendId: "send-1" };
		const result = chatControllerReducer(sending, { type: "sendFailed", requestId: "send-1", error: "offline" });
		expect(result.draft).toBe("keep me");
		expect(result.pendingSendId).toBeNull();
		expect(result.sendError).toBe("offline");
	});
});
```

- [ ] **Step 2: Run the reducer tests and verify failure**

Run: `bun test src/pages/chat/chat-controller-state.test.ts`

Expected: FAIL because the reducer module does not exist.

- [ ] **Step 3: Implement the reducer with explicit actions**

Create `chat-controller-state.ts` with a state containing `selectedChannel`, `selectedCid`, `historyByCid`, `historyLoadingByCid`, `historyErrorByCid`, `draft`, `pendingSendId`, and `sendError`. Implement these actions with immutable updates:

```ts
export type ChatControllerState = {
	selectedChannel: ChatChannel;
	selectedCid: string | null;
	historyByCid: Record<string, ChatMessage[]>;
	historyLoadingByCid: Record<string, string | undefined>;
	historyErrorByCid: Record<string, string | undefined>;
	draft: string;
	pendingSendId: string | null;
	sendError: string | null;
};

export const initialChatControllerState: ChatControllerState = {
	selectedChannel: "friends",
	selectedCid: null,
	historyByCid: {},
	historyLoadingByCid: {},
	historyErrorByCid: {},
	draft: "",
	pendingSendId: null,
	sendError: null,
};
```

The reducer must ignore `historySucceeded`, `historyFailed`, `sendSucceeded`, and `sendFailed` actions whose request ID does not match the stored pending ID for that operation. `sendSucceeded` clears the draft only for the matching request; `sendFailed` clears only the pending marker and retains the draft.

- [ ] **Step 4: Update `chat_send` correlation and transport**

Read `requestId` from argument 0, CID from argument 1, and message from argument 2. Return `requestId`, `cid`, `type`, and `transport` on both success and failure. Set `transport` to `rest` for a successful Local API request and `xmpp` only after fallback succeeds. Keep `get_send_type` authoritative.

The success payload must be:

```rust
json!({
    "success": true,
    "requestId": request_id,
    "cid": cid,
    "type": msg_type,
    "transport": transport,
})
```

The error payload must retain `requestId` and `cid` so the frontend never attributes a late failure to a newer send.

- [ ] **Step 5: Run reducer and Rust Chat tests**

Run: `bun test src/pages/chat/chat-controller-state.test.ts`

Expected: both reducer tests PASS.

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests --lib`

Expected: Chat tests PASS, including an added unit assertion that `get_send_type("friend-cid") == "chat"` and Party/Coregame CIDs return `groupchat`.

- [ ] **Step 6: Commit correlated controller state and send contract**

```bash
git add src-tauri/src/commands/chat.rs src/pages/chat/chat-controller-state.ts src/pages/chat/chat-controller-state.test.ts
git commit -m "feat: correlate chat history and sends"
```

---

### Task 4: Build the Chat IPC controller

**Files:**
- Create: `src/pages/chat/use-chat-controller.ts`
- Create: `src/pages/chat/use-chat-controller.test.ts`

**Interfaces:**
- Consumes: reducer/actions from Task 3; `window.Main.send/on/removeListener`; Chat response types.
- Produces: `useChatController()` returning summary state, selected channel/CID, cached visible messages, selection actions, refresh/retry, send, translate, and friend actions.

- [ ] **Step 1: Write a failing source-contract test for listener ownership**

Create `use-chat-controller.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./use-chat-controller.ts", import.meta.url), "utf8");

describe("useChatController IPC lifecycle", () => {
	test("owns and removes exact callbacks", () => {
		expect(source).toContain('window.Main.on("chat:get", onSummary)');
		expect(source).toContain('window.Main.removeListener("chat:get", onSummary)');
		expect(source).toContain('window.Main.on("chat:history", onHistory)');
		expect(source).toContain('window.Main.removeListener("chat:history", onHistory)');
		expect(source).not.toContain("removeAllListeners");
	});

	test("requests history and sends with request ids", () => {
		expect(source).toContain('window.Main.send("chat:history", requestId, cid)');
		expect(source).toContain('window.Main.send("chat:send", requestId, selectedCid, text)');
	});
});
```

- [ ] **Step 2: Run the controller test and verify failure**

Run: `bun test src/pages/chat/use-chat-controller.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement one listener set and five-second polling**

Implement `useChatController` with `useReducer`, `useEffect`, `useMemo`, `useCallback`, and refs for current request IDs. Register stable callbacks once for `chat:get`, `chat:history`, `chat:send`, `chat:translate`, and `chat:friend-action`. Parse each JSON payload inside a guarded helper that converts invalid JSON to a scoped error instead of throwing from the event callback.

On mount, send `chat:get`, start a 5000 ms interval, and on unmount clear the interval, remove each exact callback with `removeListener`, and send `chat:disconnect`.

Use this request-ID generator so tests and logs remain understandable:

```ts
let requestSequence = 0;
const nextRequestId = (kind: "history" | "send" | "translate" | "friend") =>
	`${kind}-${Date.now()}-${++requestSequence}`;
```

When `selectConversation(cid)` runs, dispatch selection immediately, reuse cached content, dispatch `historyStarted`, and call:

```ts
window.Main.send("chat:history", requestId, cid);
```

When `sendMessage()` runs, trim the draft, reject an empty value or missing selected CID, dispatch `sendStarted`, and call:

```ts
window.Main.send("chat:send", requestId, selectedCid, text);
```

After matching send success, dispatch `sendSucceeded` and request fresh history for the same CID. After failure, dispatch `sendFailed` without clearing the draft.

- [ ] **Step 4: Derive visible data without selection jumps**

Return these stable derived values from the hook:

```ts
{
	summary,
	selectedChannel,
	selectedCid,
	visibleMessages: selectedCid ? historyByCid[selectedCid] ?? summaryMessagesForCid : [],
	conversations: buildFriendConversations(summary.messages, summary.conversations),
	friends: filterChatFriends(summary.friends, friendSearch),
	selectedConversation,
	historyLoading,
	historyError,
	sendError,
	draft,
	sending,
	loginRequired,
	loading,
	selectChannel,
	selectConversation,
	setDraft,
	setFriendSearch,
	refreshSummary,
	retryHistory,
	sendMessage,
	translateMessage,
	runFriendAction,
}
```

When summary polling removes the selected group CID, keep the channel selection but clear the CID and show its unavailable state. Do not automatically switch Team to All or All to Team.

- [ ] **Step 5: Run controller and model tests**

Run: `bun test src/pages/chat/use-chat-controller.test.ts src/pages/chat/chat-controller-state.test.ts src/pages/chat/chat-model.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Commit the Chat controller**

```bash
git add src/pages/chat/use-chat-controller.ts src/pages/chat/use-chat-controller.test.ts
git commit -m "feat: add chat ipc controller"
```

---

### Task 5: Build the channel, conversation, thread, and composer components

**Files:**
- Create: `src/pages/chat/chat-channel-rail.tsx`
- Create: `src/pages/chat/chat-conversation-list.tsx`
- Create: `src/pages/chat/chat-thread.tsx`
- Create: `src/pages/chat/chat-composer.tsx`
- Create: `src/pages/chat/chat-components.test.tsx`

**Interfaces:**
- Consumes: Task 1 types/helpers and Task 4 controller callbacks.
- Produces: keyboard-accessible visual components used by `Chat.tsx`.

- [ ] **Step 1: Write failing server-rendered component tests**

Create fixtures and assert the approved semantic contracts:

```tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatChannelRail } from "./chat-channel-rail";
import { ChatComposer } from "./chat-composer";

describe("Chat components", () => {
	test("channel rail exposes all real channels and selected state", () => {
		const markup = renderToStaticMarkup(<ChatChannelRail selected="team" available={{ friends: true, party: true, team: true, all: false }} onSelect={() => {}} />);
		expect(markup).toContain("Friends");
		expect(markup).toContain("Party");
		expect(markup).toContain("Team");
		expect(markup).toContain("All");
		expect(markup).toContain('aria-pressed="true"');
	});

	test("composer is multiline and reports unavailable state", () => {
		const markup = renderToStaticMarkup(<ChatComposer draft="" disabled disabledReason="No team room" sending={false} onDraftChange={() => {}} onSend={() => {}} />);
		expect(markup).toContain("<textarea");
		expect(markup).toContain("No team room");
		expect(markup).toContain("disabled");
	});
});
```

- [ ] **Step 2: Run component tests and verify failure**

Run: `bun test src/pages/chat/chat-components.test.tsx`

Expected: FAIL because the component modules do not exist.

- [ ] **Step 3: Implement the channel rail and conversation list**

`ChatChannelRail` accepts `selected`, `available`, and `onSelect`. Render four 40 px minimum buttons in the exact order Friends, Party, Team, All, with `aria-pressed`, translated labels, red selected marker, and a visible unavailable indicator that does not disable selection.

`ChatConversationList` accepts `conversations`, `selectedCid`, `search`, `onSearchChange`, and `onSelect`. Render a translated search input and friend rows containing title, latest-message preview/time, and Riot-provided unread count only when greater than zero. Use buttons with a cyan focus ring and `aria-current` for the selected conversation. The controller enriches message groups with `ChatConversation.participantPuuid` and `unreadCount`; the component never derives either value from display text.

- [ ] **Step 4: Implement chronological thread and scoped states**

`ChatThread` accepts `messages`, selection title/channel, history loading/error, cached-content flag, translation state/actions, debug data, and scroll notification. Render messages in the order received from `mergeChatMessages` without reversing them. Use a scroll container ref and this update sequence:

```ts
const stickRef = useRef(true);
const onScroll = () => {
	const node = scrollRef.current;
	if (node) stickRef.current = shouldStickToBottom(node, false);
};
useLayoutEffect(() => {
	if (stickRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
}, [messages]);
```

Show cached messages under a small refreshing indicator. A history error renders inline above cached/live messages with a Retry button. Raw JSON is available only inside a collapsed `<details>` developer panel.

- [ ] **Step 5: Implement multiline composer keyboard behavior**

`ChatComposer` calls `onSend` only for Enter without Shift and without IME composition:

```ts
const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
	if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
	event.preventDefault();
	onSend();
};
```

Keep the textarea mounted after failure, display `disabledReason`, apply a 40 px minimum send target, and use translated accessible labels.

- [ ] **Step 6: Run component and TypeScript checks**

Run: `bun test src/pages/chat/chat-components.test.tsx`

Expected: component tests PASS.

Run: `bunx tsc --noEmit`

Expected: PASS with no unused imports or incompatible Chat types.

- [ ] **Step 7: Commit core Chat UI components**

```bash
git add src/pages/chat/chat-channel-rail.tsx src/pages/chat/chat-conversation-list.tsx src/pages/chat/chat-thread.tsx src/pages/chat/chat-composer.tsx src/pages/chat/chat-components.test.tsx
git commit -m "feat: build chat channels and thread ui"
```

---

### Task 6: Build the Friends panel and responsive drawer

**Files:**
- Create: `src/pages/chat/chat-friends-panel.tsx`
- Modify: `src/pages/chat/chat-components.test.tsx`

**Interfaces:**
- Consumes: `ChatFriend`, `FriendIdentity` from `src/components/friends/friend-identity.tsx`, controller `selectConversation` and `runFriendAction` callbacks.
- Produces: fixed desktop panel and accessible narrow-window drawer with Chat/Invite/Join Party menu behavior.

- [ ] **Step 1: Add failing friend action and note tests**

Add a test rendering one friend with note `我能架住`. Assert markup includes `data-friend-note`, a menu trigger with `aria-haspopup="menu"`, translated Chat/Invite/Join labels, and a drawer close button label.

Run: `bun test src/pages/chat/chat-components.test.tsx`

Expected: FAIL because `ChatFriendsPanel` does not exist.

- [ ] **Step 2: Implement the approved click-to-menu interaction**

Render each friend as a row with `FriendIdentity person={friend} showNote`, presence text, and party size. The main row button toggles only that friend's action menu. The menu items call:

```ts
onChat(friend);
onInvite(friend);
onJoin(friend);
```

Resolve Chat with `findFriendConversationCid(friend, conversations)`, then pass the matched Riot-provided CID to `selectConversation`. Disable Chat when no matching Riot-provided direct conversation exists; never synthesize a CID from the friend object. Disable Invite when Riot ID is incomplete and Join when `partyId` is empty. Close the menu after every action and on Escape, returning focus to the friend row trigger.

- [ ] **Step 3: Implement responsive fixed panel and drawer surface**

Use the same list component in both surfaces. The fixed panel is hidden below the selected desktop breakpoint. The drawer is rendered only while open, uses a backdrop, `role="dialog"`, `aria-modal="true"`, translated title, Escape close, outside-click close, and focus return to the header trigger. Prevent the closed drawer from remaining keyboard reachable.

- [ ] **Step 4: Run component tests**

Run: `bun test src/pages/chat/chat-components.test.tsx src/components/friends/friend-identity.test.tsx`

Expected: all Chat and shared FriendIdentity tests PASS.

- [ ] **Step 5: Commit Friends panel and drawer**

```bash
git add src/pages/chat/chat-friends-panel.tsx src/pages/chat/chat-components.test.tsx
git commit -m "feat: add chat friends drawer and actions"
```

---

### Task 7: Compose the rewritten Chat page and restore navigation

**Files:**
- Modify: `src/pages/Chat.tsx`
- Modify: `src/main.tsx`
- Create: `tests/chat-navigation-and-locales.test.ts`

**Interfaces:**
- Consumes: all controller and component interfaces from Tasks 1–6.
- Produces: restored route and complete Chat page shell.

- [ ] **Step 1: Write failing navigation/source integration tests**

Create `tests/chat-navigation-and-locales.test.ts` to read `src/main.tsx`, `src/pages/Chat.tsx`, `src-tauri/src/lib.rs`, and locale JSON. Assert:

```ts
expect(main).toContain('import Chat from "@/pages/Chat.tsx"');
expect(main.indexOf('id: "chat"')).toBeGreaterThan(main.indexOf('id: "friends"'));
expect(main.indexOf('id: "chat"')).toBeLessThan(main.indexOf('id: "replays"'));
expect(main).toContain("component: <Chat />");
expect(rustLib).toContain("commands::chat::chat_history");
expect(chatPage).toContain("useChatController()");
expect(chatPage).not.toContain("removeAllListeners");
```

Run: `bun test tests/chat-navigation-and-locales.test.ts`

Expected: FAIL because the route and rewritten shell are not present.

- [ ] **Step 2: Replace `Chat.tsx` with a thin responsive shell**

Compose the controller and components in this structure:

```tsx
const Chat = () => {
	const chat = useChatController();
	const [friendsDrawerOpen, setFriendsDrawerOpen] = useState(false);
	return (
		<div className="flex h-full min-h-0 bg-black text-gray-200">
			<ChatChannelRail selected={chat.selectedChannel} available={chat.availableChannels} onSelect={chat.selectChannel} />
			<ChatConversationList conversations={chat.conversations} selectedCid={chat.selectedCid} search={chat.conversationSearch} onSearchChange={chat.setConversationSearch} onSelect={chat.selectConversation} />
			<main className="flex min-w-0 flex-1 flex-col">
				<ChatThread {...chat.threadProps} onOpenFriends={() => setFriendsDrawerOpen(true)} />
				<ChatComposer {...chat.composerProps} />
			</main>
			<ChatFriendsPanel {...chat.friendPanelProps} drawerOpen={friendsDrawerOpen} onDrawerClose={() => setFriendsDrawerOpen(false)} />
		</div>
	);
};
```

The actual props must be explicit TypeScript props, not an untyped spread bag. The page shell owns only responsive drawer visibility; polling, selection, messages, errors, and actions remain in the controller.

- [ ] **Step 3: Restore Chat after Friends in `main.tsx`**

Import `Chat`, import `FaComments`, and insert:

```tsx
{
	title: "nav.chat",
	id: "chat",
	icon: <FaComments />,
	component: <Chat />,
},
```

immediately after the Friends route. Do not add a separate Settings toggle; the configured-routes context supplies it automatically.

- [ ] **Step 4: Run integration, navigation, and type tests**

Run: `bun test tests/chat-navigation-and-locales.test.ts tests/navigation-tabs-router.test.ts tests/navigation-tabs-settings.test.ts`

Expected: route/source assertions and existing hide-tab tests PASS.

Run: `bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit Chat shell and route**

```bash
git add src/pages/Chat.tsx src/main.tsx tests/chat-navigation-and-locales.test.ts
git commit -m "feat: restore redesigned chat tab"
```

---

### Task 8: Complete localization and scoped failure states

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `tests/chat-navigation-and-locales.test.ts`
- Modify: `src/pages/chat/chat-thread.tsx`
- Modify: `src/pages/chat/chat-composer.tsx`
- Modify: `src/pages/chat/chat-friends-panel.tsx`

**Interfaces:**
- Consumes: component state props already defined.
- Produces: complete translated copy for loading, unavailable, retry, send, drawer, menus, developer panel, and accessible controls.

- [ ] **Step 1: Add failing locale-key assertions**

For each of `en`, `ko`, and `zh-TW`, assert these keys are non-empty strings:

```ts
[
	"channelFriends", "channelParty", "channelTeam", "channelAll",
	"searchConversations", "searchFriends", "openFriends", "closeFriends",
	"historyLoading", "historyFailed", "retryHistory",
	"partyUnavailable", "teamUnavailable", "allUnavailable",
	"send", "sending", "sendFailed", "retrySend",
	"actionChat", "actionInvite", "actionJoinParty",
	"developerPanel", "refresh", "translate", "translating",
].forEach((key) => expect(messages[key]).toBeString());
```

Run: `bun test tests/chat-navigation-and-locales.test.ts`

Expected: FAIL on the new missing keys.

- [ ] **Step 2: Add English, Korean, and Traditional Chinese copy**

Add natural translations for every asserted key. English source copy uses concise desktop labels, including `Friends`, `Party`, `Team`, `All`, `Load message history again`, `No active team chat room`, and `Open friends panel`. Remove all hard-coded `Search`, `Invite`, `Join Party`, `RESPONSE`, and `RAW` text from Chat components.

- [ ] **Step 3: Connect scoped states to translated actions**

Ensure:

- summary login-required replaces the page body but retains a Refresh button;
- history loading does not cover cached content;
- history errors show Retry inside the thread;
- send errors remain above the composer and leave its value unchanged;
- unavailable Party/Team/All states show the specific translated reason;
- developer payloads are collapsed by default and omit secrets.

- [ ] **Step 4: Run locale, component, and model tests**

Run: `bun test tests/chat-navigation-and-locales.test.ts src/pages/chat/chat-components.test.tsx src/pages/chat/chat-controller-state.test.ts src/pages/chat/chat-model.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit Chat localization and state copy**

```bash
git add src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json tests/chat-navigation-and-locales.test.ts src/pages/chat/chat-thread.tsx src/pages/chat/chat-composer.tsx src/pages/chat/chat-friends-panel.tsx
git commit -m "feat: localize chat states and actions"
```

---

### Task 9: Full verification and cleanup

**Files:**
- Modify only files from Tasks 1–8 if verification exposes a defect.

**Interfaces:**
- Consumes: the complete implementation.
- Produces: verified frontend and Rust build with no legacy listener or old-style regressions.

- [ ] **Step 1: Run all focused Chat/frontend tests**

Run:

```bash
bun test src/pages/chat/chat-model.test.ts src/pages/chat/chat-controller-state.test.ts src/pages/chat/use-chat-controller.test.ts src/pages/chat/chat-components.test.tsx tests/chat-navigation-and-locales.test.ts src/components/friends/friend-identity.test.tsx tests/navigation-tabs-router.test.ts tests/navigation-tabs-settings.test.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run TypeScript and production frontend build**

Run: `bun run build:vite`

Expected: `tsc` and Vite production build both complete successfully.

- [ ] **Step 3: Run Rust formatting, focused tests, and check**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: PASS with no formatting diff.

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests --lib`

Expected: all Chat Rust tests PASS.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS with no compilation errors.

- [ ] **Step 4: Audit the implemented source against non-negotiable behavior**

Run:

```powershell
rg -n "removeAllListeners|bg-\[#25211f\]|bg-\[#1f1b1a\]|type.*system" src/pages/Chat.tsx src/pages/chat src-tauri/src/commands/chat.rs
```

Expected: no `removeAllListeners`, no legacy brown page colors, and no Chat send path that emits `system`.

Run:

```powershell
rg -n "chat_history|chat:history|message_history|unreadCount|@ares-parties|-all@ares-coregame|groupchat" src src-tauri/src/commands/chat.rs src-tauri/src/lib.rs
```

Expected: history IPC, real metadata, exact channel recognition, and group-send behavior are present.

- [ ] **Step 5: Inspect the final diff without touching unrelated work**

Run: `git status --short`

Expected: unrelated pre-existing modifications may remain, but no uncommitted files from Tasks 1–8 remain.

Run: `git log --oneline -9`

Expected: the task commits appear as focused commits after the design/plan commits.

- [ ] **Step 6: Commit verification-only fixes if any were required**

If verification required code changes, stage only the affected Chat files and commit:

```bash
git commit -m "fix: harden restored chat workflow"
```

If no files changed, do not create an empty commit.
