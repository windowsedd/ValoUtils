# Act Rank Native PNG Alignment Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a 14-win Act render exactly 14 native Riot tier crystals aligned with the official border lattice.

**Architecture:** Replace the invented SVG lattice with a testable 512-unit placement formula for the existing 125×111 tier PNGs. Pass the selected Act's explicit `wins` value into tile construction so stale or oversized `WinsByTier` totals cannot overfill the badge.

**Tech Stack:** React, TypeScript, CSS absolute positioning, Bun test, React server rendering.

## Global Constraints

- Only modify the Act Rank rendering logic and focused tests.
- Crystal count is `min(valid WinsByTier entries, max(0, floor(wins)), 49)`.
- Use existing `/mmr/{tier}_{up|down}.png` and `/mmr/border{level}.png` assets.
- Preserve highest-tier-first placement and official border thresholds.
- Do not render a custom SVG background, grid, mask, or border.

---

### Task 1: Reproduce the overfill and native-position failures

**Files:**
- Modify: `src/components/live-game/act-rank.test.ts`
- Modify: `src/components/live-game/act-rank-triangle.test.tsx`

**Interfaces:**
- Consumes: `buildActRankTiles(winsByTier, wins)`, `actRankTilePosition(row, column)`, `ActRankTriangle`
- Produces: Regression coverage for explicit win caps, official placement, and removal of SVG duplication.

- [ ] **Step 1: Write failing pure-logic tests**

Assert that `buildActRankTiles({ "20": 49 }, 14)` returns 14 tiles and ends at row 3, column 4. Assert that 60 wins still cap at 49, and zero/negative wins render zero. Assert `actRankTilePosition(0, 0)` equals `{ left: 193.5, top: 152, width: 125, height: 111 }`, while row/column movement is `55.5px` vertically and `62.5px` horizontally.

- [ ] **Step 2: Write the failing rendering regression**

Render `<ActRankTriangle winsByTier={{ "20": 49 }} wins={14} />`; expect exactly 14 `data-rank-cell` images, `border1.png`, no `<svg>`, no `<clipPath>`, and no custom lattice polygons.

- [ ] **Step 3: Verify RED**

Run: `bun test src/components/live-game/act-rank.test.ts src/components/live-game/act-rank-triangle.test.tsx`

Expected: FAIL because tile construction does not accept `wins`, 49 tier entries fill all cells, the native-position helper does not exist, and the component still renders SVG.

---

### Task 2: Implement the official PNG layout and explicit win cap

**Files:**
- Modify: `src/components/live-game/act-rank.ts`
- Modify: `src/components/live-game/act-rank-triangle.tsx`

**Interfaces:**
- Produces: `buildActRankTiles(winsByTier: Record<string, number>, wins: number): ActRankTile[]`
- Produces: `actRankTilePosition(row: number, column: number): { left: number; top: number; width: number; height: number }`

- [ ] **Step 1: Add official placement constants and helper**

Use canvas `512`, tile width `125`, tile height `111`, first-row top `152`, horizontal step `62.5`, and vertical step `55.5`. Calculate `left = 256 - 62.5 * (row + 1) + 62.5 * column` and `top = 152 + 55.5 * row`.

- [ ] **Step 2: Cap tile creation by explicit Act wins**

Normalize `wins` with `Math.max(0, Math.floor(Number(wins) || 0))`, cap it at the 49 generated slots, and slice the sorted valid tier list to that count.

- [ ] **Step 3: Replace SVG rendering with responsive absolute PNGs**

Render tier images directly inside the square wrapper. Convert the helper's 512-unit left/top/width/height values to percentages so the composition scales responsively. Keep the official border PNG as the topmost `pointer-events-none` image.

- [ ] **Step 4: Verify GREEN**

Run: `bun test src/components/live-game/act-rank.test.ts src/components/live-game/act-rank-triangle.test.tsx`

Expected: All focused tests pass and a 49-entry tier map with `wins=14` renders only 14 crystals.

---

### Task 3: Complete regression verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Corrected Act Rank implementation.
- Produces: Test, build, and patch-hygiene evidence.

- [ ] **Step 1: Run all tests**

Run: `bun test`

Expected: Zero failures.

- [ ] **Step 2: Run the production build**

Run: `bun run build:vite`

Expected: TypeScript and Vite build successfully; existing Vite warnings may remain.

- [ ] **Step 3: Inspect the patch**

Run: `git diff --check`

Expected: No whitespace errors and no surrounding Career UI changes from this fix.

