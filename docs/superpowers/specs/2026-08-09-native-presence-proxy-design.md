# Native Riot Presence Proxy Design

## Goal

Add Deceive-style presence control to ValoUtils without bundling or copying Deceive. Users can appear Online, Offline, or Mobile while Riot chat, party chat, lobby chat, and game features continue to work.

Users control presence through two paths:

- Send `$online`, `$offline`, `$mobile`, `$status`, or `$help` to the ValoUtils bot in Riot chat.
- Click the account presence indicator in the ValoUtils title bar and select a mode.

Both paths call one Rust presence controller. ValoUtils remembers the selected mode and uses Offline when no saved mode exists.

## Scope

### Included

- Extend the existing local Riot client-config proxy.
- Add a native Rust TLS/XMPP relay.
- Filter outbound global presence stanzas.
- Promote the existing synthetic bot into the relayed Riot roster.
- Add Tauri commands and title-bar controls for presence.
- Persist the selected presence mode.
- Report listener, connection, and rewrite failures in the UI.
- Add unit and integration-style tests that do not require a Riot account.

### Excluded

- Bundling or controlling the Deceive executable.
- Copying GPL-3.0 source from Deceive.
- Hiding party membership from Riot services.
- Changing party, lobby, match, or direct-message behavior.
- Supporting League of Legends, Legends of Runeterra, or 2XKO.
- Claiming compatibility with future Riot Client protocol changes.

## Architecture

### Client-config proxy

`src-tauri/src/client_config.rs` remains the entry point used by `--client-config-url`.

For successful JSON configuration responses, it will:

1. Record Riot's original `chat.host`, `chat.port`, and `chat.affinities` values.
2. Resolve the signed-in account's affinity from the Riot PAS chat token when the request supplies an authorization header.
3. Select the affinity host, falling back to `chat.host` when affinity resolution fails.
4. Store the selected upstream host and port in shared proxy state.
5. Rewrite `chat.host` and every `chat.affinities` value to `127.0.0.1`.
6. Rewrite `chat.port` to the local relay port.
7. Set `chat.allow_bad_cert.enabled` to `true` so Riot Client accepts the relay certificate.

Non-JSON responses, unsuccessful upstream responses, and unrelated configuration fields pass through unchanged. The proxy never logs authorization or entitlement headers.

### XMPP relay

A new `src-tauri/src/presence_proxy/` module owns the local TLS listener and relayed connections.

For each Riot Client connection, the relay:

1. Accepts the local TLS connection with an in-memory ValoUtils-generated certificate whose subject alternative names cover `127.0.0.1` and `localhost`.
2. Opens a verified TLS connection to the selected Riot chat server.
3. Forwards both directions while buffering enough bytes to identify complete XMPP stream elements.
4. Sends server traffic to Riot Client unchanged except for the synthetic bot roster and presence injection.
5. Sends client traffic to Riot unchanged except for global presence rewriting and bot-addressed messages.

The relay treats XMPP as a long-lived XML stream. It must handle partial elements and several elements in one socket read. It must not assume one read equals one stanza.

### Presence controller

One process-wide `PresenceController` owns:

- Selected mode: `online`, `offline`, or `mobile`.
- The latest unmodified global presence stanza from Riot Client.
- Active relay connection writers.
- Relay lifecycle and upstream connection status.

When a caller changes the mode, the controller persists it and reapplies the latest captured presence to each active connection. New connections use the selected mode when Riot Client sends its first global presence.

## Presence Rules

The relay changes global presence stanzas only. A presence stanza with a `to` attribute, including party or match MUC presence, passes through unchanged.

### Online

Forward Riot Client's latest global presence without modification. This restores game and Riot Client presence details.

### Offline

- Set `<show>` to `offline`.
- Remove the free-form `<status>` value.
- Remove the VALORANT, Riot Client, Keystone, and other game product elements from `<games>`.
- Keep the enclosing stanza valid and forward it to Riot.

### Mobile

- Set `<show>` to `mobile`.
- Remove the free-form `<status>` value.
- Remove VALORANT game details that would reveal an active PC session.
- Remove other PC game product elements.
- Keep the minimal Riot identity fields needed for a mobile presence.

If ValoUtils cannot parse a possible global presence stanza, it forwards the original bytes and reports a rewrite warning. It does not drop the stanza or disconnect chat.

## ValoUtils Bot

The relay reuses the existing synthetic PUUID from `dummy_bot.rs`. It promotes the bot from a ValoUtils-only test fixture into a local XMPP control contact while the presence relay runs.

Server-to-client handling will:

- Add one bot roster item to the initial roster result.
- Send a synthetic online presence for the bot after roster injection.
- Avoid forwarding bot traffic to Riot.

Client-to-server handling will intercept direct messages addressed to the bot and support:

| Command | Result |
| --- | --- |
| `$online` | Select Online and resend presence. |
| `$offline` | Select Offline and resend presence. |
| `$mobile` | Select Mobile and resend presence. |
| `$status` | Report selected mode, relay state, and upstream connection state. |
| `$help` | List the supported presence commands. |

