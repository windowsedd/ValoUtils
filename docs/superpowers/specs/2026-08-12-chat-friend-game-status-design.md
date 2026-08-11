# Chat Friend Game Status Design

## Goal

Show each direct-chat friend's current Riot/VALORANT state in the Chat UI instead of using the latest message body as the conversation subtitle.

## User Experience

- Each Friends conversation row uses its second line for the friend's current state.
- The selected direct-chat header shows the same state beneath the Riot ID instead of the generic `FRIENDS` label.
- Party, Team, and All headers keep their existing channel labels.
- The latest-message preview is removed from Friends conversation rows.
- State labels use the existing localized `friends.*` strings.

## State Resolution

One shared frontend resolver converts `ChatFriend` presence data into a semantic status key. The priority is:

1. `Offline` when `isOnline` is false.
2. `In Match` for `sessionLoopState = INGAME`.
3. `Agent Select` for `sessionLoopState = PREGAME`.
4. `In Lobby` for `sessionLoopState = MENUS`.
5. `Away` for Riot presence state `away`.
6. `Online` for all other active states.

Unknown or missing session states safely fall back to `Online` when the friend is online, and `Offline` otherwise. Raw Riot values such as `MENUS`, `PREGAME`, and `INGAME` are never rendered.

## Data Flow

The Riot v4 presence `private` blob stores the current game state under `matchPresenceData.sessionLoopState` (with the blob root retained as a compatibility fallback). The Chat backend will normalize that value into a dedicated `sessionLoopState` field on `ChatFriend`.

`useChatController` already receives normalized `ChatFriend` records. `buildFriendConversations` will attach the matched friend's presence data needed by a conversation. The conversation list and selected-thread header will consume the same resolved semantic state and localized label, preventing the two locations from disagreeing.

## Components

- `src-tauri/src/commands/chat.rs`: read `matchPresenceData.sessionLoopState`, fall back to the blob root for older clients, and expose the normalized field.
- `types/chat.ts`: add `sessionLoopState` to `ChatFriend`.
- `chat-model.ts`: resolve a friend's semantic game-status key and carry the matched friend status on `FriendConversation`.
- `chat-conversation-list.tsx`: replace the latest-message subtitle with the localized status.
- `Chat.tsx` / `chat-thread.tsx`: show the selected friend's localized status under the title; retain channel labels for group chats.

## Testing

- Rust tests cover extraction from `matchPresenceData` and the legacy root fallback.
- Model tests cover Offline, In Match, Agent Select, In Lobby, Away, and Online fallbacks.
- Component tests verify the conversation subtitle shows status rather than message text.
- Component tests verify the direct-chat header shows status while group headers retain their channel label.
- Run the full Bun test suite and production Vite build after the focused tests pass.

## Out of Scope

- Changing Riot presence polling frequency.
- Showing score, map, queue, or party size in conversation rows.
- Reordering conversations based on presence.
