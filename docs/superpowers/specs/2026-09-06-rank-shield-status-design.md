# Rank Shield Status Design

## Goal

Show each player's remaining VALORANT Rank Shields in Live Match and every player-profile surface: the signed-in player's Career page, Friends profiles, Tools lookup profiles, and Match History player profiles.

## Data model

Expose one normalized nullable value, `rankShields`, throughout the app:

- `0`, `1`, or `2` when the remaining count can be established.
- `null` when shields do not apply to the current rank or the available competitive history is insufficient to determine the count safely.

Rank Shields apply only to division-one tiers from Iron 1 through Immortal 1. Radiant, unrated players, and division-two/division-three tiers do not receive a shield badge.

## Shield calculation

Add a pure Rust helper that accepts the current tier and ordered competitive-update records.

For an eligible tier, scan the current season's updates from newest to oldest until finding the latest entry into that tier. Entry means a record whose `TierAfterUpdate` is the current tier and whose `TierBeforeUpdate` differs from it. Start with two shields and subtract one for each later record that:

- remains in the same tier,
- starts and ends at 0 RR, and
- has a negative `RankedRatingEarned` value.

Clamp the result to `0..=2`. If the scan cannot find the entry boundary, return `null` rather than assuming that no older shield-consuming losses exist. Ignore malformed records without treating them as shield consumption.

## Backend flow

- Career already fetches competitive updates; normalize `rankShields` into the `career:get` response.
- Friend, Tools, and Match History profiles share `friend:profile:get`; add `rankShields` to the normalized profile response.
- Live Match already fetches competitive updates in the background for recent-player stats. Include `rankShields` in that asynchronous stats result so the initial roster is not delayed and no additional Riot request is introduced.
- Preserve existing rate-limit and unavailable-data behavior. A missing shield value must not fail a successful rank/profile load.

## Frontend presentation

Create one reusable `RankShieldBadge` component. It renders only for eligible tier-one ranks and displays a shield icon with `0/2`, `1/2`, or `2/2`. Its accessible label and tooltip explain the remaining protection.

- Live Match: render the compact badge beside the player's RR once background stats are ready.
- Career: render it in the Current Rank card beside the RR details.
- Friends/Tools profile: render it in the current-rank summary.
- Match History player profile modal: render it in the Current Rank card.

When the count is unknown, render a localized `Shield status unavailable` state only where an eligible tier makes shields relevant. Do not show a shield for ineligible ranks.

Add translations for English, Korean, and Traditional Chinese.

## Testing

Follow test-driven development:

- Rust unit tests first for two shields, one consumed, both consumed, replenishment after re-entry, non-eligible tiers, malformed updates, and history without an entry boundary.
- Frontend tests first for shared badge rendering, accessible text, eligible unknown state, and hiding on ineligible tiers.
- Integration/source tests first to ensure Live Match and every profile surface pass normalized shield data into the shared component.
- Run focused Bun and Rust tests, then the full frontend test suite, Rust library tests, lint, and type/build verification appropriate to the repository.

## Out of scope

- Predicting future RR loss or hidden MMR.
- Fetching extra competitive-history pages solely to turn an unknown result into a guessed value.
- Changing Riot request cadence or cache lifetimes.
