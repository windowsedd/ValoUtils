# Act Rank Border Gap Design

## Goal

Separate the Act Rank triangle from its border with a narrow black gap. Keep the official border size and border tier selection unchanged. Shrink the lattice and rank crystals enough to create a visible 6–8 px gap at the component's maximum rendered width.

## Scope

Change only `ActRankTriangle` and its shared geometry helpers and tests. Keep the Act Rank card, season selector, labels, statistics, collapse control, and responsive layout unchanged.

Continue using `/mmr/border0.png` through `/mmr/border5.png`. These images contain both the official border artwork and a lattice that reaches the border. The component must cover the embedded lattice before drawing the separated inner triangle.

## Rendering Layers

Render the badge in four layers from back to front:

1. The selected official border PNG at its current full size.
2. A black triangular mask that covers the lattice embedded in the border PNG without covering the visible frame or its outer decorations.
3. A smaller inner triangle containing the lattice and rank-cell PNGs.
4. The visible border artwork above the rank cells where needed to preserve the frame edges.

The component may reuse the selected border image for the back and front passes. The front pass must expose only the border and decorations; it must not restore the embedded lattice over the new inner triangle.

Use one inline SVG for the black mask and the inner lattice. Keep rank crystals as the existing `/mmr/<tier>_<orientation>.png` images so their official artwork and tier colors remain unchanged.

## Geometry

Keep the outer canvas at `512 × 512`. Add one named inner-content inset to `act-rank.ts` and derive the inner apex, base, cell bounds, mask points, and lattice points from it.

At the component's `24rem` maximum width, the visible black gap should measure about 6–8 CSS pixels. Scale the gap with the component so it stays proportional at narrower widths.

The inner triangle remains centered on the same vertical axis as the official border. The apex moves down and the lower corners move inward and upward by the same geometric inset. Rank cells share the inner lattice coordinates, so adjacent crystal images keep touching and remain aligned with the grid.

## Component Boundaries

`act-rank.ts` owns pure geometry calculations. It exposes the outer mask points, inset inner-triangle points, and cell bounds. `ActRankTriangle` owns layer ordering and converts normalized coordinates into SVG points or percentage positions.

The component does not fetch data or change win ordering. `borderIndexForWins` continues to select the official border from total Act wins.

## Accessibility and Responsive Behavior

Keep the badge decorative with `aria-hidden="true"` and empty image alt text. Preserve the square aspect ratio and `max-w-[24rem]` container. The gap, lattice, and crystals scale together with the container.

## Verification

Add tests that confirm:

- the selected official border image still matches the current win thresholds;
- the mask and independent inner-lattice layer render;
- the inner triangle stays centered and lies inside the border triangle;
- all crystal bounds use the inset geometry;
- neighboring crystal cells still share edges without gutters;
- the component remains SVG-assisted rather than replacing the official border and crystal assets.

Run the focused Act Rank geometry and component tests, TypeScript compilation, and the Vite build. Inspect border levels 0 and 5 at the maximum component width and at a narrow card width. Confirm a continuous 6–8 px black gap on all three sides and check that the mask does not cover high-tier border decorations.
