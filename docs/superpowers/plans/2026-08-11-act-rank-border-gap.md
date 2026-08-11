# Act Rank Border Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the Act Rank lattice and crystal triangle from the official border with a proportional 6–8 px black gap.

**Architecture:** Keep the official border and crystal PNG assets. Add pure inset geometry in `act-rank.ts`, cover the lattice embedded in the border PNG with an SVG mask layer, render a smaller SVG lattice, position the crystal PNGs from the same inset geometry, and restore only the border artwork with an SVG image mask on the top layer.

**Tech Stack:** React 19, TypeScript 6, inline SVG, Tailwind CSS v4, Bun test runner

## Global Constraints

- Keep the outer canvas at `512 × 512`.
- Preserve the square aspect ratio and `max-w-[24rem]` container.
- Keep `/mmr/border0.png` through `/mmr/border5.png` and `/mmr/<tier>_<orientation>.png`.
- Keep `borderIndexForWins` and win ordering unchanged.
- Render a proportional 6–8 CSS pixel gap at the component's 24rem maximum width.
- Keep the badge decorative with `aria-hidden="true"` and empty image alt text.
- Do not change the Act Rank card, selector, labels, statistics, collapse control, or responsive panel layout.

---

### Task 1: Add inset geometry for the separated content triangle

**Files:**
- Modify: `src/components/live-game/act-rank.ts`
- Test: `src/components/live-game/act-rank.test.ts`

**Interfaces:**
- Consumes: `ACT_RANK_GEOMETRY`, `Point`, and the existing equilateral-triangle coordinate system.
- Produces: `ACT_RANK_CONTENT_INSET: 10`, `frameInnerTrianglePoints(): readonly [Point, Point, Point]`, and an updated `innerTrianglePoints(): readonly [Point, Point, Point]`. Existing `actRankCellPoints`, `actRankCellBounds`, `buildLatticeCells`, and `pointInsideInnerTriangle` consume the updated content triangle without signature changes.

- [ ] **Step 1: Write failing inset-geometry tests**

Add imports for `ACT_RANK_CONTENT_INSET` and `frameInnerTrianglePoints`. Replace the old inset-border assertion with separate frame-interior and content-inset assertions:

```ts
test("insets the content triangle from the official frame interior", () => {
	type TestPoint = readonly [number, number];
	const [frameApex, frameLeft, frameRight] = frameInnerTrianglePoints();
	const [contentApex, contentLeft, contentRight] = innerTrianglePoints();

	expect(frameApex).toEqual([256, 96]);
	expect(frameLeft[1]).toBe(411);
	expect(frameRight[1]).toBe(411);
	expect(contentApex).toEqual([256, 116]);
	expect(contentLeft[1]).toBe(401);
	expect(contentRight[1]).toBe(401);
	expect(ACT_RANK_CONTENT_INSET).toBe(10);

	const lineDistance = (point: TestPoint, start: TestPoint, end: TestPoint) =>
		Math.abs(
			(end[0] - start[0]) * (start[1] - point[1]) -
			(start[0] - point[0]) * (end[1] - start[1]),
		) / Math.hypot(end[0] - start[0], end[1] - start[1]);

	expect(lineDistance(contentLeft, frameApex, frameLeft)).toBeCloseTo(10, 10);
	expect(lineDistance(contentRight, frameApex, frameRight)).toBeCloseTo(10, 10);
});
```

Update the cell-bound expectations to the new content geometry:

```ts
const first = actRankCellBounds(0, 0);
expect(first.top).toBe(116);
expect(first.height).toBeCloseTo(285 / 7, 10);
expect(first.left + first.width / 2).toBeCloseTo(256, 10);
```

- [ ] **Step 2: Run the focused geometry test and confirm failure**

Run:

```bash
bun test src/components/live-game/act-rank.test.ts
```

Expected: FAIL because `ACT_RANK_CONTENT_INSET` and `frameInnerTrianglePoints` do not exist and the first cell still starts at `y = 96`.

- [ ] **Step 3: Implement the frame and content triangles**

Keep the current frame-interior constants and derive the content inset from them:

