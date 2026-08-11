# Live Player Act Rank Triangle

## Goal

Show a Valorant act-rank triangle inside each expanded Live Game player row. A dropdown lets the user inspect the current act and previous competitive acts. The collapsed player table stays unchanged.

## Placement And Interaction

`LiveScoutTable` keeps one expanded player at a time. When the user expands a player row, the detail area renders an act-rank panel below the recent-stat and skin summaries and above match history.

The panel header contains an act selector. It lists acts newest first and defaults to `LatestCompetitiveUpdate.SeasonID`. If that ID is absent, it defaults to the newest act with a known start time, then the first normalized season as a final fallback. The existing season asset cache will expose both labels such as `V26A2` and act start times from the same Valorant API response. If label lookup fails, the selector uses a short stable fallback derived from the season UUID.

The selected act belongs to the expanded `PlayerRow`. Reopening the same row during the current render session restores its selection. Changing the selected act updates the triangle and its statistics without another backend request.

## Backend Data Model

The live-game command already fetches an MMR response for each visible player. It will normalize `QueueSkills.competitive.SeasonalInfoBySeasonID` into a frontend-safe array instead of exposing Riot's raw response.

Each `LivePlayer` gains `competitiveSeasons`:

```ts
type CompetitiveSeason = {
  seasonId: string;
  tier: number;
  rankedRating: number;
  wins: number;
  games: number;
  winsByTier: Record<number, number>;
};
```

`LivePlayer` also gains `currentSeasonId: string | null`, sourced from `LatestCompetitiveUpdate.SeasonID`. The frontend joins season IDs to cached act start times before sorting; it does not rely on JSON object key order.

The Rust normalizer accepts missing, null, and malformed fields. It omits entries that have no season ID and converts valid numeric fields to non-negative integers. Existing current-rank and peak-rank extraction continues to use the same MMR response.

No new IPC command or Riot request is required. The larger live snapshot remains bounded because a player has a small number of competitive seasons and each `winsByTier` map contains at most the rank tiers used during that act.

## Triangle Composition

The frontend builds a maximum of 49 win tiles from `winsByTier`:

1. Expand each tier/count pair into one entry per win.
2. Sort entries by tier descending so the strongest wins occupy the top of the badge.
3. Keep the first 49 entries.
4. Place entries top-to-bottom in a seven-row triangular grid. Row `r` contains `2r + 1` slots whose orientations alternate up/down.

Each slot uses `/mmr/<tier>_up.png` or `/mmr/<tier>_down.png`. CSS gives every source image the same rendered dimensions, including files whose intrinsic dimensions differ.

The panel places the tiles and the border in one responsive square coordinate system. The border sits above the empty grid and below interactive UI. It uses these total-win thresholds, matching Valorant's act-rank border progression:

| Total wins | Border |
| --- | --- |
| 0-8 | `border0.png` |
| 9-24 | `border1.png` |
| 25-49 | `border2.png` |
| 50-74 | `border3.png` |
| 75-99 | `border4.png` |
| 100+ | `border5.png` |

The triangle component contains no player-specific fetching or selection state. It receives `winsByTier` and total wins, which makes geometry and border behavior testable in isolation.

## Act Statistics

The selected act displays:

- Rank from the season's `tier`
- Ranked Rating from `rankedRating`
- Wins and games
- Win rate as `wins / games`, or unavailable when games is zero
- Peak rank as the highest tier with at least one win
- Lowest rank as the lowest tier with at least one win
- Final rank from the season's `tier`

The panel does not invent Last Game or ELO values because the normalized season record does not supply them. Rank values use the existing rank names, colors, and icons. A season with no ranked wins shows the correct empty border and an unranked or unavailable statistics state.

## Responsive Layout

At large widths, the panel uses three columns: left statistics, a centered square triangle, and right statistics. At narrower widths, the triangle appears first and the statistics flow into a two-column grid beneath it. The triangle uses an aspect ratio and a maximum width so expanding a row does not cause horizontal overflow.

The selector remains keyboard accessible and has a visible focus state. Images use empty alternative text because adjacent text communicates the rank data. Reduced-motion settings disable nonessential selection transitions.

## Components

- `ActRankPanel`: owns the selected season and renders the panel header, selector, statistics, and empty state.
- `ActRankTriangle`: maps sorted wins to triangle slots and chooses a border.
- Live-game backend normalizer: converts Riot seasonal MMR data into `CompetitiveSeason` records.
- Season asset metadata: retains each act's label and start time for chronological dropdown ordering.
- `LivePlayer` types and localization files: define the payload and visible labels in English, Korean, and Traditional Chinese.

## Error Handling

Missing seasonal data produces a compact unavailable message inside the expanded row. A failed season-label request falls back to a stable label and does not hide rank data. Invalid tier numbers do not produce broken image URLs; the triangle skips those tiles while the statistics show unavailable rank text.

## Verification

Rust tests cover season normalization, absent data, numeric coercion, current-season extraction, and preservation of `winsByTier`. Frontend tests cover descending tier expansion, the 49-tile cap, orientation and slot order, border thresholds, season sorting and fallback selection, and empty data.

The implementation must also pass the TypeScript/Vite build and Rust tests. Browser screenshots at desktop and narrow widths will verify that the expanded row fits without overlap, the supplied assets align inside the border, and the dropdown switches acts.
