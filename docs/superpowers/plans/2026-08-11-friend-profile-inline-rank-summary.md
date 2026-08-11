# Friend Profile Inline Rank Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place Current Rank and Peak Rank beside the friend's Riot ID and remove the duplicated standalone rank card.

**Architecture:** Expand the existing Friend Profile identity row into a responsive three-group summary. Reuse the profile data, tier assets, colors, and localized labels already calculated by `FriendProfile`; no shared components or data flow change.

**Tech Stack:** React, TypeScript, Tailwind CSS, Bun source-level UI tests.

## Global Constraints

- Modify only `FriendProfile` and its focused UI test.
- Preserve the page header, identity, presence, Act Rank panel, and match history behavior.
- Do not modify Player Career or match-player profile modal.
- Remove the standalone Current Rank `SectionCard` from Friend Profile.

---

### Task 1: Lock the inline summary contract

**Files:**
- Modify: `tests/friend-profile-ui.test.ts`

**Interfaces:**
- Consumes: `src/components/friends/friend-profile.tsx`
- Produces: Source-level regression coverage for summary placement and duplicate-card removal.

- [ ] **Step 1: Write the failing layout test**

Add a test that locates `data-friend-profile-summary`, verifies that Current Rank, current RR, Peak Rank, and Episode / Act expressions occur inside that summary, and verifies that `<SectionCard title={t("friends.profileCurrentRank")}` is absent.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/friend-profile-ui.test.ts`

Expected: FAIL because the marker does not exist and the rank information is still inside a standalone `SectionCard`.

---

### Task 2: Move rank information into the identity row

**Files:**
- Modify: `src/components/friends/friend-profile.tsx`

**Interfaces:**
- Consumes: Existing `tier`, `rankIcon`, `color`, `peakTier`, `peakRankIcon`, `peakColor`, `peakSeasonLabel`, and `profile.currentRR` values.
- Produces: One responsive identity/rank summary marked by `data-friend-profile-summary`.

- [ ] **Step 1: Remove the unused SectionCard import and standalone card**

Keep `PageHeader` imported, delete `SectionCard` from the import, and remove the Current Rank card block from the profile body.

- [ ] **Step 2: Build the responsive summary row**

Keep the player card and name group first. Add Current Rank and Peak Rank groups with their existing icons and localized labels. Use `flex-wrap` for narrow screens and separators that switch from top borders on wrapped/mobile layout to left borders on medium widths. Current RR remains `{profile.currentRR} / 100 RR`; peak season remains conditional.

- [ ] **Step 3: Verify GREEN**

Run: `bun test tests/friend-profile-ui.test.ts`

Expected: All Friend Profile UI tests pass.

---

### Task 3: Verify the application

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Updated Friend Profile.
- Produces: Regression and build evidence.

- [ ] **Step 1: Run all tests**

Run: `bun test`

Expected: Zero failures.

- [ ] **Step 2: Run the production build**

Run: `bun run build:vite`

Expected: TypeScript and Vite build successfully; existing warnings may remain.

- [ ] **Step 3: Check patch scope**

Run: `git diff --check`

Expected: No whitespace errors and no changes to Player Career or match-player modal from this task.