```ts
export const ACT_RANK_CONTENT_INSET = 10;

export const frameInnerTrianglePoints = (): readonly [Point, Point, Point] => {
	const halfWidth = equilateralHalfWidth(
		ACT_RANK_GEOMETRY.innerBaseY - ACT_RANK_GEOMETRY.innerApexY,
	);
	return [
		[ACT_RANK_GEOMETRY.centerX, ACT_RANK_GEOMETRY.innerApexY],
		[ACT_RANK_GEOMETRY.centerX - halfWidth, ACT_RANK_GEOMETRY.innerBaseY],
		[ACT_RANK_GEOMETRY.centerX + halfWidth, ACT_RANK_GEOMETRY.innerBaseY],
	];
};

export const innerTrianglePoints = (): readonly [Point, Point, Point] => {
	const apexY = ACT_RANK_GEOMETRY.innerApexY + ACT_RANK_CONTENT_INSET * 2;
	const baseY = ACT_RANK_GEOMETRY.innerBaseY - ACT_RANK_CONTENT_INSET;
	const halfWidth = equilateralHalfWidth(baseY - apexY);
	return [
		[ACT_RANK_GEOMETRY.centerX, apexY],
		[ACT_RANK_GEOMETRY.centerX - halfWidth, baseY],
		[ACT_RANK_GEOMETRY.centerX + halfWidth, baseY],
	];
};
```

- [ ] **Step 4: Run the focused geometry test and confirm success**

Run:

```bash
bun test src/components/live-game/act-rank.test.ts
```

Expected: PASS for the geometry, tile ordering, border threshold, season selection, and asset tests.

- [ ] **Step 5: Commit the geometry change**

```bash
git add src/components/live-game/act-rank.ts src/components/live-game/act-rank.test.ts
git commit -m "feat: inset act rank triangle geometry"
```

---

### Task 2: Render independent mask, lattice, crystal, and border layers

**Files:**
- Modify: `src/components/live-game/act-rank-triangle.tsx`
- Test: `src/components/live-game/act-rank-triangle.test.tsx`

**Interfaces:**
- Consumes: `ACT_RANK_CANVAS_SIZE`, `actRankCellBounds`, `borderIndexForWins`, `buildActRankTiles`, `buildLatticeCells`, `frameInnerTrianglePoints`, and `innerTrianglePoints` from `act-rank.ts`.
- Produces: unchanged `ActRankTriangle({ winsByTier, wins })` component API; DOM markers `data-act-rank-mask`, `data-act-rank-lattice`, `data-rank-cell`, and `data-act-rank-border` for focused verification.

- [ ] **Step 1: Write failing layered-render tests**

Replace the assertion that forbids SVG with checks for the independent layers while retaining the official assets:

```tsx
test("separates the inset lattice and crystals from the official border", () => {
	const markup = renderToStaticMarkup(
		<ActRankTriangle winsByTier={{ "20": 47, "24": 2 }} wins={14} />,
	);

	expect(markup).toContain('max-w-[24rem]');
	expect(markup).toContain('aspect-square');
	expect(markup.match(/data-rank-cell=""/g)).toHaveLength(14);
	expect(markup).toContain('src="/mmr/24_up.png"');
	expect(markup).toContain('src="/mmr/20_down.png"');
	expect(markup).toContain('href="/mmr/border1.png"');
	expect(markup).toContain('data-act-rank-mask=""');
	expect(markup).toContain('data-act-rank-lattice=""');
	expect(markup).toContain('data-act-rank-border=""');
	expect(markup).toContain('<mask');
	expect(markup).toContain('<polygon');
});
```

Keep the border-threshold loop and change its asset assertion to:

```ts
expect(markup).toContain(`href="/mmr/border${border}.png"`);
```

- [ ] **Step 2: Run the component test and confirm failure**

Run:

```bash
bun test src/components/live-game/act-rank-triangle.test.tsx
```

Expected: FAIL because the current component renders one full border image above the crystals and has no mask or independent lattice.

- [ ] **Step 3: Add deterministic SVG point formatting and unique mask IDs**

Import `useId` from React and add:

