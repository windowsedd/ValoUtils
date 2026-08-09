# Deceive Controller and Real FakePlayer Design

## Goal

Replace ValoUtils' local dummy-bot simulator with a single Deceive-style FakePlayer that exists inside the Riot client's XMPP roster and chat. Extend the presence relay with the applicable lifecycle and status-control behavior from Deceive's `MainController.cs`. Also compact the expanded live-player layout shown in the scouting table.

## Scope

### Real XMPP FakePlayer

- The existing stable FakePlayer identity is injected into Riot's roster and publishes a complete multi-product presence.
- The Riot client can open a direct conversation with the injected player.
- Messages addressed to the FakePlayer are consumed locally by the XMPP relay and never forwarded to Riot's upstream server.
- Replies are written back through the local Riot-client TLS connection, so they are visible in the Riot client.
- ValoUtils records the same intercepted commands and generated replies for diagnostics. It does not synthesize a second conversation.

### Chat commands

Commands are case-insensitive and accept an optional `$` prefix:

- `online`: enable masking and appear online.
- `offline`: enable masking and appear offline.
- `mobile`: enable masking and appear mobile.
- `enable`: enable presence masking using the selected status.
- `disable`: stop masking and pass the user's original presence through unchanged.
- `status`: report whether masking is enabled and which status is selected.
- `help`: return the complete command list.

Any other body-bearing message returns the same help text. Receipts, chat-state notifications, and other bodyless bot-directed stanzas are consumed silently. No bot-directed stanza may reach Riot upstream.

Changing status immediately rewrites and resends the most recently captured global presence on every active XMPP connection. The FakePlayer responds with a confirmation in the same Riot conversation.

### Controller state and lifecycle

The controller owns:

- whether masking is enabled;
- the selected presence mode (`online`, `offline`, or `mobile`);
- the startup preference (`online`, `offline`, `mobile`, or remember last);
- whether MUC/lobby presence is forwarded;
- active relay connections and their local writers;
- the most recent original global presence;
- the real FakePlayer transcript used for diagnostics.

Selected status, enabled state, startup preference, and MUC preference are persisted through `ConfigStore`. Status changes from the Tauri UI and from in-game chat use the same controller method and broadcast path.

When masking is disabled, the original global presence passes through without modification. MUC presence remains independent: it is forwarded when lobby chat is enabled and suppressed when disabled.

The controller sends a one-time welcome/help message after the FakePlayer has been inserted and the connection is ready. It does not clone Deceive's WinForms tray implementation, process termination, modal retry dialogs, or forced shutdown because Tauri already owns application lifecycle and UI.

### Simulator removal

- Remove local simulator mutation commands, generated echo replies, fabricated offline/online state, and simulator-only quick controls.
- Keep the existing diagnostics page only as a read-only view of relay health, selected presence state, and the real FakePlayer transcript.
- If Riot is not connected through the proxy, the page shows that in-game chat is unavailable instead of pretending commands succeeded.

### Compact live-player details

- Keep the collapsed player row unchanged.
- Replace the tall recent-statistics card with a compact horizontal strip using the existing dense dashboard styling.
- Use an 8px spacing rhythm in the expanded region and reduce redundant padding.
- Reduce skin-card image and vertical dimensions without reducing clickable targets.
- Make recent match history span the full available width so CSS grid auto-placement cannot leave an unused column.
- Preserve responsive behavior, keyboard focus, `aria-expanded`, and reduced-motion support.

## Components and data flow

1. Riot sends a global presence to the local relay.
2. The connection stores the untouched stanza and extracts the Valorant client version.
3. The controller chooses pass-through or the selected rewrite based on `enabled` and broadcasts status changes to every connection.
4. Riot's upstream server receives the rewritten user presence, while the local Riot client separately receives the injected FakePlayer roster and presence stanzas.
5. A direct message to the FakePlayer is classified before upstream forwarding.
6. The controller executes recognized commands or selects help for unknown text.
7. The command and response are appended to the shared real transcript.
8. The reply is written to each relevant local Riot connection with a unique message id and timestamp.

## Error handling and safety

- Upstream Riot TLS remains hostname-verified against public roots.
- Local TLS continues using the validated, cached Deceive PFX.
- Bot message parsing is bounded by the existing XMPP frame limit.
- Invalid XML addressed to the FakePlayer closes or consumes the local connection path rather than leaking the stanza upstream.
- A status command can update controller state before a presence has been captured; the new mode is applied when the next global presence arrives.
- Transcript storage is bounded and contains message bodies only; it does not log Riot tokens or unrelated XMPP stanzas.

## Testing

- Unit tests cover optional command prefixes, enable/disable, status/help text, and unknown-message help fallback.
- Relay tests prove every bot-directed message, receipt, IQ, presence, and malformed targeted stanza is absent from upstream output.
- Controller tests prove enabled pass-through behavior, persistent selected mode, and broadcast updates.
- Transcript tests prove in-game commands and generated replies share one bounded record.
- UI tests or component assertions cover removal of simulator controls and compact expanded-player class/layout behavior.
- Existing presence-proxy, client-config, formatting, production compilation, and live PFX validation checks remain required.

## Non-goals

- Sending FakePlayer traffic to Riot servers.
- Reimplementing WinForms tray menus or Deceive's process-killing behavior.
- Creating a second local-only bot identity or conversation.
- Changing the collapsed scouting-table columns or visual identity.
