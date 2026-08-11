# Custom Game Coach Labels

## Problem

Riot returns custom-game coaches in a top-level `coaches` array. Each coach entry contains a player UUID and the coached team ID. The match reducer ignores this array and renders the matching observer record as an ordinary player. The resulting row has no agent, zero statistics, a neutral team marker, and no explanation of the participant's role.

## Scope

ValoUtils will keep coaches visible in match-history scoreboards. Each coach row will use the coached team's color and show a localized `Coach` label in place of an agent name. Player rows, non-custom matches, and observers who do not appear in Riot's `coaches` array will retain their current behavior.

## Data Model and Reduction

The Rust match reducer will build a subject-to-team lookup from `details.coaches`. While reducing `details.players`, it will match each player's `subject` against that lookup.

For a match, the reducer will:

- set `role` to `coach` for a matched subject and `player` for every other subject;
- use the coach entry's `teamId` for a matched coach;
- preserve the observer record's Riot ID and other identity fields;
- preserve zero statistics for coaches because Riot does not report playing statistics for them.

The frontend `MatchPlayer` type will expose the normalized role. The scoreboard will use that field instead of inferring a role from an empty character ID or zero statistics.

## Presentation

The existing ACS sort leaves zero-score coaches below active players. A coach row will keep the same dimensions and columns as a player row so the scoreboard remains aligned. The row's team marker will use the mapped `Blue` or `Red` color, and the subtitle will show the localized coach label. The row will remain selectable when it has a valid player UUID, preserving the profile interaction already present in the working tree.

The three locale files will add the coach label. No new grouping, section header, or icon is needed.

## Alternatives Considered

Frontend inference based on missing stats or character IDs would misclassify disconnected players and spectators. Building new rows from `coaches` would discard identity fields or duplicate observer records. Joining Riot's explicit coach metadata to its matching player record gives the UI one normalized roster.

## Error Handling

Missing or malformed `coaches` data will produce an empty lookup, preserving current player behavior. A coach entry without a subject cannot match a row. A coach entry without a team ID will not override the row's existing team ID.

## Tests

Rust reducer tests will cover:

- a custom-game observer whose subject appears in `coaches`, including role and team assignment;
- an ordinary player and an unmatched observer, confirming both keep the player role and original team ID;
- absent coach metadata, confirming normal match reduction stays unchanged.

A frontend unit test will confirm that coach rows choose the coach subtitle while player rows continue to choose the localized agent name.
