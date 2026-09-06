# Rank Shield Status Implementation Plan

> **For AI agents:** Required sub-skill: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Track progress with the `- [ ]` checkboxes.

**Goal:** Calculate remaining VALORANT Rank Shields from competitive updates and display the result in Live Match, Career, Friends/Tools profiles, and Match History player profiles.

**Architecture:** A focused Rust module owns the history-based calculation and returns `Option<u8>`, preserving `None` for ineligible or unprovable states. Existing Career/profile responses and the existing Live Match background-stats response carry that normalized value to React. A shared React badge owns eligibility-aware presentation and localization so every surface renders the same state.

**Tech stack:** Rust/serde_json/Tauri commands, React 19, TypeScript 6, react-i18next, bun:test, react-dom server rendering.

---

## File structure

- Create `src-tauri/src/commands/rank_shields.rs`: pure Rank Shield eligibility and competitive-update calculation, with colocated Rust unit tests.
- Modify `src-tauri/src/commands/mod.rs`: register the internal rank-shield module.
- Modify `src-tauri/src/commands/career.rs`: add normalized `rankShields` to `career:get`.
- Modify `src-tauri/src/commands/friend_profile.rs`: add normalized `rankShields` to every shared player-profile payload, including the fake-player fallback.
- Modify `src-tauri/src/commands/live.rs`: attach `rankShields` to successful existing background-stat payloads without adding a Riot request.
- Create `src/components/rank-shield-badge.tsx`: reusable badge and frontend tier-eligibility predicate.
- Create `src/components/rank-shield-badge.test.tsx`: badge rendering and accessibility tests.
- Modify `src/types/live-game.ts`: type `rankShields` on recent Live Match stats.
- Modify `src/types/friend-profile.ts`: type `rankShields` on shared profile data.
- Modify `src/pages/PlayerCareer.tsx`: type and render the Career value.
- Modify `src/components/live-game/live-scout-table.tsx`: render the compact Live Match value beside RR.
- Modify `src/components/friends/friend-profile.tsx`: render the value used by both Friends and Tools.
- Modify `src/components/match-player-profile-modal.tsx`: render the value in Match History profiles.
- Modify `src/i18n/locales/en.json`, `src/i18n/locales/ko.json`, and `src/i18n/locales/zh-TW.json`: shared Rank Shield labels.
- Modify `tests/live-game-ui.test.ts`, `tests/career-act-rank-ui.test.ts`, `tests/friend-profile-ui.test.ts`, and `tests/match-player-profile-ui.test.ts`: source-level wiring assertions.
- Modify `src/components/friends/friend-profile-state.test.ts`: keep typed profile fixtures aligned with the response contract.
- Modify `src/components/match-player-profile-modal-state.test.ts`: keep the modal's typed profile fixture aligned.
- Modify `src/pages/tools/tools-lookup-state.test.ts`: keep Tools' typed profile fixtures aligned.
- Modify `tests/live-game-metrics.test.ts`: keep typed recent-stat fixtures aligned.

### Task 1: Build the pure Rank Shield calculator

