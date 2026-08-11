# Act Rank Native PNG Alignment Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each Act win render one tier crystal, capped at 49, with every PNG scaled into the aligned seven-row border lattice.

**Architecture:** Keep the tested seven-row 512-unit cell geometry, but use it only to calculate responsive HTML image bounds; the official border PNG supplies the visible background and grid. Pass the selected Act's explicit `wins` value into tile construction so stale or oversized `WinsByTier` totals cannot exceed the selected Act's wins or the 49-cell custom capacity.

**Tech Stack:** React, TypeScript, CSS absolute positioning, Bun test, React server rendering.

## Global Constraints

- Only modify the Act Rank rendering logic and focused tests.
- Crystal count is `min(valid WinsByTier entries, max(0, floor(wins)), 49)`.
- Use existing `/mmr/{tier}_{up|down}.png` and `/mmr/border{level}.png` assets.
- Preserve highest-tier-first placement and official border thresholds.
- Do not render a custom SVG background, grid, mask, or border.

---

### Task 1: Reproduce the overfill and cell-position failures

**Files:**
- Modify: `src/components/live-game/act-rank.test.ts`
- Modify: `src/components/live-game/act-rank-triangle.test.tsx`

**Interfaces:**
- Consumes: `buildActRankTiles(winsByTier, wins)`, `actRankCellBounds(row, column)`, `ActRankTriangle`
- Produces: Regression coverage for explicit win caps, official placement, and removal of SVG duplication.

- [ ] **Step 1: Write failing pure-logic tests**

Assert that `buildActRankTiles({ "20": 49 }, 14)` returns 14 tiles and ends at row 3, column 4. Assert that 60 wins still cap at 49, and zero/negative wins render zero. Assert `actRankCellBounds(0, 0)` uses top `96`, height `45`, and the width derived from the equilateral seven-row lattice.

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
- Produces: `actRankCellBounds(row: number, column: number): { left: number; top: number; width: number; height: number }`

- [ ] **Step 1: Add shared cell-bounds helper**

Calculate the minimum x/y and maximum x/y from `actRankCellPoints(row, column)`. Return those values as left, top, width, and height so every image fits its equilateral cell and stays inside the inner triangle.

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
