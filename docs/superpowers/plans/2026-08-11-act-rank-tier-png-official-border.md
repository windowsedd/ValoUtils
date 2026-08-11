# Act Rank Tier PNG and Official Border Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every Act win with its recorded Competitive Tier PNG and overlay the official Riot win-level border.

**Architecture:** Keep `act-rank.ts` as the shared source for win ordering, cell orientation, geometry, and border thresholds. Convert the composition to a 512×512 coordinate space, render tier PNGs as SVG `<image>` elements fitted to lattice-cell bounds, and place the selected official border PNG above the SVG in one responsive square wrapper.

**Tech Stack:** React, TypeScript, SVG, Tailwind CSS, Bun test, React server rendering.

## Global Constraints

- Only change the Act Rank visualization and its focused tests.
- One valid recorded win fills one cell, capped at 49 cells.
- Crystal assets must use `/mmr/{competitiveTier}_{orientation}.png`.
- Border assets must use `/mmr/border{borderIndexForWins(wins)}.png`.
- Preserve the seven-row shared triangular lattice and actual recorded tier per win.
- Do not add dependencies or modify surrounding Career UI.

---

### Task 1: Lock the PNG composition contract with rendering tests

**Files:**
- Modify: `src/components/live-game/act-rank-triangle.test.tsx`

**Interfaces:**
- Consumes: `ActRankTriangle({ winsByTier, wins })`
- Produces: Regression coverage for tier/orientation paths, border thresholds, layering, and square geometry.

- [ ] **Step 1: Replace the obsolete SVG-only assertion with failing PNG composition tests**

Add a 14-win render assertion that expects `viewBox="0 0 512 512"`, 14 elements marked with `data-rank-cell`, tier paths such as `/mmr/24_up.png` and `/mmr/20_down.png`, and `/mmr/border1.png`. Assert that gradient palette markers and the custom outer-border stroke are absent. Add a threshold table that renders wins `0, 9, 25, 50, 75, 100` and expects borders `0, 1, 2, 3, 4, 5`.

- [ ] **Step 2: Run the focused component test and verify RED**

Run: `bun test src/components/live-game/act-rank-triangle.test.tsx`

Expected: FAIL because the current component has a 365×387 viewBox, renders no PNGs, and ignores `wins`.

---

### Task 2: Move the shared lattice into the official square coordinate system

**Files:**
- Modify: `src/components/live-game/act-rank.test.ts`
- Modify: `src/components/live-game/act-rank.ts`

**Interfaces:**
- Consumes: `ACT_RANK_GEOMETRY`, `innerTrianglePoints()`, `actRankCellPoints(row, column)`
- Produces: A centered 512×512 geometry aligned to the official border opening while retaining 49 equilateral cells.

- [ ] **Step 1: Update geometry assertions before production geometry**

Change the focused geometry test to expect a `512×512` canvas, center x-coordinate `256`, outer apex/base y-coordinates `48/464`, and inner apex/base y-coordinates `96/411`. Retain the symmetry, equilateral-ratio, shared-vertex, and inside-triangle assertions.

- [ ] **Step 2: Run the geometry test and verify RED**

Run: `bun test src/components/live-game/act-rank.test.ts`

Expected: FAIL on the old width, height, center, and inner points.

- [ ] **Step 3: Implement the square shared geometry**

Set `ACT_RANK_GEOMETRY` to `width: 512`, `height: 512`, `centerX: 256`, `apexY: 48`, `baseY: 464`, `innerApexY: 96`, `innerBaseY: 411`, and `rows: 7`. The existing equilateral-width calculation keeps both triangles exactly symmetric while the inner triangle sits inside the official border opening.

- [ ] **Step 4: Run the geometry test and verify GREEN**

Run: `bun test src/components/live-game/act-rank.test.ts`

Expected: PASS, including 49-cell capacity and orientation ordering.

---

### Task 3: Render Competitive Tier PNG cells and the official border

**Files:**
- Modify: `src/components/live-game/act-rank-triangle.tsx`

**Interfaces:**
- Consumes: `buildActRankTiles`, `actRankCellPoints`, `innerTrianglePoints`, `borderIndexForWins`
- Produces: A responsive decorative composition containing an SVG lattice, tier PNG cells, and one top-layer official border image.

- [ ] **Step 1: Replace SVG facet gradients with tier PNG images**

For each tile, calculate the minimum x/y and maximum x/y of `actRankCellPoints(tile.row, tile.column)`. Render an SVG `<image>` with `href={`/mmr/${tile.tier}_${tile.orientation}.png`}`, the calculated bounds, `preserveAspectRatio="none"`, and `data-rank-cell=""`. This fits every supplied up/down image to the exact shared lattice cell.

- [ ] **Step 2: Replace custom SVG borders with the official overlay**

Keep the dark clipped triangle and lattice inside the SVG, but remove the hand-drawn outer and silver border strokes. Use a relative square wrapper and add:

```tsx
<img
  src={`/mmr/border${borderIndexForWins(wins)}.png`}
  alt=""
  data-act-rank-border=""
  className="pointer-events-none absolute inset-0 z-10 h-full w-full object-contain"
/>
```

- [ ] **Step 3: Run the focused rendering tests and verify GREEN**

Run: `bun test src/components/live-game/act-rank-triangle.test.tsx src/components/live-game/act-rank.test.ts`

Expected: PASS with 14 tier PNG cells and the correct official border selection.

---

### Task 4: Verify the complete change

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes: The completed Act Rank implementation.
- Produces: Evidence that the feature compiles and does not regress the application.

- [ ] **Step 1: Run all tests**

Run: `bun test`

Expected: All tests pass with zero failures.

- [ ] **Step 2: Run the production build**

Run: `bun run build:vite`

Expected: TypeScript and Vite build successfully; existing non-fatal Vite warnings may remain.

- [ ] **Step 3: Check patch hygiene and scope**

Run: `git diff --check`

Expected: No whitespace errors. Review `git diff -- src/components/live-game/act-rank.ts src/components/live-game/act-rank-triangle.tsx src/components/live-game/act-rank.test.ts src/components/live-game/act-rank-triangle.test.tsx` and confirm only the visualization contract changed.
