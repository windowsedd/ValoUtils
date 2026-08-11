# Friend Profile Inline Rank Summary Design

## Goal

Move the selected friend's current and peak competitive rank information next to their Riot ID in the Friend Profile identity section, then remove the duplicated standalone Current Rank card.

## Scope

Only `FriendProfile` changes. The page header, back button, refresh button, presence text, Act Rank panel, match history, Player Career page, and match-player profile modal remain unchanged.

## Layout

The existing identity section becomes a responsive summary row:

1. Player card, Riot ID (`gameName#tagLine`), and presence remain on the left.
2. Current Rank appears next, with its rank icon, localized rank name, and `{currentRR} / 100 RR`.
3. Peak Rank appears last, with its rank icon, localized rank name, and resolved Episode / Act label.

On medium and larger widths, all three groups share one horizontal row. On narrow widths, the rank groups wrap below the player identity without horizontal overflow.

Subtle separators distinguish the Current Rank and Peak Rank groups. Current-rank text uses the tier color; peak-rank text uses the peak tier color.

## Data and Empty States

Use the existing `FriendProfileData` fields and loaded asset maps:

- Current: `currentTier`, `currentRR`, and `tiers`.
- Peak: `peakTier`, `peakSeasonId`, `tiers`, and `seasons`.

If a rank is unavailable, render the localized Unranked label and omit its icon. If the peak season cannot be resolved, omit the Episode / Act line instead of showing an empty label.

## Removed UI

Remove the standalone `SectionCard` titled `friends.profileCurrentRank` from `FriendProfile`. Rank information must appear only once in this page body.

Do not remove or modify the shared `SectionCard` component because other pages still use it.

## Accessibility

Rank icons retain descriptive alt text using the localized tier name. Existing heading, navigation button, and refresh button behavior remain unchanged.

## Testing

Focused source-level UI tests will verify that:

- Current Rank and Peak Rank data are rendered within the identity summary section.
- Current RR uses the `/ 100 RR` format.
- Peak Episode / Act remains present when available.
- The standalone Current Rank `SectionCard` is absent from `FriendProfile`.
- The Act Rank panel and match history remain after the identity summary.