The relay sends bot replies back to Riot Client as synthetic direct messages. Riot never receives the fake PUUID or message body.

Existing dummy-bot testing commands remain available inside the development-only ValoUtils page. Presence commands use the shared controller instead of changing the bot fixture's own simulated online flag.

The XMPP control contact is enabled whenever the relay runs. The existing `dummyBot` development flag controls the test page and its simulated data only; it does not hide or disable the relay control contact.

## Tauri IPC and UI

Add two commands following existing JSON-string IPC conventions:

- `presence_status_get` returns the selected mode, config listener state, relay listener state, active connection count, upstream host availability, and the last warning.
- `presence_status_set([mode])` validates the mode, updates the controller, persists it, and reapplies presence.

The top-right `RiotStatusBar` keeps its account connectivity indicator. When Riot Client is connected through the relay, clicking the presence control opens Online, Offline, and Mobile choices. The selected choice has a check mark and color. The menu disables changes and explains the reason when the relay has no active Riot XMPP connection.

The Dummy Bot page will show config-proxy and XMPP-relay readiness before launch. The launch button starts both listeners before spawning Riot Client.

Each successful UI mode change sends the existing analytics event mechanism a presence-mode action without account identifiers.

## Startup, Shutdown, and Recovery

`riot_launch_with_config` will:

1. Confirm Riot Client is closed.
2. Bind the XMPP relay to an operating-system-assigned loopback port.
3. Start the XMPP relay listener.
4. Start the client-config proxy on its existing fixed port `8000` with the assigned relay port in shared state.
5. Launch Riot Client with the local config URL.

If port `8000` is unavailable or the relay listener fails, ValoUtils stops any listener started by that attempt and does not launch Riot Client.

The relay keeps listening across Riot Client reconnects. Each connection resolves the latest stored upstream target. A failed upstream connection closes only that relayed session and updates status so Riot Client can retry.

ValoUtils warns users before app exit when an active relayed connection exists because closing ValoUtils will disconnect Riot chat. Normal app shutdown closes active sockets and both listeners.

## Persistence

Store `presenceMode` in the existing ValoUtils config store. Accepted values are `online`, `offline`, and `mobile`. Missing or invalid values resolve to `offline`.

Do not persist access tokens, PAS tokens, upstream authorization headers, raw XMPP streams, or presence blobs.

## Security

- Bind the config proxy and XMPP relay to loopback only.
- Keep the generated TLS private key in process memory.
- Verify Riot's upstream TLS certificate with the existing rustls root store.
- Redact credentials and token-bearing stanzas from logs.
- Bound all XML buffers and reject oversized stanzas to prevent unbounded memory use.
- Escape XML in bot names, commands, and replies.
- Forward malformed traffic instead of attempting unsafe string replacement.

## Error Handling

The backend exposes these conditions as status fields and user-facing errors:

- Config or relay port unavailable.
- Upstream chat target unavailable because config has not arrived.
- PAS affinity lookup failure with fallback host use.
- Local TLS handshake failure.
- Riot upstream DNS, TCP, or TLS failure.
- XMPP element exceeds the configured buffer limit.
- Presence parse or rewrite warning.
- Invalid presence mode from IPC or bot input.

Expected failures return `{ success: false, error }` through IPC. Background relay errors update shared status and emit a Tauri event so the UI can refresh without polling delays.

## Testing

### Unit tests

- Patch representative client-config JSON for legacy host and affinity layouts.
- Preserve unsuccessful and malformed config responses.
- Redact credential headers from diagnostic output.
- Split XMPP elements across arbitrary byte boundaries and combine several elements in one read.
- Pass `to`-addressed MUC presence unchanged.
- Rewrite representative global presence for all three modes.
- Preserve the original global presence for Online restoration.
- Parse bot commands case-insensitively after trimming whitespace.
- Keep bot messages out of the upstream byte stream.
- Reject invalid IPC modes without changing stored state.

### Local relay tests

Use an in-process mock TLS chat server and client to verify bidirectional forwarding, reconnect handling, live mode changes, bot roster injection, and bot replies. Tests use generated certificates and require no Riot account.

### Manual Riot verification

With a test account:

1. Launch Riot Client through ValoUtils.
2. Confirm friends, direct chat, party invites, agent-select chat, and match chat still work.
3. Verify Online, Offline, and Mobile from a second account.
4. Change each mode through the UI and bot.
5. Restart Riot Client and confirm the saved mode applies.
6. Restart ValoUtils during an active relay and confirm the warning and expected chat disconnect.

Live Riot verification remains a manual check because Riot's chat API and XMPP protocol are private and can change.

## Licensing

Deceive provides the behavioral reference and uses GPL-3.0. ValoUtils will implement the documented network behavior in new Rust code. Contributors must not paste, translate, or mechanically port Deceive source. The implementation may cite the Deceive repository as protocol research and prior art.
