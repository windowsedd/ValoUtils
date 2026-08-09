# Live Game scouting table redesign

## Goal

Redesign the Live Game tab as a dense scouting table. The page must show the current match context, team balance, parties, skins, and recent competitive performance without delaying the base roster.

## Scope

The redesign covers party, agent select, active match, idle, login-required, and error states. It expands the Rust response model and adds progressive recent-stat events. It keeps the existing five-second live-state poll.

Recent statistics use each player's last five completed competitive matches. The summary includes K/D, win rate, average combat score, and the number of matches analyzed. A player with fewer than five qualifying matches displays the available sample size.

The page does not predict match outcomes, expose hidden Riot data, or treat incomplete party detection as authoritative.

## Information hierarchy

The selected layout is the dense scouting table from mockup B.

1. A compact match bar shows map, mode or queue, current phase, and refresh state.
2. Four summary cells show ally rank average, enemy rank average, detected parties, and roster size.
3. The roster table groups rows by team and keeps both teams in one scroll surface.
4. Each row shows player and agent, party marker, current rank and RR, peak rank, recent K/D, recent win rate, recent ACS, and compact skin previews.
5. Clicking a row expands it in place. The expanded area shows Vandal, Phantom, and knife skin names and images, the recent-stat sample size, aggregate kills/deaths/assists, and any per-player load error.

Team color appears in a text label and row accent so color is not the sole team indicator. Party members share a marker color and a written party label. Unknown or hidden values use a dash and an accessible explanation.

## Responsive behavior

The desktop table shows all scouting columns. At narrower app widths, the page keeps player, agent, team, rank, K/D, and win rate visible. It moves peak rank, ACS, and skin details into the expandable area. The table must not create page-level horizontal scrolling.

The page uses the shared compact page header instead of the current oversized title card. Interactive rows use buttons with visible keyboard focus and `aria-expanded`. Row controls keep a minimum 44-pixel hit area. Motion uses short opacity and transform transitions and respects reduced-motion preferences.

## Backend data model

`live-game:fetch` returns the base snapshot:

```text
LiveGameSnapshot
  state
  match
    id
    mapId
    modeId
    queueId
    phase
  teams
    id
    averageTier
    ratedPlayers
  players[]
    existing identity, rank, party, and loadout fields
```

The backend reads match identifiers from the existing party, pregame, and coregame documents. Missing fields remain null. The frontend resolves map, mode, agent, rank, card, and skin assets through cached asset helpers and falls back to readable identifiers.

The backend calculates `averageTier` from players with a tier above zero. `ratedPlayers` states the denominator. Party labels remain "detected party" data because Riot omits some opponents' party identifiers.

## Recent-stat enrichment

The frontend sends `live-game:stats` after it receives a roster with changed player IDs. The request contains the current roster key and player IDs. The backend performs these steps for each player:

1. Fetch up to 20 recent history entries.
2. Select the first five entries whose queue ID is `competitive`.
3. Fetch those match details with bounded concurrency.
4. Find the requested player in each match and aggregate kills, deaths, assists, score, rounds, and wins.
5. Emit `live-game:player-stats` as soon as one player's aggregate completes.

The aggregate formulas are:

- K/D: total kills divided by `max(total deaths, 1)`.
- Win rate: wins divided by matches analyzed.
- ACS: total score divided by `max(total rounds, 1)`.

Each event includes the roster key. The frontend ignores events for an old roster after the user changes lobby or match. A bounded worker pool limits concurrent Riot requests. The cache keys each result by player ID and the five qualifying match IDs, which lets repeated five-second polls reuse completed work.

The initial command reply acknowledges the request. Events carry individual success or error results, so one unavailable history does not block other rows.

## Components

- `LiveMatchBar` renders map, queue, phase, and refresh status.
- `LiveTeamSummary` renders team rank averages, detected party count, and roster size.
- `LiveScoutTable` owns team grouping, responsive columns, keyboard semantics, and expanded-row state.
- `LiveScoutRow` renders the compact scouting fields.
- `LivePlayerDetails` renders skin cards and the five-match aggregate details.
- `LiveGameStatePanel` renders loading, idle, login-required, and recoverable error states.

The page keeps data fetching in hooks and passes normalized values into these components. Asset resolution remains separate from Riot data fetching.

## Loading and errors

The page shows a roster skeleton while the base snapshot loads. It keeps the last valid snapshot visible during normal five-second refreshes and marks the refresh state in the match bar.

Recent-stat cells use fixed-width skeletons until each result arrives. A failed player displays `Unavailable` in recent-stat cells and shows the error inside the expanded row. The match bar provides a retry action when the base snapshot fails. Login-required and idle states keep their current guidance with the shared page styling.

Asset failures retain text labels and stable image dimensions. The UI does not shift when icons or statistics arrive.

## Testing

Rust unit tests cover:

- extraction of map, mode, queue, and phase from party, pregame, and coregame documents;
- team average calculation with rated and unrated players;
- selection of the five newest competitive history entries;
- recent-stat aggregation formulas;
- cache and stale-roster event keys;
- partial match-detail failures.

Frontend verification covers:

- loading, idle, login-required, base-error, and partial-stat-error states;
- progressive events updating one row without replacing the roster;
- stale events being ignored after a roster change;
- row expansion by mouse and keyboard;
- responsive column reduction without page-level horizontal scrolling;
- readable labels when assets fail.

The implementation must pass focused Rust tests, `cargo check`, TypeScript compilation, the Vite production build, and Rust formatting checks.
