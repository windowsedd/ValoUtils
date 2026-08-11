# Chat Realtime Friend Presence Design

## Goal

Make the Chat friend list match Riot Client's live Online/Offline state across Riot Client, League of Legends, and VALORANT. A friend who has gone offline must stop appearing Online without relying on a timestamp timeout or a stale local REST snapshot.

## Problem

The Chat page currently polls Riot's local `/chat/v4/presences` endpoint every five seconds. That endpoint can retain an old `state: chat` resource long after its owner has disconnected, so faster polling only returns the same stale record. The social friend endpoints expose the same stale state and do not provide a dependable replacement.

ValoUtils already maintains an authenticated Riot XMPP connection for party and match chat. Riot sends roster presence changes over that connection, including `unavailable` stanzas when a resource disconnects. Extending that connection gives Chat an event-driven source instead of inferring liveness from cached HTTP data.

## User Experience

- Opening Chat starts the XMPP presence session even when the user is not in a party or match.
- During the initial roster sync, friend rows show a neutral `Checking...` state rather than an unverified Online state.
- After sync, a friend is Online when at least one active Riot Client, League of Legends, or VALORANT XMPP resource exists.
- A friend becomes Offline immediately after the last active resource sends `unavailable`.
- VALORANT resources retain the existing In Lobby, Agent Select, In Match, Away, and Online labels when their live game data provides those states.
- Riot Client or League resources count as Online. They fall back to Online or Away when no supported detailed state is available.
- When the XMPP connection drops, the UI shows `Reconnecting...` and does not present the old resource map as confirmed live state.
- Party, Team, and All chat behavior remains unchanged.

## Presence Authority

XMPP is authoritative for whether a friend is live. The REST friend roster remains responsible for identity and metadata such as PUUID, Riot ID, notes, and friend relationship.

REST presence data may supplement details only for a resource that XMPP has already confirmed active. It must never create an Online friend or keep a friend Online after XMPP removes their last resource. Prefer game data included in the XMPP presence stanza when available.

This separation prevents the original bug: a cached REST record can enrich a verified live resource, but cannot establish liveness by itself.

## Resource Model

Presence is tracked per friend and per XMPP resource rather than as one boolean per friend:

```text
friend PUUID
  resource JID / resource name
    product
    availability
    status/game data
```

An available presence stanza inserts or replaces that resource. An `unavailable` stanza removes only the matching resource. A friend is Offline only when no supported active resources remain. This handles users signed into multiple Riot products or processes without flickering Offline when one resource closes.

Supported products are Riot Client/Keystone, League of Legends, and VALORANT. Unknown Riot products can be retained internally for diagnostics but do not silently change the agreed Online definition.

## Initial Synchronization

The XMPP login already sends the user's initial presence and requests the Riot roster. The client will add a presence sync lifecycle:

1. Mark the snapshot as `syncing` and clear any state from a dead connection.
2. Parse the roster response and the initial burst of friend presence stanzas.
3. After the roster response has arrived and the incoming presence stream has been quiet for a short bounded settle window, publish an authoritative `ready` snapshot.
4. Treat roster friends without an active resource in that snapshot as Offline.
5. Apply every later presence stanza as an immediate delta and publish the updated snapshot.

The settle window is only for defining the end of the initial server burst; it is not an offline timeout. A late stanza still updates the friend immediately.

## Backend Architecture

`src-tauri/src/xmpp/client.rs` will extend the existing background stanza reader:

- Parse top-level presence and roster IQ stanzas alongside group-chat messages.
- Normalize available/unavailable resource events into a small serializable presence type.
- Keep the stanza parser independent of Tauri so it can be unit tested with captured-shaped XML fixtures.
- Publish presence events through a broadcast channel, following the existing message-event pattern.

`src-tauri/src/xmpp/mod.rs` will own the connection-level presence state:

- Add an explicit `ensure_connected` path used by Chat, independent of party or match membership.
- Maintain the resource map and sync state for the current XMPP connection generation.
- Discard events from an older connection generation after reconnect.
- Clear confirmed liveness when the connection dies, transition to reconnecting, and reconnect through the existing fresh-login path.
- Expose a snapshot for `chat_get` and a subscription for push events.

`src-tauri/src/commands/chat.rs` will combine the REST friend roster with the XMPP snapshot:

- Ensure the XMPP session when Chat data is requested.
- Use XMPP resources as the sole liveness authority once a snapshot is ready.
- Forward normalized presence updates to the frontend through a `chat:presence` Tauri event.
- Preserve the existing normalized friend shape where practical, adding explicit sync/product fields as needed.

## Frontend Data Flow

The initial `chat:get` response contains friends plus the current presence sync state. The Chat controller continues its existing polling for history and room metadata, but subscribes to `chat:presence` for immediate friend updates.

Presence events update the controller's friend records in place. The conversation list and selected-thread header continue to consume the same shared friend-status resolver, so both locations change together. Event listeners are registered once and removed when the Chat page unmounts.

The frontend distinguishes these states:

- `syncing`: initial XMPP roster is not authoritative yet (`Checking...`).
- `ready`: Online/Offline and game state are authoritative.
- `reconnecting`: the live connection was lost (`Reconnecting...`).

If the Riot Client is not running or authentication fails, the existing Chat error handling remains responsible for the page-level error; cached REST presence is not shown as live truth.

## Reconnection and Failure Handling

- A socket read/write failure marks the handle dead and invalidates its confirmed resource map.
- The next Chat refresh starts a fresh XMPP login; implementation may add bounded backoff to prevent rapid retry loops.
- Each login receives a monotonically increasing connection generation. Events from a prior generation cannot repopulate the new map.
- Malformed presence stanzas are ignored and logged in diagnostics without terminating message chat.
- Message buffering and party/match room membership continue using the existing XMPP handle and reconnect behavior.

## Testing

Rust tests will cover:

- Parsing available Riot Client, League, and VALORANT presence stanzas.
- Parsing `unavailable` and removing only the addressed resource.
- Keeping a friend Online while another supported resource remains.
- Making a friend Offline after the final supported resource disappears.
- Initial sync completion and friends absent from the active-resource set.
- Connection generation isolation and map invalidation on disconnect.
- VALORANT game-state extraction from live XMPP data and safe fallback behavior.
- Existing group-chat message parsing after presence support is added.

Frontend/model tests will cover:

- `Checking...`, Online, Offline, Away, VALORANT states, and `Reconnecting...`.
- A pushed presence event updating both the friend row and selected-thread header without waiting for the polling interval.
- Listener cleanup and duplicate-event safety.

After focused tests pass, run the full Bun test suite, the production Vite build, focused Rust tests, `cargo check`, and Rust formatting verification. Live verification must include taking a test friend offline and confirming the UI changes after the XMPP `unavailable` event.

## Out of Scope

- Using an inactivity timestamp to guess that a friend is Offline.
- Treating the stale local REST presence endpoint as authoritative.
- Rewriting party, team, or all-chat messaging.
- Adding detailed League match phases, scores, maps, or queue information.
- Running presence monitoring while Chat has never been opened during the current app session.
