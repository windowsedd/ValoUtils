# Act Rank Crystals Touch Border Design

## Goal

Move the Rank crystal layer to the silver border's inner edge. Keep the black lattice at the approved narrow inset.

## Scope

Change the Act Rank geometry helpers, crystal positioning, and focused tests. Keep the official border and crystal PNG assets, win ordering, border thresholds, card layout, and controls unchanged.

## Geometry

Maintain two centered equilateral coordinate spaces inside the `512 × 512` canvas:

- The lattice uses `innerTrianglePoints()`. It stays 10 SVG units inside the frame interior, which produces a 7.5 px gap at the component's 384 px maximum width.
- Rank crystals use `frameInnerTrianglePoints()`. Boundary crystals meet the silver border's inner edge.

Extract the row and column calculation into one pure helper that accepts three triangle points. Keep `actRankCellPoints()` and `actRankCellBounds()` for the inset lattice. Add crystal-specific point and bounds helpers that use the frame-interior triangle.

Do not scale or stretch individual PNGs beyond their cell bounds. Adjacent Rank crystals must continue to share their full edges.

## Rendering

`ActRankTriangle` continues to draw the black mask and inset lattice from `buildLatticeCells()`. Position each `/mmr/<tier>_<orientation>.png` with the new crystal bounds. Keep the masked official border layer above the crystal layer so the frame edge remains clean.

Filled boundary crystals may cover the black gap where they touch the border. Unfilled parts of the lattice retain the narrow black gap.

## Verification

Add tests that confirm:

- the first lattice cell starts at `y = 116`;
- the first Rank crystal starts at the frame-interior apex at `y = 96`;
- the crystal lattice uses the frame-interior base at `y = 411`;
- neighboring Rank crystals share vertices and edges;
- the component positions crystal PNGs with crystal-specific bounds;
- the SVG lattice keeps its current inset geometry;
- border tier selection and the number of rendered Rank PNGs do not change.

Run the focused Act Rank tests, TypeScript compilation, and the Vite production build.
