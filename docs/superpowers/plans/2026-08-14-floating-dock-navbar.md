# Floating Dock Navbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current full-width tab strip with the approved two-row ValoUtils utility header and floating navigation dock.

**Architecture:** Keep route filtering and selection in the existing router context. Add a pure route-partition helper and a controlled `NavbarDock` presentation component so route grouping and accessible markup are independently testable; `Router` owns overflow-menu dismissal and navigation analytics.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, React Icons, Bun test, Vite 8.

## Global Constraints

- Preserve every route, hidden-tab preference, `tab_change` analytics event, and Riot account/presence action.
- Show at most five currently visible routes directly; place remaining routes in `More`.
- Keep the app usable at its configured 760 px minimum width.
- Keep all interactions keyboard accessible and retain visible focus states.
- Do not change route names, route order, persistence formats, page content, or Riot status data behavior.

---

### Task 1: Route partitioning

**Files:**
- Create: `src/util/navbar-routes.ts`
- Create: `src/util/navbar-routes.test.ts`

**Interfaces:**
- Consumes: `Route[]` from `src/types/router.ts` and a selected route id.
- Produces: `splitNavbarRoutes(routes: Route[], limit?: number): { dockRoutes: Route[]; overflowRoutes: Route[] }` and `isOverflowRouteSelected(overflowRoutes: Route[], selectedId: string): boolean`.

- [ ] **Step 1: Write the failing route-partition tests**

```ts
import { describe, expect, test } from "bun:test";
import type { Route } from "@/types/router";
import { isOverflowRouteSelected, splitNavbarRoutes } from "./navbar-routes";

const route = (id: string): Route => ({ id, title: `nav.${id}`, component: null });
const routes = ["profiles", "career", "matches", "live", "friends", "chat", "settings"].map(route);

describe("floating navbar route groups", () => {
  test("keeps the first five visible routes in the dock", () => {
    const result = splitNavbarRoutes(routes);
    expect(result.dockRoutes.map(({ id }) => id)).toEqual(["profiles", "career", "matches", "live", "friends"]);
    expect(result.overflowRoutes.map(({ id }) => id)).toEqual(["chat", "settings"]);
  });

  test("does not create overflow when five or fewer routes remain", () => {
    expect(splitNavbarRoutes(routes.slice(0, 5)).overflowRoutes).toEqual([]);
    expect(splitNavbarRoutes([])).toEqual({ dockRoutes: [], overflowRoutes: [] });
  });

  test("reports when the active route lives in overflow", () => {
    const { overflowRoutes } = splitNavbarRoutes(routes);
    expect(isOverflowRouteSelected(overflowRoutes, "chat")).toBe(true);
    expect(isOverflowRouteSelected(overflowRoutes, "profiles")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `bun test src/util/navbar-routes.test.ts`

Expected: FAIL because `./navbar-routes` does not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

```ts
import type { Route } from "@/types/router";

export const splitNavbarRoutes = (routes: Route[], limit = 5) => ({
  dockRoutes: routes.slice(0, limit),
  overflowRoutes: routes.slice(limit),
});

export const isOverflowRouteSelected = (overflowRoutes: Route[], selectedId: string) =>
  overflowRoutes.some(({ id }) => id === selectedId);
```

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `bun test src/util/navbar-routes.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Commit the helper**

```bash
git add src/util/navbar-routes.ts src/util/navbar-routes.test.ts
git commit -m "feat: group floating navbar routes"
```

### Task 2: Accessible floating dock component

**Files:**
- Create: `src/components/navbar-dock.tsx`
- Create: `src/components/navbar-dock.test.tsx`
- Modify: `src/components/navbar-layout.ts`

**Interfaces:**
- Consumes: `dockRoutes`, `overflowRoutes`, `selectedId`, `overflowOpen`, `overflowRef`, translated `moreLabel`, `onSelect(id)`, and `onOverflowOpenChange(open)`.
- Produces: `NavbarDock`, semantic primary navigation with selected-route state and a controlled overflow menu.

- [ ] **Step 1: Write failing server-rendered markup tests**

```tsx
import { describe, expect, test } from "bun:test";
import type { Route } from "@/types/router";
import { renderToStaticMarkup } from "react-dom/server";
import { NavbarDock } from "./navbar-dock";

const route = (id: string): Route => ({ id, title: id, icon: <span>{id[0]}</span>, component: null });

describe("NavbarDock", () => {
  test("marks a direct route as current and omits More without overflow", () => {
    const markup = renderToStaticMarkup(<NavbarDock dockRoutes={[route("profiles")]} overflowRoutes={[]} selectedId="profiles" overflowOpen={false} overflowRef={{ current: null }} moreLabel="More" translate={(key) => key} onSelect={() => {}} onOverflowOpenChange={() => {}} />);
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  test("marks More selected and exposes selected overflow item", () => {
    const markup = renderToStaticMarkup(<NavbarDock dockRoutes={[route("profiles")]} overflowRoutes={[route("settings")]} selectedId="settings" overflowOpen overflowRef={{ current: null }} moreLabel="More" translate={(key) => key} onSelect={() => {}} onOverflowOpenChange={() => {}} />);
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="menu"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("settings");
  });
});
```

