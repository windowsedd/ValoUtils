# Act Rank Triangle Redesign

## Scope

Replace only the graphic rendered by `ActRankTriangle`. Keep the Act Rank card, season selector, labels, statistics, collapse control, and their responsive layout unchanged.

The new badge should match the supplied second reference: a large, narrow rank pyramid with a restrained double border, a clipped triangular lattice, and connected faceted win cells near the upper portion.

## Geometry

Render one responsive inline SVG. A single geometry module owns the outer triangle, inner inset, lattice spacing, cell points, and filled-cell slots. The component must not position border and crystal assets with separate percentage coordinates.

Use a normalized tall view box with a centered apex and mirrored lower corners. Keep all three outer points derived from the center, badge width, badge height, and padding. Derive the inset triangle from those edges so the border gap remains even at every size.

Subdivide the inner triangle with one row/column lattice. Each cell uses the same horizontal and vertical pitch. Compute its three points from `(row, column, orientation)` and use those points for both grid lines and filled crystals. Clip every lattice line and crystal facet to the inner triangle.

The SVG preserves its aspect ratio at every card width. Its container grows beyond the current square presentation and uses most of the available vertical space without changing the surrounding panel grid.

## Border And Grid

Draw the border in two passes with `stroke-linejoin="round"`:

1. A thick charcoal outer stroke with rounded corners.
2. A thin silver-gray stroke on the inset triangle.

Leave a visible dark gap between the two strokes. Avoid white strokes and bright glow on the frame.

Fill the inner triangle with a low-contrast charcoal triangular lattice. Generate the three line families from the shared lattice pitch, then apply an SVG `clipPath` based on the inner triangle. Lines meet the triangle edges without extending through the frame.

## Win Cell Placement

Continue to select at most the nine highest-tier wins. Replace the centered `1, 3, 5` row packing with an ordered list of lattice coordinates.

The first seven cells reproduce the reference cluster:

```text
          [highest]
       [high] [next]
    [next] [next] [next]
             [next]
```

Number each horizontal lattice strip from `row = 0`, with columns `0..2r`. Even columns point up and odd columns point down. Assign wins in this order:

```text
(1,1),
(2,1), (2,2),
(3,2), (3,3), (3,4),
(4,3), (4,4), (4,5)
```

The first cell sits below the apex. The next cells extend down-left, right, and lower-left so the cluster feels connected but not centered. If an act supplies eight or nine visible wins, the final cells extend the lower edge of this same cluster instead of starting a new centered row.

Sort wins by tier before assigning these slots. This keeps the best results closest to the apex.

## Crystal Rendering

Draw each filled cell as SVG polygons rather than a floating PNG. Split a cell around its centroid into three triangular faces. Derive the face fills and edge highlight from the cell's actual Valorant tier palette:

- Tiers `3..5`, `6..8`, `9..11`, `12..14`, `15..17`, `18..20`, `21..23`, `24..26`, and `27` map to Iron, Bronze, Silver, Gold, Platinum, Diamond, Ascendant, Immortal, and Radiant palettes respectively.
- Higher and lower wins do not receive fixed violet or cyan colors unless those colors match their real tiers.
- Each palette provides a dark face, a base face, a highlight face, and a restrained edge color.

Adjacent cells share lattice vertices. Use only a thin highlight stroke, so neighboring cells read as connected diamonds and pyramids without visible gutters.

Define reusable SVG gradients once per rendered tier or palette. Keep generated IDs local to the component so multiple Act Rank panels can render on the same page without gradient or clip-path collisions.

## Component Boundaries

`act-rank.ts` exposes pure geometry and tier-palette helpers. `ActRankTriangle` converts those results into SVG elements. It performs no data fetching and owns no card state.

The redesign stops using `/mmr/border*.png` and `/mmr/<tier>_<orientation>.png` for layout. Leave the files in `public/mmr` because removing repository assets is outside this change.

## Verification

Add test-first coverage for:

- highest-tier sorting and the nine-cell cap;
- the new asymmetric slot order and alternating orientations;
- symmetry and tall aspect ratio of the outer triangle;
- inset-border alignment;
- shared vertices between neighboring lattice cells;
- tier-to-palette mapping at every rank boundary;
- generated points staying inside the inner triangle.

Run the focused Bun test, TypeScript compilation, and Vite build. Inspect the expanded Act Rank panel at desktop and narrow widths. Confirm that the SVG fills the center area, retains its aspect ratio, clips every grid line, and leaves all surrounding controls unchanged.
