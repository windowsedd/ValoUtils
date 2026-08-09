# Compact Live Player Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove excessive empty space from expanded live-player rows while preserving their information, responsiveness, and accessibility.

**Architecture:** Keep `PlayerRow` and its collapsed grid intact. Export a small set of layout class constants so Bun tests can enforce the compact responsive contract, then restructure only the expanded region into a dense stats/skins first row and full-width history second row.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, Bun test runner.

## Global Constraints

- The collapsed player row and its columns remain unchanged.
- Expanded spacing uses the existing 4px/8px rhythm.
- Match history spans every expanded-layout column.
- Keyboard focus, `aria-expanded`, and reduced-motion behavior remain intact.
- Existing colors, fonts, ranks, assets, and localization keys remain unchanged.

---

### Task 1: Compact expanded player layout

**Files:**
- Create: `src/components/live-game/live-scout-layout.ts`
- Create: `src/components/live-game/live-scout-layout.test.ts`
- Modify: `src/components/live-game/live-scout-table.tsx`

**Interfaces:**
- Produces: `EXPANDED_GRID_CLASS`, `STATS_STRIP_CLASS`, `SKIN_GRID_CLASS`, and `HISTORY_SPAN_CLASS` string constants.
- Consumes: existing `SkinCard`, `LivePlayerHistory`, and responsive Tailwind breakpoints.

- [ ] **Step 1: Write the failing layout-contract test**

```ts
import { describe, expect, test } from "bun:test";
import {
  EXPANDED_GRID_CLASS,
  HISTORY_SPAN_CLASS,
  SKIN_GRID_CLASS,
  STATS_STRIP_CLASS,
} from "./live-scout-layout";

describe("expanded live player layout", () => {
  test("uses dense spacing and full-width history", () => {
    expect(EXPANDED_GRID_CLASS).toContain("gap-2");
    expect(EXPANDED_GRID_CLASS).toContain("px-2");
    expect(EXPANDED_GRID_CLASS).toContain("pb-2");
    expect(STATS_STRIP_CLASS).toContain("grid-cols-3");
    expect(SKIN_GRID_CLASS).toContain("grid-cols-3");
    expect(HISTORY_SPAN_CLASS).toContain("lg:col-span-2");
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test src/components/live-game/live-scout-layout.test.ts`

Expected: module-not-found failure for `live-scout-layout`.

- [ ] **Step 3: Add the layout contract**

```ts
export const EXPANDED_GRID_CLASS = "grid grid-cols-1 lg:grid-cols-[minmax(280px,1fr)_minmax(360px,1.35fr)] gap-2 px-2 pb-2 pt-1.5 bg-black/10";
export const STATS_STRIP_CLASS = "grid grid-cols-3 gap-2 rounded-lg border border-white/6 bg-white/2 px-2.5 py-2";
export const SKIN_GRID_CLASS = "grid grid-cols-3 gap-2";
export const HISTORY_SPAN_CLASS = "min-w-0 lg:col-span-2";
```

- [ ] **Step 4: Restructure the expanded JSX**

Import the constants. Replace the tall nested stats card with one compact header line, `STATS_STRIP_CLASS`, and one compact peak footer. Change `SkinCard` to `px-2.5 py-2`, image container `h-8`, image `max-h-7`, and remove redundant top margin. Wrap `LivePlayerHistory` in `<div className={HISTORY_SPAN_CLASS}>` so history occupies the full second row.

Do not change the player button classes or collapsed grid templates.

- [ ] **Step 5: Run tests and build**

```powershell
bun test src/components/live-game/live-scout-layout.test.ts
bun run build:vite
bun run lint
```

Expected: one Bun test passes; TypeScript/Vite build succeeds; ESLint has zero warnings.

- [ ] **Step 6: Commit the compact layout**

```powershell
git add src/components/live-game/live-scout-layout.ts src/components/live-game/live-scout-layout.test.ts src/components/live-game/live-scout-table.tsx
git commit -m "fix: compact expanded live player details"
```

### Task 2: Responsive verification

**Files:**
- Verify: `src/components/live-game/live-scout-table.tsx`

**Interfaces:**
- Consumes Task 1 layout.
- Produces a responsive, visually verified expanded row.

- [ ] **Step 1: Run the Vite development server**

Run: `bun run dev:vite`

Expected: Vite prints a local preview URL without compilation errors.

- [ ] **Step 2: Inspect required widths**

Open the Live Game page at 976px and 1440px viewport widths with one player expanded. At 976px, stats, skins, and history stack with 8px gaps. At 1440px, stats and skins share the first row and history spans both columns. Confirm there is no empty grid column, clipped content, nested horizontal scrollbar, or change to the collapsed row height.

- [ ] **Step 3: Verify accessibility behavior**

Tab to the player row, press Enter to expand/collapse it, and confirm the visible focus ring remains. Enable reduced motion and confirm the chevron does not animate. Confirm skin images retain meaningful alt text and the unavailable glyph retains its accessible label.

- [ ] **Step 4: Stop the development server and record verification**

Stop only the Vite process started in Step 1. Do not terminate unrelated Bun, Node, Riot, or ValoUtils processes.

