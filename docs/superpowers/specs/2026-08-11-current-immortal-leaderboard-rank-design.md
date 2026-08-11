# Current Immortal Rank from Riot Leaderboard Design

## Goal

Correct the displayed Current Rank for Immortal and Radiant players by resolving their current RR against the current Act's Riot leaderboard thresholds.

## Scope

Apply the correction to `friend:profile:get`, which supplies both the Friends profile page and the clickable match-player profile modal.

Do not modify historical Peak Rank, Player Career, Live Scout, match scoreboard ranks, Act Rank crystals, or ranks below Immortal.

## Riot Rule

Immortal 2 and Immortal 3 require region-specific RR thresholds. Radiant requires both the regional RR requirement and qualification for the region's top 500 leaderboard. Riot documents these rules in its Immortal and Radiant RR support article.

The application must use Riot's current leaderboard response instead of hardcoding regional RR values because the response exposes the current Act's tier thresholds and top-tier RR threshold.

## Data Flow

1. Fetch the selected player's MMR, competitive updates, and match history as today.
2. Extract the current season ID, raw current tier, and current RR from MMR.
3. If the raw tier is below tier 24, skip the leaderboard request and preserve the raw tier.
4. If the raw tier is 24 through 27 and the current season ID is available, request the authenticated Riot leaderboard for the signed-in client's region and that season.
5. Parse the RR thresholds for tiers 25, 26, and 27 from `tierDetails`.
6. Treat the effective Radiant threshold as the greater of tier 27's configured threshold and `topTierRRThreshold`, so the current top-500 cutoff is respected.
7. Choose the highest tier whose effective threshold is less than or equal to the player's current RR: Radiant 27, Immortal 3 tier 26, Immortal 2 tier 25, otherwise Immortal 1 tier 24.
8. Return the resolved tier as `profile.currentTier`. Preserve the existing `currentRR`, `peakTier`, and `peakSeasonId` values.

## Riot API Client

Add an authenticated PD request method using this endpoint shape:

```text
/mmr/v1/leaderboards/affinity/{region}/queue/competitive/season/{seasonId}?startIndex=0&size=1
```

Only threshold metadata is required, so one player entry is sufficient. The season ID must be URL-encoded before interpolation.

## Threshold Parsing

The parser is a pure function and accepts the leaderboard JSON response. It must:

- Read `tierDetails` keys `25`, `26`, and `27` and their `rankedRatingThreshold` values.
- Read `topTierRRThreshold`.
- Reject negative, missing, non-numeric, or non-monotonic threshold data.
- Return no thresholds when the response is malformed; callers then preserve the raw MMR tier.

## Cache and Failure Handling

Cache successfully parsed thresholds by `region + seasonId` for five minutes. Do not cache failures.

The leaderboard request is an enhancement, not a requirement for loading a profile. Authentication, network, HTTP, parsing, or schema failures must not fail `friend:profile:get`; they preserve the raw MMR tier and allow the rest of the profile to render normally.

## Testing

Rust unit tests will cover:

- Ascendant and lower tiers remain unchanged without thresholds.
- RR below the Immortal 2 threshold resolves to Immortal 1.
- RR crossing the Immortal 2 and Immortal 3 thresholds resolves to tiers 25 and 26.
- Radiant uses the greater of tier 27 and top-tier thresholds.
- Malformed and non-monotonic leaderboard data is rejected.
- A missing leaderboard response preserves the raw tier.
- Normalized friend profiles replace only `currentTier`; Peak Rank remains unchanged.

