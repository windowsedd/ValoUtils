# Act Rank Competitive Tier PNG and Official Border Design

## Goal

Render the Act Rank visualization with the project's existing Riot Competitive Tier crystal PNGs and official win-border PNGs while preserving the current custom rule that every Act win fills one lattice cell.

## Scope

Only the Act Rank triangle visualization changes. The surrounding Career card, rank text, statistics, dropdowns, buttons, match details, and profile modal remain unchanged.

## Rendering Layers

The visualization uses one square, responsive composition with these layers from back to front:

1. A dark inner triangle and clipped seven-row triangular lattice.
2. One Competitive Tier PNG for each filled win cell.
3. The official Riot-style win-border PNG selected from the player's total Act wins.

The official border image is the topmost layer and must not intercept pointer events.

## Crystal Images

Each filled lattice cell uses an existing image from `public/mmr`:

```text
/mmr/{competitiveTier}_{orientation}.png
```

- `competitiveTier` is the numeric tier recorded for that win, from 3 through 27.
- `orientation` is `up` or `down`, taken from the shared triangular lattice cell.
- Wins remain sorted from highest tier to lowest tier before placement, matching the current behavior.
- One valid win fills one cell, up to the seven-row lattice capacity of 49 cells.
- A 14-win Act therefore displays 14 filled crystals, not nine.
- Invalid tiers and non-positive win counts remain excluded.

The PNGs replace the hand-generated SVG facet gradients. Their transparent bounds are positioned by the same cell geometry as the lattice so adjacent crystals remain connected and aligned.

## Official Win Border

Use the existing `public/mmr/border0.png` through `border5.png` assets. Select the border using total Act wins:

| Total wins | Border image |
| --- | --- |
| 0–8 | `border0.png` |
| 9–24 | `border1.png` |
| 25–49 | `border2.png` |
| 50–74 | `border3.png` |
| 75–99 | `border4.png` |
| 100+ | `border5.png` |

The existing `borderIndexForWins(wins)` function remains the single source of truth for this mapping.

## Geometry and Responsiveness

- Use a square 512 by 512 SVG/composition coordinate system to match the official border assets without cropping their outer decorations.
- Align the inner equilateral lattice with the transparent triangular opening in the border PNG.
- Generate the background triangle, lattice, and filled-cell image bounds from the shared Act Rank geometry.
- Remove the custom SVG outer and inner border strokes to prevent a doubled frame beneath the official PNG.
- Keep the visualization centered, responsive, and constrained to the existing maximum display size.

## Accessibility and Interaction

The visualization remains decorative with `aria-hidden="true"`. Crystal and border images use empty alt text. The border overlay uses `pointer-events: none`.

## Testing

Automated tests will verify:

- A 14-win tier distribution renders 14 Competitive Tier crystal images.
- Each crystal image path includes the correct numeric tier and its lattice `up` or `down` orientation.
- The border thresholds select `border0.png` through `border5.png` correctly.
- The official border is layered above the crystals and does not capture pointer events.
- The square coordinate system and shared lattice geometry remain aligned.
- The former SVG gradient facets and custom outer border are no longer rendered.

