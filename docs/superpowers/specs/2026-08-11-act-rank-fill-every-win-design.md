# Act Rank Fill Every Win Design

## Goal

Render one rank crystal for every recorded Act win instead of stopping after nine crystals.

## Source Data

`winsByTier` is an aggregate map from competitive tier to win count. Each unit in a tier's count produces exactly one crystal using that tier's Valorant palette. The data does not contain the chronological order of individual wins, so crystals are ordered by tier from highest to lowest, matching the existing rank-priority behavior.

## Placement

Generate filled-cell slots from the same seven-row triangular lattice used by the border and grid. Traverse rows from the apex downward and columns from left to right within each row. Do not maintain a separate hard-coded nine-slot list.

The cumulative row capacities are `1`, `4`, `9`, `16`, `25`, `36`, and `49`. Therefore an Act with 14 wins fills the first three rows completely and the first five cells of the fourth row.

The seven-row reference lattice contains 49 cells. If an Act records more than 49 wins, render all 49 cells as filled while leaving the displayed Wins statistic unchanged at the real total. Expanding the reference lattice or changing its visual proportions is outside this correction.

## Colors

Keep the existing tier palette mapping. Every rendered crystal retains the actual rank tier represented by its source entry in `winsByTier`; no fixed cyan/purple recoloring is introduced.

## Scope

Modify only the Act Rank tile-generation logic and its tests. Keep the approved triangle geometry, border, grid, facets, responsive sizing, Act selector, statistics, Career Header, and other UI unchanged.

## Verification

Add test-first coverage proving:

- 14 recorded wins produce 14 crystals;
- the 14 crystals occupy rows `0..2` completely plus columns `0..4` of row `3`;
- tier counts remain represented exactly and remain sorted from highest to lowest;
- invalid tiers and negative counts remain excluded;
- 49 wins fill the complete lattice;
- more than 49 wins cap only the rendered crystals, not the separate Wins statistic.

Run the focused Act Rank tests, full Bun suite, TypeScript compilation, and Vite production build.
