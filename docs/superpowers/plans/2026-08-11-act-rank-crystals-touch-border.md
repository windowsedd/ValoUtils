# Act Rank Crystals Touch Border Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Position Rank crystal PNGs against the silver border's inner edge while leaving the black lattice at its current inset.

**Architecture:** Generalize the triangular-cell calculation so it accepts either the inset lattice triangle or the frame-interior triangle. Keep existing lattice helpers unchanged at their public interface, add crystal-specific helpers, and make `ActRankTriangle` use the crystal bounds only for Rank PNG positioning.

**Tech Stack:** React 19, TypeScript 6, inline SVG, Bun test runner

## Global Constraints

- Keep the canvas at `512 × 512`.
- Keep the lattice inset at 10 SVG units.
- Keep official border and Rank PNG assets, win ordering, and border thresholds unchanged.
- Do not stretch Rank PNGs beyond their calculated triangular cell bounds.
- Do not change the Act Rank card or its controls.

---

### Task 1: Add crystal geometry and switch Rank positioning

**Files:**
- Modify: `src/components/live-game/act-rank.ts`
- Modify: `src/components/live-game/act-rank-triangle.tsx`
- Test: `src/components/live-game/act-rank.test.ts`
- Test: `src/components/live-game/act-rank-triangle.test.tsx`

**Interfaces:**
- Consumes: `frameInnerTrianglePoints()`, `innerTrianglePoints()`, `Point`, and `ActRankCellBounds`.
- Produces: `actRankCrystalCellPoints(row: number, column: number): readonly [Point, Point, Point]` and `actRankCrystalCellBounds(row: number, column: number): ActRankCellBounds`. `ActRankTriangle` keeps its current props and uses the new bounds for PNG positioning.

- [ ] **Step 1: Write failing crystal-geometry tests**

Add one geometry test through the existing module namespace so the RED run fails with an assertion rather than an import error:

```ts
test("builds Rank crystal cells against the frame interior", () => {
	type TestPoint = readonly [number, number];
	const geometry = actRankGeometry as typeof actRankGeometry & {
		actRankCrystalCellPoints?: (
			row: number,
			column: number,
		) => readonly [TestPoint, TestPoint, TestPoint];
		actRankCrystalCellBounds?: (
			row: number,
			column: number,
		) => { left: number; top: number; width: number; height: number };
	};
	expect(geometry.actRankCrystalCellPoints).toBeDefined();
	expect(geometry.actRankCrystalCellBounds).toBeDefined();
	if (!geometry.actRankCrystalCellPoints || !geometry.actRankCrystalCellBounds) return;

	const [apex] = geometry.actRankCrystalCellPoints(0, 0);
	const firstBounds = geometry.actRankCrystalCellBounds(0, 0);
	const lastRowBounds = geometry.actRankCrystalCellBounds(6, 0);
	expect(apex).toEqual([256, 96]);
	expect(firstBounds.top).toBe(96);
	expect(firstBounds.height).toBe(45);
	expect(lastRowBounds.top + lastRowBounds.height).toBe(411);
});
```

Extend the component test with the first crystal's frame-apex position while retaining the inset-lattice markers:

```ts
expect(markup).toContain('data-act-rank-lattice=""');
expect(markup).toContain('data-rank-cell="" class="absolute z-[2] object-fill" style="left:44.925');
expect(markup).toContain('top:18.75%');
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
bun test src/components/live-game/act-rank.test.ts src/components/live-game/act-rank-triangle.test.tsx
```

Expected: FAIL because the crystal-specific helpers do not exist and the first Rank PNG still starts at `top:22.65625%`.

- [ ] **Step 3: Generalize the pure cell calculation**

Replace the body of `actRankCellPoints` with one private helper and add the crystal variant:

```ts
const cellPointsForTriangle = (
	triangle: readonly [Point, Point, Point],
	row: number,
	column: number,
): readonly [Point, Point, Point] => {
	const [apex, left, right] = triangle;
	const cellWidth = (right[0] - left[0]) / ACT_RANK_GEOMETRY.rows;
	const cellHeight = (left[1] - apex[1]) / ACT_RANK_GEOMETRY.rows;
	const top = apex[1] + row * cellHeight;
	const bottom = top + cellHeight;
	const x =
		ACT_RANK_GEOMETRY.centerX -
		((row + 1) * cellWidth) / 2 +
		(column * cellWidth) / 2;
	return column % 2 === 0
		? [[x + cellWidth / 2, top], [x, bottom], [x + cellWidth, bottom]]
		: [[x, top], [x + cellWidth, top], [x + cellWidth / 2, bottom]];
};

export const actRankCellPoints = (row: number, column: number) =>
	cellPointsForTriangle(innerTrianglePoints(), row, column);

export const actRankCrystalCellPoints = (row: number, column: number) =>
	cellPointsForTriangle(frameInnerTrianglePoints(), row, column);
```

- [ ] **Step 4: Share the bounds calculation and add crystal bounds**

Extract the existing min/max calculation and expose the second bounds helper:

```ts
const boundsFromPoints = (points: readonly Point[]): ActRankCellBounds => {
	const xs = points.map(([x]) => x);
	const ys = points.map(([, y]) => y);
	const left = Math.min(...xs);
	const top = Math.min(...ys);
	return {
		left,
		top,
		width: Math.max(...xs) - left,
		height: Math.max(...ys) - top,
	};
};

export const actRankCellBounds = (row: number, column: number) =>
	boundsFromPoints(actRankCellPoints(row, column));

export const actRankCrystalCellBounds = (row: number, column: number) =>
	boundsFromPoints(actRankCrystalCellPoints(row, column));
```

- [ ] **Step 5: Switch only crystal PNG positioning**

In `act-rank-triangle.tsx`, replace the `actRankCellBounds` import and call with `actRankCrystalCellBounds`:

```tsx
import {
	ACT_RANK_CANVAS_SIZE,
	actRankCrystalCellBounds,
	borderIndexForWins,
	buildActRankTiles,
	buildLatticeCells,
	frameInnerTrianglePoints,
	innerTrianglePoints,
} from "./act-rank";

const position = actRankCrystalCellBounds(tile.row, tile.column);
```

Do not change `buildLatticeCells()`, so the SVG lattice keeps using `innerTrianglePoints()`.

- [ ] **Step 6: Run focused tests and confirm GREEN**

```bash
bun test src/components/live-game/act-rank.test.ts src/components/live-game/act-rank-triangle.test.tsx
```

Expected: 14 tests PASS. The first Rank crystal starts at `y = 96`; the lattice still starts at `y = 116`.

- [ ] **Step 7: Run compiler and production build**

```bash
bunx tsc --noEmit
bun run build:vite
```

Expected: both commands exit 0. Vite may print the repository's existing native-config and bundle-size warnings.

- [ ] **Step 8: Commit the adjustment**

```bash
git add src/components/live-game/act-rank.ts src/components/live-game/act-rank.test.ts src/components/live-game/act-rank-triangle.tsx src/components/live-game/act-rank-triangle.test.tsx
git commit -m "fix: align rank crystals to border interior"
```
