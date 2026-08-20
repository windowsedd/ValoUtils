# Party and Pregame Chat Routing Design

## Goal

Make translated Party messages appear in VALORANT, and make `team` mean the
player's current team chat in both agent select and a live match.

## User-visible behavior

- `.send party ...` sends to the current Party MUC joined by the game.
- `.send team ...` sends to the Pregame side room during agent select and the
  Coregame side room during a live match.
- `.send pregame ...` remains accepted as a compatibility alias for `team` and
  reports the result as `Sent to Team`.
- A stale Party, Pregame, or Coregame room must not be used.
- The bot reports `Sent` only after the selected XMPP connection accepts the
  write; unavailable rooms return an error instead.

## Routing design

Party routing resolves the current Party CID first. An observed Party MUC can
be selected only when its local room ID matches that current CID. This preserves
the exact room spelling used by the game connection while rejecting cached rooms
from a previous party. If no matching joined Party room exists, the command is
reported unavailable instead of claiming a successful invisible send.

Team routing resolves the current match phase through the existing XMPP match
room synchronizer. A Pregame side room and a Coregame side room are both treated
as `ChatChannel::Team`; the active room's domain determines the transport target.
`ChatChannel::Pregame` remains parser-level compatibility only and is normalized
to Team before room resolution and reply formatting.

The Bot whisper path continues to write one native-shaped groupchat stanza to
the source game connection. It does not use the global outbound broadcast.

## Error handling

- Missing current Party room: return Party unavailable.
- Missing current Pregame/Coregame side room: return Team unavailable.
- XMPP write failure: discard the pending echo entry and return an error reply.
- No fallback to an old observed room or a neighbouring All room.

## Tests

- Party chooses the observed long or short MUC spelling only when its local ID
  matches the currently resolved Party CID.
- Party rejects a stale observed room with a different Party ID.
- Team chooses a Pregame side room during agent select.
- Team continues to choose a Coregame side room during a live match.
- The `pregame` compatibility token normalizes to Team in routing and replies.
- Existing single-connection, native-stanza, and no-global-broadcast tests remain
  green.