- [ ] **Step 2: Run the component test and confirm RED**

Run: `bun test src/components/navbar-dock.test.tsx`

Expected: FAIL because `NavbarDock` does not exist.

- [ ] **Step 3: Implement the controlled component and layout tokens**

```tsx
import { navbarLayout } from "@/components/navbar-layout";
import type { Route } from "@/types/router";
import type { RefObject } from "react";
import { FaEllipsis } from "react-icons/fa6";

type NavbarDockProps = {
  dockRoutes: Route[];
  overflowRoutes: Route[];
  selectedId: string;
  overflowOpen: boolean;
  overflowRef: RefObject<HTMLDivElement | null>;
  moreLabel: string;
  translate: (key: string) => string;
  onSelect: (id: string) => void;
  onOverflowOpenChange: (open: boolean) => void;
};

export const NavbarDock = ({ dockRoutes, overflowRoutes, selectedId, overflowOpen, overflowRef, moreLabel, translate, onSelect, onOverflowOpenChange }: NavbarDockProps) => {
  if (dockRoutes.length === 0) return null;
  const overflowSelected = overflowRoutes.some(({ id }) => id === selectedId);
  const tabClass = (active: boolean) => `${navbarLayout.dockTab} ${active ? navbarLayout.dockTabActive : navbarLayout.dockTabInactive}`;

  return (
    <nav className={navbarLayout.dock} aria-label="Primary navigation">
      {dockRoutes.map((route) => (
        <button key={route.id} type="button" className={tabClass(route.id === selectedId)} aria-current={route.id === selectedId ? "page" : undefined} onClick={() => onSelect(route.id)}>
          {route.icon}<span>{translate(route.title)}</span>
        </button>
      ))}
      {overflowRoutes.length > 0 && (
        <div ref={overflowRef} className="relative">
          <button type="button" className={tabClass(overflowSelected)} aria-current={overflowSelected ? "page" : undefined} aria-haspopup="menu" aria-expanded={overflowOpen} onClick={() => onOverflowOpenChange(!overflowOpen)}>
            <FaEllipsis aria-hidden="true" /><span>{moreLabel}</span>
          </button>
          {overflowOpen && (
            <div className={navbarLayout.overflowMenu} role="menu">
              {overflowRoutes.map((route) => (
                <button key={route.id} type="button" role="menuitem" aria-current={route.id === selectedId ? "page" : undefined} className={`${navbarLayout.overflowItem} ${route.id === selectedId ? navbarLayout.overflowItemActive : ""}`} onClick={() => onSelect(route.id)}>
                  {route.icon}<span>{translate(route.title)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
};
```

Replace `navbar-layout.ts` with:

```ts
export const navbarLayout = {
  root: "relative z-40 shrink-0 border-b border-white/10 bg-[#0b1016]/95 backdrop-blur-xl",
  utilityRow: "flex h-12 items-center justify-between gap-4 px-4",
  wordmark: "flex items-center gap-2 font-[Rajdhani] text-sm font-bold tracking-[0.16em] text-white",
  wordmarkBadge: "grid h-7 w-7 place-items-center bg-[#ff4655] text-xs font-extrabold text-white [clip-path:polygon(0_0,100%_0,86%_78%,50%_100%,14%_78%)]",
  dockViewport: "nav-tabs-scroll overflow-x-auto px-4 pb-3",
  dock: "relative mx-auto flex w-max min-w-max items-center gap-1 rounded-xl border border-white/10 bg-[#18222b] p-1 shadow-xl shadow-black/25",
  dockTab: "navbar-motion flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium outline-none transition-[color,background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-cyan-400 active:bg-white/10",
  dockTabActive: "bg-[#ff4655] text-white shadow-lg shadow-[#ff4655]/20",
  dockTabInactive: "text-gray-400 hover:bg-white/5 hover:text-white",
  status: "relative shrink-0 flex items-center",
  overflowMenu: "absolute right-0 top-full z-50 mt-2 w-48 rounded-lg border border-white/10 bg-[#111820] p-1.5 shadow-2xl",
  overflowItem: "flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-gray-300 outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-cyan-400",
  overflowItemActive: "bg-white/8 text-white",
  statusMenu: "absolute right-0 top-11 z-50 w-60 max-w-[calc(100vw-1rem)] rounded-lg border border-white/10 bg-[#111318] p-1.5 shadow-2xl",
  statusMessage: "mt-1 whitespace-normal break-words border-t border-white/10 px-2.5 pt-2 text-[11px] leading-4",
} as const;
```

