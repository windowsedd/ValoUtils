# Live Game match history and team matchup

## Goal

Show the five competitive matches behind each player's aggregate statistics and compare recent performance between the ally and enemy teams.

## Data contract

The existing `live-game:stats` command already downloads up to five competitive match documents per player. It will normalize each successful document into a compact history item:

```text
RecentMatchSummary
  matchId
  startMillis
  mapId
  agentId
  won
  allyRounds
  enemyRounds
  kills
  deaths
  assists
  acs
```

The command adds `history: RecentMatchSummary[]` to each `RecentPlayerStats` event. Failed detail requests remain omitted. The aggregate `matches` count equals the number of normalized history items, so the sample label stays accurate.

The base roster adds `isSelf` to each player. The backend compares each player PUUID with the signed-in PUUID. The frontend uses the signed-in player's `teamId` to label Blue or Red as the ally team during core game. Pregame already uses `Ally` and `Enemy` team IDs.

No new Riot API request is added.

## Team matchup strip

Add a compact matchup strip below the match summary and above the roster. It compares ally-team and enemy-team arithmetic averages for:

- K/D
- win rate
- ACS

The strip updates as player-stat events arrive. A metric shows a fixed skeleton until both teams contain at least one ready player. Each side shows how many players contributed to its average.

Use the signed-in player's team as the left, green/cyan value and the opposing team as the right, red value. Keep text labels so color is not the only distinction. Hide the strip when the roster has fewer than two teams, the signed-in player is missing, or the opposing team has no players. This covers party state and incomplete Riot responses.

## Player match history

Place a full-width history list below the aggregate and skin cards inside an expanded player row. Render up to five rows in newest-first order. Each row shows:

- Win or loss
- Map
- Round score from the player's perspective
- Agent icon and name
- K/D/A
- ACS
- Localized date and time

Use existing map and agent assets. Missing assets keep text labels and stable dimensions. A history item is informational and does not open another nested expansion.

When recent statistics fail, retain the current per-player error. When statistics succeed with an empty history, show a localized empty-history message.

## Responsive and accessible behavior

The matchup strip wraps its three metric comparisons at narrow widths without creating horizontal page scrolling. History rows keep result, map, and K/D/A visible; score, ACS, agent, or date may hide at narrower widths.

Win/loss and ally/enemy labels remain readable without color. Loading animation honors reduced-motion preferences. Images have useful alternative text or remain decorative when adjacent text already names the asset.

## Testing

Rust tests cover match-summary normalization, player-perspective score and result, ACS calculation, missing player/team data, and `isSelf` marking. Frontend verification covers team-average calculations, progressive partial data, hidden matchup states, empty/error history, responsive rows, and production TypeScript compilation.
