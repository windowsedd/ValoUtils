# Remove Career Header Rank Design

## Goal

Remove the rank icon and rank name shown at the far right of the Career page header.

## Scope

Modify only the children currently passed to `PageHeader` in `PlayerCareer.tsx`. Keep the Career title and trophy icon unchanged. Keep the Current Rank card, its large rank icon, rank name, RR value, progress bar, Act Rank, and recent matches unchanged.

## Implementation

Remove the conditional header child that renders the compact `RankBadge` and `tierName(currentTier)`. Do not hide it with CSS and do not change the shared `PageHeader` component. The existing `RankBadge` helper remains because the Current Rank card still uses it.

## Verification

Add a source-level UI regression test that confirms the Career `PageHeader` no longer receives the compact current-rank child while the Current Rank card still renders `RankBadge`, `tierName(currentTier)`, and the RR value. Run the focused test, full Bun suite, TypeScript compilation, and Vite build.
