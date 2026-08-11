# Friend Notes Display Design

## Goal

Show each Riot friend's existing note beside their Riot ID in the Friends list. Keep notes read-only and sourced from the current `friends:get` response.

## Scope

Change the Friends frontend and focused tests. The Rust friends command and `Friend.note` type already expose the Riot roster note, so this feature adds no IPC channel, write endpoint, or local storage.

Show notes for accepted friends in every Friends section: playing VALORANT, other Riot games, online elsewhere, party cards, and offline. Do not show notes on incoming or outgoing friend requests.

## Presentation

Render the identity in one line:

```text
GameName#Tag  Note
```

Keep the Riot name white and the tag dimmed. Render a non-empty trimmed note after the tag with `text-gray-500` and normal font weight. The identity row remains a single line. Truncate overflow with an ellipsis and expose the full note through the note span's `title` attribute.

Do not add a note icon, edit button, animation, or extra row height. The friend row keeps its current click target, focus ring, avatar, presence status, and secondary game-status line.

## Search

Include `friend.note` in the existing case-insensitive search text for accepted friends. A search result must match either the display name or note. Keep friend-request search limited to the requester's Riot ID.

## Data Flow

`friends:get` polls every 10 seconds and returns `Friend.note`. `Friends.tsx` renders the latest value from component state. An empty or whitespace-only note renders nothing. A later poll replaces the displayed note when Riot returns a changed value.

## Accessibility

Keep the note as visible text in the existing friend button, so screen readers include it in the button name. Use the `title` attribute only as an overflow aid, not as the sole presentation. Preserve keyboard activation and the existing visible focus ring.

## Verification

Add focused coverage that confirms:

- accepted-friend identities render non-empty notes after the Riot tag;
- empty and whitespace-only notes render no note span;
- long notes use truncation and expose their full trimmed value in `title`;
- friend requests do not render notes;
- search matches accepted friends by note;
- existing friend row click behavior and grouping remain unchanged.

Run the focused Friends tests, TypeScript compilation, and the Vite production build.