- [ ] **Step 4: Run the component and route tests and confirm GREEN**

Run: `bun test src/components/navbar-dock.test.tsx src/util/navbar-routes.test.ts`

Expected: 5 tests pass.

- [ ] **Step 5: Commit the dock component**

```bash
git add src/components/navbar-dock.tsx src/components/navbar-dock.test.tsx src/components/navbar-layout.ts
git commit -m "feat: add floating navbar dock"
```

### Task 3: Router integration, localization, and dismissal behavior

**Files:**
- Modify: `src/components/router.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `NavbarDock`, `splitNavbarRoutes`, `isOverflowRouteSelected`, the existing router context, and `RiotStatusBar`.
- Produces: the complete two-row header and unchanged page selection/analytics behavior.

- [ ] **Step 1: Add a failing dismissal-policy test to `navbar-routes.test.ts`**

```ts
import { shouldDismissNavbarOverflow } from "./navbar-routes";

test("dismisses overflow only for Escape", () => {
  expect(shouldDismissNavbarOverflow("Escape")).toBe(true);
  expect(shouldDismissNavbarOverflow("Enter")).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test src/util/navbar-routes.test.ts`

Expected: FAIL because `shouldDismissNavbarOverflow` is not exported.

- [ ] **Step 3: Add the minimal dismissal helper**

```ts
export const shouldDismissNavbarOverflow = (key: string) => key === "Escape";
```

- [ ] **Step 4: Integrate the dock into `Router`**

Remove the HeroUI `Tabs` and `Key` imports. Import `NavbarDock`, the three navbar helpers, and `useRef`. Inside `Router`, add:

```tsx
const [overflowOpen, setOverflowOpen] = useState(false);
const overflowRef = useRef<HTMLDivElement>(null);
const { dockRoutes, overflowRoutes } = splitNavbarRoutes(routes);

const selectRoute = (routeId: string) => {
  goTo(routeId);
  setOverflowOpen(false);
  window.Main.send("analytics:track", "tab_change", JSON.stringify({ tab: routeId }));
};

useEffect(() => {
  if (!overflowOpen) return;
  const closeOutside = (event: PointerEvent) => {
    if (!overflowRef.current?.contains(event.target as Node)) setOverflowOpen(false);
  };
  const closeOnEscape = (event: KeyboardEvent) => {
    if (shouldDismissNavbarOverflow(event.key)) setOverflowOpen(false);
  };
  document.addEventListener("pointerdown", closeOutside);
  document.addEventListener("keydown", closeOnEscape);
  return () => {
    document.removeEventListener("pointerdown", closeOutside);
    document.removeEventListener("keydown", closeOnEscape);
  };
}, [overflowOpen]);
```

Replace the old tab header markup with:

```tsx
<header className={navbarLayout.root}>
  <div className={navbarLayout.utilityRow}>
    <div className={navbarLayout.wordmark} aria-label="ValoUtils">
      <span className={navbarLayout.wordmarkBadge} aria-hidden="true">V</span>
      <span>VALOUTILS</span>
    </div>
    <div className={navbarLayout.status}><RiotStatusBar /></div>
  </div>
  <div className={navbarLayout.dockViewport}>
    <NavbarDock dockRoutes={dockRoutes} overflowRoutes={overflowRoutes} selectedId={selectedId} overflowOpen={overflowOpen} overflowRef={overflowRef} moreLabel={t("nav.more")} translate={t} onSelect={selectRoute} onOverflowOpenChange={setOverflowOpen} />
  </div>
</header>
```

Add `"more": "More"`, `"more": "더보기"`, and `"more": "更多"` to the existing `nav` objects in English, Korean, and Traditional Chinese. Add this rule to `index.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .navbar-motion {
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 5: Run focused tests and the frontend checks**

Run: `bun test src/util/navbar-routes.test.ts src/components/navbar-dock.test.tsx src/util/navigation-tabs.test.ts`

Expected: all focused tests pass.

Run: `bun run lint`

Expected: Oxlint exits 0 with no errors.

Run: `bun run build:vite`

Expected: TypeScript and Vite production build exit 0.

- [ ] **Step 6: Manually inspect the supported shell sizes**

Run: `bun run dev:vite`

Inspect 760x560 and 1000x720. Confirm the utility row and dock do not overlap, route labels remain readable or scroll inside the dock, the overflow menu opens above page content, outside click and Escape close it, selected overflow routes highlight `More`, the Riot status menu still opens, keyboard focus is visible, and reduced-motion removes nonessential transitions.

- [ ] **Step 7: Commit the integration**

```bash
git add src/components/router.tsx src/util/navbar-routes.ts src/util/navbar-routes.test.ts src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json src/index.css
git commit -m "feat: restyle navbar as floating dock"
```