**Files:**
- Create: `src-tauri/src/commands/rank_shields.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [x] **Step 1: Write failing Rust tests for the full shield lifecycle**

Create tests whose fixtures are newest-first, matching Riot's competitive-update response:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn updates(matches: Value) -> Value {
        json!({ "Matches": matches })
    }

    #[test]
    fn starts_with_two_shields_after_entering_division_one() {
        let history = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 11, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 80, "RankedRatingAfterUpdate": 10,
              "RankedRatingEarned": 30 }
        ]));
        assert_eq!(remaining_rank_shields(12, Some("act"), &history), Some(2));
    }

    #[test]
    fn consumes_shields_only_on_losses_that_begin_at_zero_rr() {
        let one_left = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -18 },
            { "SeasonID": "act", "TierBeforeUpdate": 11, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 90, "RankedRatingAfterUpdate": 10,
              "RankedRatingEarned": 20 }
        ]));
        assert_eq!(remaining_rank_shields(12, Some("act"), &one_left), Some(1));

        let zero_left = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -16 },
            { "SeasonID": "act", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -18 },
            { "SeasonID": "act", "TierBeforeUpdate": 11, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 90, "RankedRatingAfterUpdate": 10,
              "RankedRatingEarned": 20 }
        ]));
        assert_eq!(remaining_rank_shields(12, Some("act"), &zero_left), Some(0));
    }

    #[test]
    fn uses_the_latest_reentry_and_ignores_other_seasons_and_malformed_rows() {
        let history = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 13, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 70,
              "RankedRatingEarned": -20 },
            { "SeasonID": "act", "TierAfterUpdate": 12 },
            { "SeasonID": "old", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -18 }
        ]));
        assert_eq!(remaining_rank_shields(12, Some("act"), &history), Some(2));
    }

    #[test]
    fn returns_none_when_ineligible_or_the_entry_boundary_is_missing() {
        let history = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -18 }
        ]));
        assert_eq!(remaining_rank_shields(13, Some("act"), &history), None);
        assert_eq!(remaining_rank_shields(12, Some("act"), &history), None);
        assert_eq!(remaining_rank_shields(12, None, &history), None);
    }
}
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `cargo test rank_shields --lib` from `src-tauri/`.

Expected: FAIL because `commands::rank_shields` and `remaining_rank_shields` do not exist.

- [x] **Step 3: Implement the minimum pure calculator**

Register `pub(crate) mod rank_shields;` in `commands/mod.rs`, then implement:

```rust
use serde_json::Value;

const RANK_SHIELD_TIERS: [i64; 8] = [3, 6, 9, 12, 15, 18, 21, 24];

pub(crate) fn is_rank_shield_tier(tier: i64) -> bool {
    RANK_SHIELD_TIERS.contains(&tier)
}

fn integer(row: &Value, key: &str) -> Option<i64> {
    row.get(key)
        .and_then(|value| value.as_i64().or_else(|| value.as_u64().map(|n| n as i64)))
}

