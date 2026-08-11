# Clickable Match Player Profile Modal Design

## Goal

Allow every valid player row in an expanded match scoreboard to open that player's career information without navigating away from the current page.

## Scope

This change applies to the shared `MatchScoreboard`, so the interaction is available wherever expanded match details are rendered: the Matches page, the signed-in player's Career page, and friend profile match history.

The collapsed match card, match filtering, scoreboard columns, match-detail loading, Friends page navigation, and Live Game player table remain unchanged.

## Interaction

Render each scoreboard player row as a semantic button when the player has a non-empty PUUID (`subject`). The button preserves the existing row layout and team/highlight colors, and adds the existing cyan focus ring plus a visible hover state. Clicking anywhere on the row opens the profile modal. Keyboard users can focus the row and activate it with Enter or Space.

The modal remains on top of the current page. It closes through the visible close button, backdrop interaction, or Escape using the existing HeroUI overlay behavior. Closing it returns the user to the same expanded match and scroll position.

Rows without a valid PUUID remain non-interactive and retain the existing visual layout.

## Component Design

`MatchScoreboard` accepts an optional `onPlayerSelect(player)` callback. `ScoreboardRow` renders a button only when this callback is supplied and the player's PUUID is valid. This keeps the scoreboard reusable and prevents it from owning navigation or profile-fetch state.

A new match-player profile modal controller supplies that callback to every current `MatchScoreboard` caller. It uses the existing `DynamicModal` provider and opens a dedicated profile body component for the selected `MatchPlayer`.

The modal body is intentionally separate from the full-page `FriendProfile`. Reusing the full page would also import its page header, back navigation, fixed-height scrolling, friend presence state, and Friends-page cache contract. The modal instead composes the shared rank, Act Rank, and match-history components needed for this context.

## Data Flow

1. The user activates a scoreboard row.
2. The selected row supplies `subject`, `gameName`, `tagLine`, `competitiveTier`, and `playerCard` from the already-loaded match details.
3. The modal body sends `friend:profile:get` with the selected PUUID. This existing backend command accepts any valid Riot PUUID; friendship is not required.
4. The response is accepted only when its PUUID matches the currently selected player, using the existing `acceptedFriendProfile` guard.
5. On success, the modal renders current rank, peak rank, Act Rank seasons, and recent matches.
6. On malformed, login-required, or unavailable responses, the modal shows an inline error and retry action.

Changing or closing the selected player removes the listener owned by that modal body. A late response for another PUUID cannot replace the visible profile.

## Modal Content

The modal heading displays `gameName#tagLine`, falling back to the localized player label when the name is unavailable.

The body contains:

- an identity summary using available match player information;
- current rank and RR;
- peak rank and episode/act label;
- the shared `ActRankPanel` with its season selector;
- the shared `FriendMatchHistory` for recent matches;
- loading, retry, login-required, and unavailable states.

The existing modal width and responsive maximum width are retained. The body scrolls independently within the existing `85vh` limit.

## Nested Scoreboards

Recent matches rendered inside the player modal may still be expanded, but their scoreboard rows do not open a second profile modal. This avoids stacked or recursively replaced profile dialogs and keeps one clear close action.

## Accessibility

- Interactive rows use `<button type="button">`.
- Each row has an accessible label containing the player's Riot ID.
- Focus indication uses the existing cyan focus-ring convention.
- Non-interactive rows are not placed in the tab order.
- Loading and error states remain readable without relying on color alone.

## Testing

Add test-first coverage that verifies:

- a scoreboard row becomes a button when `onPlayerSelect` is supplied;
- activating the row passes the exact selected `MatchPlayer`;
- a missing callback or empty PUUID leaves the row non-interactive;
- the modal requests `friend:profile:get` with the selected PUUID;
- a response for another PUUID is ignored;
- successful, loading, and error states render correctly;
- all three current top-level scoreboard callers wire the selection callback;
- existing match scoreboard rendering remains unchanged apart from the interaction.

Run the focused Bun tests, the full Bun suite, TypeScript compilation, and the Vite production build.
