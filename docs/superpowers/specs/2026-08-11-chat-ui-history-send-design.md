# Chat UI, History, and Send Design

## Goal

Restore Chat as a first-class ValoUtils navigation tab and replace the legacy brown, monolithic page with a Riot-style, information-dense desktop chat interface. Preserve friend direct messages, Party chat, Match Team chat, Match All chat, translation, friend party actions, and XMPP live delivery while adding on-demand per-conversation message history through Riot's local Chat API.

## Scope

This change includes the Chat navigation route, frontend UI and state management, focused Rust IPC additions for per-CID history, chat response metadata needed by the UI, locale updates, and tests.

The existing Riot lockfile authentication, Local API request helper, translation providers, XMPP connection, send fallback, and friend-action commands remain the foundation. This is not a replacement chat service and does not persist Riot messages outside the running application.

## Navigation

Add `Chat` immediately after `Friends` in the configured route list, using the existing `nav.chat` translation and a comments/chat icon.

Chat participates in the existing `hiddenTabs` behavior automatically because Settings derives its controls from the configured routes. It can be hidden and restored like every route except Settings. Restoring Chat must not change the current route-id selection rules or the relative order of other tabs.

## Visual Direction

Replace the legacy brown and gray palette with the established ValoUtils black/glass shell:

- near-black page and panel fills;
- subtle white borders and restrained shadows;
- VALORANT red for the primary active state;
- cyan for live/online/status accents;
- white and neutral gray typography matching Friends and Matches;
- visible cyan/white keyboard focus rings.

Do not introduce a 3D, hyperreal, neon-purple, or unrelated sci-fi theme. Motion is limited to short color, opacity, drawer, and hover transitions. The layout must remain stable while polling or switching conversations.

## Information Architecture

Use the approved Riot-style dense layout inside the existing app navigation:

1. **Channel rail** — a narrow column containing Friends, Party, Team, and All.
2. **Conversation list** — a searchable list of recent friend conversations for the Friends channel. For Party, Team, and All, this area shows the selected channel context and availability rather than inventing conversations.
3. **Message thread** — the flexible main region containing the thread header, history/live messages, state messages, and composer.
4. **Friends panel** — online/offline friends and presence details with action menus.

The message thread receives all remaining width. At a narrow desktop breakpoint, automatically remove the fixed Friends panel and expose it as an overlay drawer opened from the thread header. The drawer must trap neither focus nor scrolling when closed, close on Escape, and return focus to its trigger. The channel rail and conversation list remain available so switching threads does not require the drawer.

## Channel and Conversation Behavior

The four channel entries map to real Riot conversations:

- **Friends** — direct-message conversations from `/chat/v6/conversations`.
- **Party** — the active Party conversation from `/chat/v6/conversations/ares-parties`.
- **Team** — the current team room from `ares-coregame`, or `ares-pregame` during agent select. A CID containing `-blue` or `-red` identifies the team room.
- **All** — the current all-chat room from `ares-coregame`. A CID containing `-all` identifies the all room.

The Rust layer remains responsible for resolving and normalizing these CIDs. The frontend consumes explicit channel-to-CID metadata and never constructs a CID.

When no active CID exists, keep the channel visible but show an unavailable state, disable the composer, and provide a channel-specific explanation. Do not silently substitute Team for All or Party for another group room.

The Friends conversation list sorts by the newest normalized message timestamp. Search is case-insensitive and matches Riot ID, tag line, and Riot friend note. Empty and whitespace-only notes render nothing. Non-empty notes use the same compact, truncated note treatment already approved for the Friends page.

## Friend Panel Actions

Clicking a friend opens the approved action menu instead of immediately opening a direct message. The menu contains:

- `Chat` — select that friend's Riot-provided direct-message conversation in the Friends channel. If Riot exposes no usable CID/address for the friend, show a scoped unavailable state rather than constructing a CID in the frontend;
- `Invite` — use the existing `chat:friend-action` invite behavior;
- `Join Party` — use the existing join behavior and surface any returned error.

