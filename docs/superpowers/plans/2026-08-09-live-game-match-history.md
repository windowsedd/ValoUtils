# Live Game Match History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show five recent match rows per live player and an ally-versus-enemy recent-performance strip.

**Architecture:** Extend the existing progressive player-stat event with normalized summaries from match documents the backend already fetched. Mark the signed-in roster player, calculate team matchup values in a tested pure TypeScript helper, and render the comparison and history through focused Live Game components.

**Tech Stack:** Rust, serde_json, Tauri 2, React 19, TypeScript 6, Bun test, Tailwind CSS, react-i18next

## Global Constraints

- Reuse the five match documents fetched by `live-game:stats`; add no Riot API requests.
- Compare the signed-in player's team with the opposing team.
- Hide the matchup when self or an opposing roster is unavailable.
- Preserve progressive per-player events and stale-roster rejection.
- Keep result, map, and K/D/A visible at narrow widths without page-level horizontal scrolling.

---

### Task 1: Normalize recent matches and identify the signed-in player

**Files:**
- Modify: `src-tauri/src/commands/live.rs`
- Test: inline tests in `src-tauri/src/commands/live.rs`

**Interfaces:**
- Produces: `normalize_recent_match(puuid: &str, details: &Value) -> Option<Value>`
- Extends: successful recent-stat JSON with `history: Value[]`
- Extends: each live roster player with `isSelf: bool`

- [ ] **Step 1: Write failing normalization tests**

Add tests that build a real-shaped match document with `matchInfo`, `players`, and `teams`. Assert that normalization returns:

```rust
json!({
    "matchId": "m1",
    "startMillis": 1234,
    "mapId": "/Game/Maps/Ascent/Ascent",
    "agentId": "agent-1",
    "won": true,
    "allyRounds": 13,
    "enemyRounds": 9,
    "kills": 20,
    "deaths": 10,
    "assists": 5,
    "acs": 200.0,
})
```

Also assert that a document without the requested player returns `None`, and that `aggregate_recent_stats` includes only normalized documents in `history` and `matches`.

- [ ] **Step 2: Verify the tests fail**

Run: `cargo test commands::live::tests::normalizes_recent_match_summary --lib`

Expected: compile failure because `normalize_recent_match` does not exist.

- [ ] **Step 3: Implement match normalization and aggregation**

Find the player by case-insensitive `subject`. Read metadata from `matchInfo`, calculate ACS as `score / max(roundsPlayed, 1)`, find the player's team and first opposing team, and return `None` if the requested player is absent. Build aggregate totals and the history array in the same loop so `matches == history.len()`.

- [ ] **Step 4: Add `isSelf` to normalized roster players**

Inside `enrich_players`, add:

```rust
"isSelf": puuid.eq_ignore_ascii_case(&api.puuid),
```

- [ ] **Step 5: Run backend verification**

Run: `cargo test commands::live::tests --lib --quiet`

Expected: all Live Game tests pass.

Run: `cargo check --quiet`

Expected: exit code 0; existing unrelated warnings may remain.

---

### Task 2: Add frontend contracts and tested team calculations

**Files:**
- Modify: `src/types/live-game.ts`
- Create: `src/components/live-game/live-game-metrics.ts`
- Create: `src/components/live-game/live-game-metrics.test.ts`

**Interfaces:**
- Produces: `RecentMatchSummary`
- Extends: `LivePlayer.isSelf` and `RecentPlayerStats.history`
- Produces: `buildTeamMatchup(players, recent): TeamMatchup | null`

- [ ] **Step 1: Extend the frontend contracts**

Add the exact normalized match fields from Task 1. Add `isSelf: boolean` to `LivePlayer` and `history: RecentMatchSummary[]` to `RecentPlayerStats`.

- [ ] **Step 2: Write failing team matchup tests**

Use `bun:test` to cover:

```ts
expect(buildTeamMatchup(players, recent)).toEqual({
  ally: { teamId: "Blue", players: 2, kd: 1.5, winRate: 55, acs: 210 },
  enemy: { teamId: "Red", players: 1, kd: 0.8, winRate: 40, acs: 180 },
});
```

Add cases for progressive data with zero ready players on one side and `null` when self or an opponent is missing.

- [ ] **Step 3: Verify the tests fail**

Run: `bun test src/components/live-game/live-game-metrics.test.ts`

Expected: failure because the helper module does not exist.

- [ ] **Step 4: Implement the pure calculation helper**

Find `players.find(player => player.isSelf)`, group ready statistics by the self team and the first opposing team, and compute arithmetic averages. Keep metrics `null` for a side with zero ready players so the UI can retain skeletons.

- [ ] **Step 5: Run frontend helper tests**

Run: `bun test src/components/live-game/live-game-metrics.test.ts`

Expected: all matchup tests pass.

---

### Task 3: Render the matchup strip and match history

**Files:**
- Create: `src/components/live-game/live-team-matchup.tsx`
- Create: `src/components/live-game/live-player-history.tsx`
- Modify: `src/components/live-game/live-scout-table.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`

**Interfaces:**
- Consumes: `TeamMatchup`, `RecentMatchSummary[]`, and `LiveGameAssets`
- Produces: responsive comparison strip and five-row history list

- [ ] **Step 1: Implement the matchup strip**

Render three comparison cells for average K/D, win rate, and ACS. Each cell shows ally value, a written metric label, and enemy value. Use fixed skeletons when either side has no ready statistics and show the contributing-player counts in the strip heading.

- [ ] **Step 2: Implement compact history rows**

Render newest-first history with localized win/loss, resolved map and agent, player-perspective round score, K/D/A, ACS, and localized date. Hide secondary fields at narrow breakpoints and show a localized empty message for an empty array.

- [ ] **Step 3: Compose both components**

Call `buildTeamMatchup(snapshot.players, recent)` in `LiveScoutTable`. Place `LiveTeamMatchup` below the existing four summary cells. Place `LivePlayerHistory` as a full-width row below the aggregate and skins inside each expanded player.

- [ ] **Step 4: Add localized labels**

Add keys for matchup, ally, enemy, average K/D, average win rate, average ACS, players analyzed, recent history, win, loss, score, and no history to English, Korean, and Traditional Chinese.

- [ ] **Step 5: Run complete verification**

Run: `bun test src/components/live-game/live-game-metrics.test.ts`

Expected: all matchup tests pass.

Run: `bun run build:vite`

Expected: TypeScript compilation and Vite build exit with code 0.

Run: `cargo test commands::live::tests --lib --quiet`

Expected: all Live Game tests pass.

Run: `cargo fmt --check`

Expected: exit code 0.

Run: `git diff --check -- src-tauri/src/commands/live.rs src/types/live-game.ts src/components/live-game src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json`

Expected: exit code 0 with no new whitespace errors.