```tsx
const asPoints = (points: readonly (readonly [number, number])[]) =>
	points.map(([x, y]) => `${x},${y}`).join(" ");

const safeSvgId = (prefix: string, id: string) =>
	`${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
```

Inside `ActRankTriangle`, create `borderMaskId`, `framePoints`, `contentPoints`, and `latticeCells` from the geometry helpers.

- [ ] **Step 4: Render the SVG mask and lattice below the crystals**

Place the official border image at the back. Above it, render one SVG with the same `0 0 512 512` view box:

```tsx
<svg
	viewBox={`0 0 ${ACT_RANK_CANVAS_SIZE} ${ACT_RANK_CANVAS_SIZE}`}
	className="pointer-events-none absolute inset-0 z-[1] h-full w-full"
	preserveAspectRatio="xMidYMid meet"
>
	<polygon data-act-rank-mask="" points={asPoints(framePoints)} fill="#020304" />
	<g data-act-rank-lattice="" fill="none" stroke="#343a40" strokeWidth="0.75">
		{latticeCells.map((cell) => (
			<polygon key={`${cell.row}-${cell.column}`} points={asPoints(cell.points)} />
		))}
	</g>
</svg>
```

Keep each crystal PNG absolutely positioned from `actRankCellBounds`, but move it to `z-[2]`.

- [ ] **Step 5: Restore only the official frame and outer decorations**

Render a top SVG whose mask removes the full frame-interior triangle from the repeated border image:

```tsx
<svg
	data-act-rank-border=""
	viewBox={`0 0 ${ACT_RANK_CANVAS_SIZE} ${ACT_RANK_CANVAS_SIZE}`}
	className="pointer-events-none absolute inset-0 z-10 h-full w-full"
	preserveAspectRatio="xMidYMid meet"
>
	<defs>
		<mask id={borderMaskId} maskUnits="userSpaceOnUse">
			<rect width={ACT_RANK_CANVAS_SIZE} height={ACT_RANK_CANVAS_SIZE} fill="white" />
			<polygon points={asPoints(framePoints)} fill="black" />
		</mask>
	</defs>
	<image
		href={`/mmr/border${border}.png`}
		width={ACT_RANK_CANVAS_SIZE}
		height={ACT_RANK_CANVAS_SIZE}
		mask={`url(#${borderMaskId})`}
	/>
</svg>
```

The base border image preserves any glow under the inner triangle. The top masked copy restores the frame and high-tier decorations without restoring the old lattice.

- [ ] **Step 6: Run the component and geometry tests**

Run:

```bash
bun test src/components/live-game/act-rank-triangle.test.tsx src/components/live-game/act-rank.test.ts
```

Expected: PASS with 14 official crystal PNGs, the correct border asset, a black frame-interior mask, a smaller lattice, and a top frame-only SVG image.

- [ ] **Step 7: Commit the layered renderer**

```bash
git add src/components/live-game/act-rank-triangle.tsx src/components/live-game/act-rank-triangle.test.tsx
git commit -m "feat: separate act rank triangle from border"
```

---

### Task 3: Verify type safety, production build, and visual spacing

**Files:**
- Verify: `src/components/live-game/act-rank.ts`
- Verify: `src/components/live-game/act-rank-triangle.tsx`
- Verify: `src/components/live-game/act-rank.test.ts`
- Verify: `src/components/live-game/act-rank-triangle.test.tsx`

**Interfaces:**
- Consumes: the geometry and component API produced by Tasks 1 and 2.
- Produces: evidence that the focused behavior, TypeScript program, and production Vite bundle pass without changing other Act Rank UI behavior.

- [ ] **Step 1: Run all focused Act Rank tests**

```bash
bun test src/components/live-game/act-rank.test.ts src/components/live-game/act-rank-triangle.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 2: Run TypeScript compilation**

```bash
bunx tsc --noEmit
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run the Vite production build**

```bash
bun run build:vite
```

Expected: `tsc` and Vite complete with exit code 0 and write the frontend bundle without errors.

- [ ] **Step 4: Inspect the rendered badge at two widths**

Run the existing development app and inspect border levels 0 and 5 at `384 px` and a narrow card width. Confirm:

```text
- a continuous black gap separates all three inner-triangle sides from the border;
- the gap measures about 6–8 px at 384 px;
- crystal edges align with the independent lattice;
- no embedded lattice reappears above the new lattice;
- border 5 decorations remain intact;
- surrounding Act Rank controls do not move.
```

- [ ] **Step 5: Commit any verification-only correction**

If visual inspection requires a geometry correction, update the named inset constant and its exact test expectation, rerun Steps 1–3, then commit only the relevant Act Rank files:

```bash
git add src/components/live-game/act-rank.ts src/components/live-game/act-rank.test.ts src/components/live-game/act-rank-triangle.tsx src/components/live-game/act-rank-triangle.test.tsx
git commit -m "fix: tune act rank border gap"
```
