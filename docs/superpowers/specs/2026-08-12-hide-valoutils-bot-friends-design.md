# Hide ValoUtils Bot on Friends Design

## Goal

Hide the exact Riot identity `ValoUtils Bot#BOT` from the Friends tab without changing Chat or backend friend data.

## Design

The Friends page derives a visible roster from the successful `friends:get` response. A small pure predicate identifies the bot only when both `gameName` and `tagLine` match case-insensitively after trimming. The page uses the filtered roster for its total, search groups, player-card loading, party grouping, and profile lookup.

Filtering remains local to `src/pages/Friends.tsx`; Chat continues to receive and display the complete friend roster. Accounts sharing only the name or only the tag remain visible.

## Testing

A focused pure test verifies the exact identity is hidden, casing and surrounding whitespace are normalized, and near matches remain visible. The existing Friends UI and full frontend suite must remain green before release.

## Release

Commit the feature on `master`, update all four canonical version files to `1.0.5`, create annotated tag `v1.0.5`, and push `master` plus the tag to `origin`. Preserve every unrelated dirty or untracked file.
