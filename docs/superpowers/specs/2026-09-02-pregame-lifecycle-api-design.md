# Pregame Lifecycle API Detection Design

## Problem

`onPregame` currently derives its transition from the Riot chat pregame-room CID. A player can be in Agent Select while that room is absent, late, or unresolved, so the lifecycle message never fires even though the GLZ pregame player endpoint and live template snapshot already report the active pregame.

The application also starts the chat/lifecycle poller globally, but the Chat page restarts it on mount and stops it on unmount. Navigating from Chat to In-game Bot can therefore stop lifecycle detection entirely.

## Considered approaches

1. Keep the chat CID trigger and add retries. This remains dependent on an unrelated chat-room signal and cannot represent pregames where the room is unavailable.
2. Reuse the full `live_game_fetch` response. This provides the correct state but performs roster, content, party, and statistics work that a lifecycle edge detector does not need.
3. Query `GET /pregame/v1/players/{puuid}` directly and use its `MatchID` as the lifecycle identity. This is the recommended minimal source of truth and matches Riot's actual player pregame state.

## Design

The backend-owned poller remains active for the application lifetime. The Chat page only consumes chat data and no longer starts or stops that service.

On each lifecycle poll where an `onPregame` command exists, the backend queries the authenticated GLZ pregame player endpoint. A successful payload with a non-empty `MatchID` feeds that ID to `LifecycleTracker`. A normal not-in-pregame 404 feeds no ID. Authentication, connection, and unexpected API failures abort that tick without changing tracker state, preventing false edges.

Core-game start/end detection remains unchanged in this bug fix. Chat CIDs remain responsible for chat message discovery and routing, but no longer decide whether the player entered pregame.

When a command is added during an already active pregame and the backend has not observed that pregame before, the next successful GLZ poll emits `onPregame` once. Repeated polls with the same `MatchID` do not emit duplicates.

## Verification

- A Rust regression test proves lifecycle observation accepts the GLZ pregame ID and ignores a conflicting/missing chat pregame room.
- A frontend source test proves the Chat page no longer owns global poller start/stop.
- Targeted tests run red before implementation and green afterward.
- Full Rust tests, frontend tests, lint, and type/build checks verify no regressions.
