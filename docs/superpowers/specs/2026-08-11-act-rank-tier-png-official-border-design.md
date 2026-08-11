# Act Rank Competitive Tier PNG and Official Border Design

## Goal

Render the Act Rank visualization with the project's existing Riot Competitive Tier crystal PNGs and official win-border PNGs while preserving the current custom rule that every Act win fills one lattice cell.

## Scope

Only the Act Rank triangle visualization changes. The surrounding Career card, rank text, statistics, dropdowns, buttons, match details, and profile modal remain unchanged.

## Rendering Layers

The visualization uses one square, responsive composition with these layers from back to front:

1. One Competitive Tier PNG for each filled win slot.
2. The official Riot-style win-border PNG selected from the player's total Act wins. The border asset supplies the background triangle and lattice.

The official border image is the topmost layer and must not intercept pointer events.

## Crystal Images

Each filled lattice cell uses an existing image from `public/mmr`:

```text
/mmr/{competitiveTier}_{orientation}.png
```

- `competitiveTier` is the numeric tier recorded for that win, from 3 through 27.
- `orientation` is `up` or `down`, taken from the shared triangular lattice cell.
- Wins remain sorted from highest tier to lowest tier before placement, matching the current behavior.
- One valid win fills one slot, but the rendered count must never exceed the explicit `wins` value supplied for the selected Act.
- The seven-row layout still has a maximum capacity of 49 slots.
- A 14-win Act therefore displays 14 filled crystals, not nine.
- Invalid tiers and non-positive win counts remain excluded.

The PNGs replace the hand-generated SVG facet gradients. Each PNG is scaled to the bounds of its assigned cell in the shared seven-row lattice. The source asset's 125×111 dimensions are not used as display dimensions because they extend outside the border when repeated across seven rows.

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

- Use a square 512 by 512 composition to match the official assets without cropping their outer decorations.
- Use the existing centered seven-row equilateral lattice with inner apex y `96px`, inner base y `411px`, and center x `256px`.
- Calculate every image's left, top, width, and height from its lattice cell points; do not maintain independent coordinates per crystal.
- Convert the 512-unit cell bounds to percentages so all tier images scale responsively with the square wrapper.
- Remove the custom SVG background, grid, clipping mask, and border strokes. The official border PNG already supplies the aligned background triangle and lattice.
- Keep the visualization centered, responsive, and constrained to the existing maximum display size.

## Accessibility and Interaction

The visualization remains decorative with `aria-hidden="true"`. Crystal and border images use empty alt text. The border overlay uses `pointer-events: none`.

## Testing

Automated tests will verify:

- A tier distribution whose counts exceed `wins` renders exactly `wins` Competitive Tier crystal images.
- A 14-win Act renders exactly 14 images even when `winsByTier` contains 49 or more entries.
- Each crystal image path includes the correct numeric tier and its lattice `up` or `down` orientation.
- The border thresholds select `border0.png` through `border5.png` correctly.
- The official border is layered above the crystals and does not capture pointer events.
- Tier PNG bounds are derived from the shared seven-row cell geometry and remain inside the official border.
- The former SVG, gradient facets, custom lattice, clipping mask, and custom outer border are no longer rendered.