pub(crate) fn remaining_rank_shields(
    current_tier: i64,
    current_season_id: Option<&str>,
    updates: &Value,
) -> Option<u8> {
    if !is_rank_shield_tier(current_tier) {
        return None;
    }
    let current_season_id = current_season_id.filter(|id| !id.is_empty())?;
    let rows = updates.get("Matches")?.as_array()?;
    let mut consumed = 0u8;

    for row in rows {
        if row.get("SeasonID").and_then(Value::as_str) != Some(current_season_id) {
            continue;
        }
        let Some(tier_before) = integer(row, "TierBeforeUpdate") else { continue };
        let Some(tier_after) = integer(row, "TierAfterUpdate") else { continue };
        if tier_after != current_tier {
            continue;
        }
        if tier_before != current_tier {
            return Some(2u8.saturating_sub(consumed.min(2)));
        }
        if integer(row, "RankedRatingBeforeUpdate") == Some(0)
            && integer(row, "RankedRatingAfterUpdate") == Some(0)
            && integer(row, "RankedRatingEarned").is_some_and(|rr| rr < 0)
        {
            consumed = consumed.saturating_add(1).min(2);
        }
    }
    None
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `cargo test rank_shields --lib` from `src-tauri/`.

Expected: PASS for all new calculator tests.

- [x] **Step 5: Commit the calculator**

```bash
git add src-tauri/src/commands/rank_shields.rs src-tauri/src/commands/mod.rs
git commit -m "feat(rank): calculate remaining rank shields"
```

### Task 2: Add Rank Shields to backend response contracts

**Files:**
- Modify: `src-tauri/src/commands/career.rs`
- Modify: `src-tauri/src/commands/friend_profile.rs`
- Modify: `src-tauri/src/commands/live.rs`

- [x] **Step 1: Add failing response-normalization tests**

In Career, extract a `career_rank_shields(mmr, competitive_updates)` helper, construct a current-tier fixture with an entry row, and assert:

```rust
assert_eq!(career_rank_shields(&mmr, &updates), Some(2));
```

In the existing friend-profile normalization test, add the same update fields and assert:

```rust
assert_eq!(profile["rankShields"], 2);
```

In `live.rs`, extract a small helper that enriches an aggregate stats object and test its contract:

```rust
let mut stats = json!({ "matches": 1 });
attach_rank_shields(&mut stats, Some(&updates));
assert_eq!(stats["rankShields"], 1);
```

Also assert that ineligible or incomplete inputs serialize as JSON `null`, not an omitted field.

- [x] **Step 2: Run focused Rust tests and verify RED**

Run from `src-tauri/`:

```bash
cargo test commands::career::tests --lib
cargo test commands::friend_profile::tests --lib
cargo test attach_rank_shields --lib
```

Expected: FAIL because the responses do not yet contain `rankShields` and the Live helper does not exist.

- [x] **Step 3: Normalize Career and shared profile responses**

Use `extract_rank` plus the current season id already obtained from MMR, then call the calculator:

```rust
let (current_tier, _, _, _) = extract_rank(Some(&mmr));
let rank_shields = remaining_rank_shields(
    current_tier,
    current_season_id.as_deref(),
    &competitive_updates,
);
```

Add `"rankShields": rank_shields` to Career output and to `normalize_friend_profile`. Add `"rankShields": Value::Null` to the fake-player profile.

- [x] **Step 4: Attach the value to existing Live Match background stats**

After `competitive_updates` has been fetched and aggregate stats are available, derive tier/season from the newest competitive update and insert the stable field:

```rust
fn attach_rank_shields(stats: &mut Value, updates: Option<&Value>) {
    let latest = updates
        .and_then(|value| value.get("Matches"))
        .and_then(Value::as_array)
        .and_then(|rows| rows.first());
    let tier = latest.and_then(|row| row.get("TierAfterUpdate")).and_then(Value::as_i64).unwrap_or(0);
    let season_id = latest.and_then(|row| row.get("SeasonID")).and_then(Value::as_str);
    let shields = updates.and_then(|value| remaining_rank_shields(tier, season_id, value));
    if let Some(object) = stats.as_object_mut() {
        object.insert("rankShields".into(), shields.map_or(Value::Null, Value::from));
    }
}
```

Call this helper before caching the stats. Do not add a request or alter the worker pool, cache key, rate-limit handling, or event shape.

- [x] **Step 5: Run focused Rust tests and verify GREEN**

Run the three commands from Step 2.

Expected: PASS.

- [x] **Step 6: Commit backend integration**

```bash
git add src-tauri/src/commands/career.rs src-tauri/src/commands/friend_profile.rs src-tauri/src/commands/live.rs
git commit -m "feat(rank): expose shields in player responses"
```

### Task 3: Create the shared localized badge

**Files:**
- Create: `src/components/rank-shield-badge.tsx`
- Create: `src/components/rank-shield-badge.test.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`

- [x] **Step 1: Write failing component and locale tests**

Render under an isolated i18next provider and assert these cases:

```tsx
expect(renderBadge(12, 2)).toContain("2/2");
expect(renderBadge(12, 1)).toContain('aria-label="Rank Shields remaining: 1"');
expect(renderBadge(12, 0)).toContain("0/2");
expect(renderBadge(12, null)).toContain("Shield status unavailable");
expect(renderBadge(13, 2)).toBe("");
expect(renderBadge(27, 2)).toBe("");
```

Read all three locale JSON files and assert non-empty `rankShield.remaining` and `rankShield.unavailable` values.

- [x] **Step 2: Run the component test and verify RED**

Run: `bun test src/components/rank-shield-badge.test.tsx`.

Expected: FAIL because the badge module and translation keys do not exist.

- [x] **Step 3: Implement the shared badge and translations**

Implement a small presentation-only component:

```tsx
import { LuShieldCheck } from "react-icons/lu";
import { useTranslation } from "react-i18next";

const SHIELD_TIERS = new Set([3, 6, 9, 12, 15, 18, 21, 24]);

export const isRankShieldTier = (tier: number) => SHIELD_TIERS.has(tier);

export const RankShieldBadge = ({ tier, remaining, compact = false }: {
  tier: number;
  remaining: number | null;
  compact?: boolean;
}) => {
  const { t } = useTranslation();
  if (!isRankShieldTier(tier)) return null;
  const known = remaining === 0 || remaining === 1 || remaining === 2;
  const label = known
    ? t("rankShield.remaining", { count: remaining })
    : t("rankShield.unavailable");
  return (
    <span
      data-rank-shield=""
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-cyan-300/20 bg-cyan-300/8 text-cyan-200 ${compact ? "px-1 py-0.5 text-[9px]" : "px-2 py-1 text-[11px]"}`}
    >
      <LuShieldCheck aria-hidden="true" />
      <span className="tabular-nums">{known ? `${remaining}/2` : "—"}</span>
    </span>
  );
};
```

Add shared translations:

```json
"rankShield": {
  "remaining": "Rank Shields remaining: {{count}}",
  "unavailable": "Shield status unavailable"
}
```

Use `남은 랭크 보호막: {{count}}개` / `랭크 보호막 상태를 확인할 수 없음` in Korean and `剩餘牌位護盾：{{count}} 個` / `無法取得牌位護盾狀態` in Traditional Chinese.

- [x] **Step 4: Run the component test and verify GREEN**

Run: `bun test src/components/rank-shield-badge.test.tsx`.

Expected: PASS.

- [x] **Step 5: Commit the shared UI**

```bash
git add src/components/rank-shield-badge.tsx src/components/rank-shield-badge.test.tsx src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json
git commit -m "feat(ui): add rank shield badge"
```

### Task 4: Wire the badge into Live Match and every profile surface

**Files:**
- Modify: `src/types/live-game.ts`
- Modify: `src/types/friend-profile.ts`
- Modify: `src/pages/PlayerCareer.tsx`
- Modify: `src/components/live-game/live-scout-table.tsx`
- Modify: `src/components/friends/friend-profile.tsx`
- Modify: `src/components/match-player-profile-modal.tsx`
- Modify: `src/components/friends/friend-profile-state.test.ts`
- Modify: `src/components/match-player-profile-modal-state.test.ts`
- Modify: `src/pages/tools/tools-lookup-state.test.ts`
- Modify: `tests/live-game-metrics.test.ts`
- Modify: `tests/live-game-ui.test.ts`
- Modify: `tests/career-act-rank-ui.test.ts`
- Modify: `tests/friend-profile-ui.test.ts`
- Modify: `tests/match-player-profile-ui.test.ts`

- [x] **Step 1: Add failing type-fixture and source-wiring tests**

Add `rankShields: 1` to every typed `FriendProfileData` fixture and `rankShields: null` to the typed `RecentPlayerStats` fixture in `tests/live-game-metrics.test.ts`. Assert each surface imports and renders the shared badge with its own normalized value:

```ts
expect(table).toContain("<RankShieldBadge");
expect(table).toContain("remaining={stats?.status === \"ready\" ? stats.stats.rankShields : null}");
expect(career).toContain("remaining={data.rankShields}");
expect(profile).toContain("remaining={profile.rankShields}");
expect(modal).toContain("remaining={profile.rankShields}");
```

- [x] **Step 2: Run focused frontend tests and verify RED**

Run:

```bash
bun test tests/live-game-ui.test.ts tests/career-act-rank-ui.test.ts tests/friend-profile-ui.test.ts tests/match-player-profile-ui.test.ts src/components/friends/friend-profile-state.test.ts src/components/match-player-profile-modal-state.test.ts src/pages/tools/tools-lookup-state.test.ts tests/live-game-metrics.test.ts
```

Expected: FAIL because types and surfaces do not yet expose or render the field.

- [x] **Step 3: Extend frontend contracts**

Add the stable nullable field:

```ts
export type RecentPlayerStats = {
  // existing fields
  rankShields: 0 | 1 | 2 | null;
};

