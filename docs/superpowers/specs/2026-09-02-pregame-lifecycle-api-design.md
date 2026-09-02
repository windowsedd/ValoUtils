# Game Lifecycle API Detection Design

## Problem

`onPregame` and `onMatchStart` currently derive their transitions from Riot chat room CIDs. A player can be in Agent Select or a live match while those rooms are absent, late, or unresolved, so lifecycle messages never fire even though the GLZ player endpoints and live template snapshot already report the active phase.

The application also starts the chat/lifecycle poller globally, but the Chat page restarts it on mount and stops it on unmount. Navigating from Chat to In-game Bot can therefore stop lifecycle detection entirely.

## Considered approaches

1. Keep the chat CID trigger and add retries. This remains dependent on an unrelated chat-room signal and cannot represent pregames where the room is unavailable.
2. Reuse the full `live_game_fetch` response. This provides the correct state but performs roster, content, party, and statistics work that a lifecycle edge detector does not need.
3. Query `GET /core-game/v1/players/{puuid}` and `GET /pregame/v1/players/{puuid}` directly and use their `MatchID` values as lifecycle identities. This is the recommended minimal source of truth and matches Riot's actual player game state.

## Design

The backend-owned poller remains active for the application lifetime. The Chat page only consumes chat data and no longer starts or stops that service.

On each poll where any lifecycle command exists, the backend queries the authenticated GLZ core-game player endpoint first. When no active core game exists, it queries the pregame player endpoint. Successful payloads with a non-empty `MatchID` feed those IDs to `LifecycleTracker`. Normal not-in-phase 404 responses feed no ID. Authentication, connection, and unexpected API failures abort that tick without changing tracker state, preventing false edges.

Chat CIDs remain responsible for chat message discovery and routing, but no longer decide whether the player entered pregame or a match. Three consecutive successful observations without the prior core-game match ID retain the existing `onMatchEnd` debounce behavior.

When a command is added during an already active pregame and the backend has not observed that pregame before, the next successful GLZ poll emits `onPregame` once. Repeated polls with the same `MatchID` do not emit duplicates.

## Verification

- A Rust regression test proves lifecycle observation accepts GLZ pregame and core-game IDs independently of chat rooms.
- A frontend source test proves the Chat page no longer owns global poller start/stop.
- Targeted tests run red before implementation and green afterward.
- Full Rust tests, frontend tests, lint, and type/build checks verify no regressions.