The panel shows current presence, Riot ID, note, product/game state, and party-size information already available from the friend payload. The Chat-specific friend normalization must retain the Riot roster `note` field so the Chat page does not maintain a second notes store.

## CID-Specific Message History

Add a dedicated history request path rather than expanding the polling summary into an all-conversation prefetch.

When a user selects a Friend, Party, Team, or All conversation:

1. Resolve the selected conversation's actual CID from the normalized Chat summary.
2. Show any cached messages for that CID immediately.
3. Request `GET /chat/v6/messages?cid={cid}` through the existing Riot Local API helper.
4. Normalize the returned `messages[]` into `ChatMessage` values.
5. Merge the result with live XMPP messages for the same CID.
6. Deduplicate with CID plus Riot message ID when available; use a stable fallback containing timestamp, sender, and body only when the API provides no ID.
7. Sort chronologically using the parsed Riot millisecond timestamp, while retaining deterministic order for missing or equal timestamps.

Cache normalized history by CID for the current Chat page lifetime. Re-selecting a previously opened conversation renders the cache immediately and refreshes it in the background. Do not prefetch every CID when Chat opens.

The existing five-second Chat summary refresh continues to update rooms, conversations, friends, and live messages. Only refresh full CID-specific history for the currently selected conversation. A stale history response must not replace the visible thread after the user has switched to another CID, although it may safely populate that CID's cache.

The Party conversation metadata fields `message_history`, `unread_count`, mute state, and UI state should be preserved when returned. Use Riot's real unread value where applicable; do not fabricate unread badges. Treat `message_history` as metadata, not as permission to construct or guess a history response.

## Send Message

Send through the documented Riot Local API endpoint:

```text
POST /chat/v6/messages
```

with:

```json
{
  "cid": "selected conversation CID",
  "message": "message body",
  "type": "chat or groupchat"
}
```

Use `chat` for Friend direct messages and `groupchat` for Party, Team, and All. Do not use `system`. The backend should derive the type from the resolved room kind/CID and must not trust a caller-provided arbitrary message type.

Preserve the existing REST-first behavior and Party/Match XMPP fallback. On success, merge the returned or locally reconstructed sent message into the selected CID cache, then refresh that CID's history in the background. On failure, keep the draft intact, restore composer focus, and expose a retryable inline error. Prevent duplicate submissions while a send is pending.

The composer is a multiline text area. `Enter` sends and `Shift+Enter` inserts a newline. It is disabled when the Riot Client is unavailable, the user is not logged in, no CID is selected, or a selected group room is unavailable. Whitespace-only messages are not sent.

## Message Thread Interaction

Render messages oldest-to-newest. Align the user's messages right and other messages left, with sender identity and time available without opening debug data. Match messages retain a Team or All channel label when useful.

Translation remains a per-message action and stores its result against the stable message identity. Translation failure is local to the affected message and does not replace the whole thread with an error.

Auto-scroll to the newest message when selecting a conversation. For subsequent updates, auto-scroll only if the viewer was already near the bottom or the user just sent a message. Preserve scroll position while the user reads earlier history.

Move processed/raw payload inspection out of ordinary bubble clicks. Keep it in a compact developer/debug panel so normal chat interactions do not expose large JSON blocks accidentally.

## State and Failure Handling

Provide distinct states for:

- initial Chat loading;
- selected history loading with cached content available;
- Riot Client not running;
- Riot Client running but not logged in;
- summary refresh failure;
- history failure for one CID;
- send failure;
- no friend conversations;
- no active Party, Team, or All CID.

History or send failures must remain scoped to the selected thread. A failed history refresh keeps cached/live messages visible. Retry controls repeat only the failed operation. Stopping the Riot Client maps to the existing friendly login-required state instead of showing a raw `https://127.0.0.1:{port}` request error.

## Frontend Structure

Replace the monolithic `Chat.tsx` implementation with a thin page shell and focused modules. The exact filenames may follow repository conventions, but responsibilities remain separate:

- a Chat data hook/controller for IPC lifecycle, summary polling, per-CID caches, history requests, send, translation, and friend actions;
- pure selectors/helpers for conversation grouping, CID/channel mapping, sorting, deduplication, searching, and near-bottom scroll decisions;
- channel rail;
- conversation list;
- message thread and message row;
- composer;
- Friends panel and responsive drawer;
- compact developer panel.

Register each IPC listener once per mounted controller and clean up only that owned listener. Avoid broad `removeAllListeners` calls that can remove listeners owned by another component or pending operation. Correlate history/send responses to their CID or request identity so out-of-order responses are safe.

## Backend and IPC Contract

Keep `chat:get` as the lightweight summary endpoint. Extend its normalized output where needed with:

- explicit Friend direct-message conversation metadata;
- Party, Team, and All CID metadata without fallback substitution;
- Riot-provided unread/history metadata;
- friend notes.

Add a CID-specific history IPC operation that validates a non-empty CID, calls the already available `get_chat_messages(..., Some(cid))`, normalizes messages through the same path as the summary, and returns the CID with the response. The response distinguishes login-required, unavailable-room, and generic request failures.

Update `chat:send` to return enough normalized sent-message/transport data for immediate UI reconciliation when Riot supplies it. Preserve the current REST-first and XMPP fallback behavior. Never return lockfile credentials, Local API authorization headers, or raw secrets to the frontend/debug panel.

## Accessibility

- Every channel, conversation, friend, message action, drawer control, and send control is keyboard reachable.
- Icon-only buttons have translated accessible names and visible focus states.
- Selected channels and conversations expose their selected state semantically.
- Friend menus support Escape and sensible focus return.
- The thread uses an appropriate log/feed semantic without announcing every five-second refresh as a completely new page.
- Presence and unavailable states are not conveyed by color alone.
- Interactive targets are at least 32 px in this dense desktop interface, with primary actions targeting 40 px where space permits.

## Localization

Retain and revise existing Chat strings across English, Korean, and Traditional Chinese. Add translated labels for channel rail items, Friends drawer, history loading/retry, unavailable rooms, send retry, action menu Chat, developer panel, and accessible control names. Replace the hard-coded English `Search`, `Invite`, and `Join Party` strings in the legacy page.

## Verification

Add focused tests for:

- Chat route order and participation in hide-tab controls;
- direct-message grouping and newest-message sorting;
- Riot ID, tag, and note search;
- note rendering and truncation;
- Party, Team, and All CID extraction without cross-channel substitution;
- CID history request/response correlation;
- normalization, chronological sorting, and deduplication of REST history plus XMPP messages;
- per-CID cache behavior when switching quickly;
- real unread metadata preservation;
- Friend=`chat` and Party/Team/All=`groupchat` send typing;
- send success reconciliation and failure draft retention;
- near-bottom auto-scroll decisions;
- listener registration and cleanup;
- responsive Friends drawer accessibility;
- all required locale keys.

Run focused frontend tests, TypeScript checking, the Vite production build, Rust formatting/checks, and focused Rust tests for CID resolution/history/send behavior before completion.

## API References

- [Chat History](https://valdocs.prometheuz.me/endpoint/chat-history)
- [Party Chat Info](https://valdocs.prometheuz.me/endpoint/party-chat-info)
- [Send Chat](https://valdocs.prometheuz.me/endpoint/send-chat)

These are unofficial endpoint documents. Runtime behavior and observed Riot Client payloads remain authoritative, so normalization must tolerate missing/null fields and compatible casing variants already handled elsewhere in `chat.rs`.

## Out of Scope

- Persisting or exporting Riot chat history outside the current app session
- Fetching every conversation's history when Chat opens
- Fabricated unread counts or delivery/read receipts
- Editing Riot friend notes from Chat
- Sending `system` messages
- Voice chat, attachments, reactions, or rich embeds
- Replacing Riot/XMPP chat transport with a ValoUtils-hosted service
