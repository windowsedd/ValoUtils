# Group Chat Room Repair Design

## Problem

ValoUtils currently exposes Party, Team, and All as group-chat conversations, but two Riot API changes make the workflow fail:

- `GET /parties/v1/parties/{partyId}/muctoken` returns 404. The supported party-details response now exposes the group room as `MUCName`.
- Team and All rooms discovered through XMPP are synthesized into the conversation list. Selecting them incorrectly calls `GET /chat/v6/messages?cid=...`; Riot's REST conversation store does not contain these group rooms and returns 404.

Friend conversations are unaffected and continue to use Riot's REST message-history endpoint.

## Design

### Party room discovery

Fetch the active party using the existing player-to-party lookup, then fetch party details and read `MUCName`. Use that value as the Party XMPP room. Joining the room will use the existing XMPP client without the removed MUC-token request.

Party diagnostics must retain failures from party lookup, party-details lookup, and XMPP joining instead of converting them to missing optional values. This keeps the Developer data panel useful when Riot changes the API again.

### Group history behavior

Add explicit conversation metadata indicating whether REST history is supported. Riot-provided direct conversations support it. Synthesized Party, Team, and All conversations do not.

The frontend requests `chat:history` only for conversations whose metadata permits REST history. Group rooms display messages already returned by the summary and messages received through the existing realtime XMPP event stream. They therefore show messages observed while ValoUtils is connected, without presenting a false 404 error.

Sending behavior is unchanged: direct chats use the Riot Local REST endpoint and group chats use XMPP.

## Data flow

1. `chat_get` discovers direct conversations from Riot Local REST.
2. Match XMPP setup supplies Team and All room IDs.
3. Party GLZ details supply `MUCName`, which Party XMPP setup joins.
4. The backend merges those rooms into conversation metadata with `supportsHistory: false` for group rooms.
5. The frontend selects rooms normally, but requests REST history only when `supportsHistory` is true.
6. Summary and realtime XMPP messages populate Party, Team, and All threads.

## Error handling

- A missing active party leaves Party unavailable.
- A party-details or join failure leaves Party unavailable and is reported in `_partyXmppDebug`.
- Group rooms never surface REST-history 404s because no unsupported request is made.
- Direct-chat history failures retain the current retry UI.

## Testing

- Rust unit tests cover extracting `MUCName` and preserving group conversation metadata as history-ineligible.
- Frontend unit tests cover the history-request decision for direct versus group conversations.
- Existing Rust and frontend tests must remain green, followed by Rust type-checking and the frontend production build.

## Scope

This change does not attempt to reconstruct group messages sent before ValoUtils connected, because Riot's current REST store does not expose those group conversations. It does not change friend chat, translation, presence, or group-message sending.