export type FriendProfileData = {
  // existing fields
  rankShields: 0 | 1 | 2 | null;
};
```

Add `rankShields: 0 | 1 | 2 | null` to `CareerData` and copy `response.rankShields ?? null` into component state.

- [x] **Step 4: Render without changing page layout structure**

Import `RankShieldBadge` in all four UI files.

- Career: place `<RankShieldBadge tier={currentTier} remaining={data.rankShields} />` in the current-rank detail row beside RR.
- Friends/Tools: place `<RankShieldBadge tier={tier} remaining={profile.rankShields} compact />` beneath the current RR line.
- Match History profile modal: place `<RankShieldBadge tier={currentTier} remaining={profile.rankShields} />` beside current RR.
- Live Match: extend `RrValue` to accept `stats`. Do not mount the badge while stats are absent or loading. Once the request resolves, render `<RankShieldBadge tier={tier} remaining={stats.status === "ready" ? stats.stats.rankShields : null} compact />`, so an eligible rank displays the known count or an unavailable state after a failed request.

Do not add another table column; retain the current responsive grids.

- [x] **Step 5: Run focused frontend tests and verify GREEN**

Run the command from Step 2 plus `bun test src/components/rank-shield-badge.test.tsx`.

Expected: PASS.

- [x] **Step 6: Commit surface integration**

```bash
git add src/types/live-game.ts src/types/friend-profile.ts src/pages/PlayerCareer.tsx src/components/live-game/live-scout-table.tsx src/components/friends/friend-profile.tsx src/components/match-player-profile-modal.tsx src/components/friends/friend-profile-state.test.ts src/components/match-player-profile-modal-state.test.ts src/pages/tools/tools-lookup-state.test.ts tests/live-game-metrics.test.ts tests/live-game-ui.test.ts tests/career-act-rank-ui.test.ts tests/friend-profile-ui.test.ts tests/match-player-profile-ui.test.ts
git commit -m "feat(rank): show shields across player views"
```

### Task 5: Verify the complete change

**Files:**
- Modify only if verification exposes a defect in files already listed above.

- [x] **Step 1: Format changed Rust code**

Run: `cargo fmt --check` from `src-tauri/`.

Expected: PASS. If formatting differs, run `cargo fmt`, inspect the scoped diff, and rerun `cargo fmt --check`.

- [x] **Step 2: Run the full frontend suite**

Run: `bun test` from the repository root.

Expected: all tests PASS with no unhandled errors.

- [x] **Step 3: Run frontend lint and type/build verification**

Run from the repository root:

```bash
bun run lint
bun run build:vite
```

Expected: both commands exit 0. Inspect any formatter changes made by the repository's lint script before keeping them.

- [x] **Step 4: Run the full Rust suite and lints**

Run from `src-tauri/`:

```bash
cargo test --lib
cargo clippy --all-targets --all-features -- -D warnings
```

Expected: all tests PASS and clippy reports no warnings.

- [x] **Step 5: Inspect final scope and whitespace**

Run from the repository root:

```bash
git status --short
git diff --check HEAD~3..HEAD
git diff --stat HEAD~3..HEAD
```

Expected: only the planned Rank Shield files and planning documents changed; no whitespace errors or unrelated edits.

- [x] **Step 6: Commit any verification-only correction**

If verification required a correction, stage the planned implementation paths (Git ignores unchanged paths) and commit it:

```bash
git add src-tauri/src/commands/rank_shields.rs src-tauri/src/commands/mod.rs src-tauri/src/commands/career.rs src-tauri/src/commands/friend_profile.rs src-tauri/src/commands/live.rs src/components/rank-shield-badge.tsx src/components/rank-shield-badge.test.tsx src/types/live-game.ts src/types/friend-profile.ts src/pages/PlayerCareer.tsx src/components/live-game/live-scout-table.tsx src/components/friends/friend-profile.tsx src/components/match-player-profile-modal.tsx src/components/friends/friend-profile-state.test.ts src/components/match-player-profile-modal-state.test.ts src/pages/tools/tools-lookup-state.test.ts tests/live-game-metrics.test.ts tests/live-game-ui.test.ts tests/career-act-rank-ui.test.ts tests/friend-profile-ui.test.ts tests/match-player-profile-ui.test.ts src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json
git commit -m "fix(rank): address rank shield verification"
```

If no correction was needed, do not create an empty commit.

Verification notes:

- `cargo fmt --check` still reports formatting differences in seven pre-existing, unrelated Rust files; scoped `rustfmt --check` passes for all four changed Rust files.
- `cargo test --lib` reports 419 passed, 2 ignored, and the same pre-existing `commands::live_party::tests::rate_gate_spaces_concurrent_request_starts` timing failure observed on the clean baseline. `cargo test rank_shields --lib` passes all six Rank Shield tests.
- `cargo clippy --all-targets --all-features -- -D warnings` reports 24 pre-existing warnings in unrelated modules and no warning in Rank Shield code.
