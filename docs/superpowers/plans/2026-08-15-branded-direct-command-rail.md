# Branded Direct Command Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rail's generated V tile with the existing ValoUtils icon and render every visible destination directly without a More menu.

**Architecture:** Simplify route partitioning to separate only Settings from all other visible routes. Simplify `NavbarRail` to a scrollable direct-route column plus pinned Settings and Riot status, and import the existing Tauri PNG through Vite so no duplicate brand asset is created.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, Bun test, Vite 8, Tauri 2.

## Global Constraints

- The rail stays permanently fixed at 64px and never expands.
- Every visible non-Settings route is direct, including About and Bot.
- Settings and Riot status stay pinned at the bottom.
- Only the middle route list may scroll vertically.
- Preserve translated labels, tooltips, reduced motion, hidden tabs, navigation analytics, Riot behavior, and backend IPC.

---

### Task 1: Simplify Route Partitioning

**Files:**
- Modify: `src/util/navbar-routes.ts`
- Modify: `src/util/navbar-routes.test.ts`

**Interfaces:**
- Consumes: `Route[]` and optional Settings route id.
- Produces: `partitionNavbarRoutes(routes, settingsId?)` returning `{ directRoutes, settingsRoute }`.

- [ ] **Step 1: Write the failing all-direct route test**

```ts
test("keeps every non-Settings route direct", () => {
  const result = partitionNavbarRoutes(routes);
  expect(result.directRoutes.map(({ id }) => id)).toEqual([
    "profiles", "career", "matches", "live", "friends", "chat", "replays", "about", "fake-player",
  ]);
  expect(result).not.toHaveProperty("overflowRoutes");
  expect(result.settingsRoute?.id).toBe("settings");
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test src/util/navbar-routes.test.ts`

Expected: FAIL because the current helper limits direct routes to six and returns overflow routes.

- [ ] **Step 3: Implement the simplified partition**

```ts
export const partitionNavbarRoutes = (routes: Route[], settingsId = "settings") => ({
  directRoutes: routes.filter(({ id }) => id !== settingsId),
  settingsRoute: routes.find(({ id }) => id === settingsId),
});
```

Delete `isOverflowRouteSelected` and `shouldDismissNavbarOverflow` because the rail no longer has overflow state.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `bun test src/util/navbar-routes.test.ts`

Expected: all command-rail route tests pass.

- [ ] **Step 5: Commit route simplification**

```powershell
git add src/util/navbar-routes.ts src/util/navbar-routes.test.ts
git commit -m "refactor: expose all command rail routes"
```

### Task 2: Brand and Simplify the Rail

**Files:**
- Modify: `src/components/navbar-rail.tsx`
- Modify: `src/components/navbar-rail.test.tsx`
- Modify: `src/components/navbar-layout.ts`
- Modify: `src/components/router.tsx`
- Modify: `src/components/router.test.tsx`
- Modify: `src/index.css`
- Read asset: `src-tauri/icons/icon.png`

**Interfaces:**
- Consumes: `directRoutes`, optional `settingsRoute`, selected id, translated labels, selection callback, and Riot status control.
- Produces: a branded fixed-width rail with a scrollable direct-route list and no overflow props or state.

- [ ] **Step 1: Write failing rail and router tests**

```tsx
test("uses the ValoUtils artwork and renders About and Bot directly", () => {
  const markup = renderRail({
    directRoutes: [route("about"), route("fake-player")],
  });
  expect(markup).toContain('data-brand-mark="valoutils-icon"');
  expect(markup).toContain('aria-label="about"');
  expect(markup).toContain('aria-label="fake-player"');
  expect(markup).not.toContain('aria-haspopup="menu"');
  expect(markup).not.toContain('aria-label="More"');
});

test("keeps only the route list scrollable", () => {
  expect(navbarLayout.railRoutes).toContain("overflow-y-auto");
  expect(navbarLayout.railRoutes).toContain("command-rail-scroll");
  expect(navbarLayout.railBottom).not.toContain("overflow");
  expect(navbarLayout.railStatus).not.toContain("overflow");
});
```

Update the router integration test to render nine non-Settings routes and assert that About and Bot appear as direct buttons with no More menu.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `bun test src/components/navbar-rail.test.tsx src/components/router.test.tsx`

Expected: FAIL because the real icon, `railRoutes` token, direct overflow routes, and simplified props do not exist yet.

- [ ] **Step 3: Implement the branded direct rail**

```tsx
import valoUtilsIcon from "../../src-tauri/icons/icon.png";

type NavbarRailProps = {
  directRoutes: Route[];
  settingsRoute?: Route;
  selectedId: string;
  translate: (key: string) => string;
  onSelect: (id: string) => void;
  statusControl: ReactNode;
};

<div className={navbarLayout.railMark} aria-label="ValoUtils">
  <img
    src={valoUtilsIcon}
    alt=""
    aria-hidden="true"
    data-brand-mark="valoutils-icon"
    className="h-10 w-10 object-contain"
  />
</div>

<nav className={navbarLayout.railNav} aria-label="Primary navigation">
  <div className={navbarLayout.railRoutes} data-rail-section="routes">
    {directRoutes.map((route) => (
      <RailRouteButton
        key={route.id}
        route={route}
        active={route.id === selectedId}
        translate={translate}
        onSelect={onSelect}
      />
    ))}
  </div>
  <div className={navbarLayout.railBottom} data-rail-section="bottom">
    {settingsRoute && (
      <RailRouteButton
        route={settingsRoute}
        active={settingsRoute.id === selectedId}
        translate={translate}
        onSelect={onSelect}
      />
    )}
  </div>
</nav>
```

Use these layout tokens:

```ts
railMark: "grid h-11 w-11 shrink-0 place-items-center",
railNav: "flex min-h-0 w-full flex-1 flex-col items-center pt-3",
railRoutes: "command-rail-scroll flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden",
railBottom: "flex shrink-0 flex-col items-center border-t border-white/10 pt-3",
```

Add scrollbar hiding without disabling scrolling:

```css
.command-rail-scroll {
  scrollbar-width: none;
}

.command-rail-scroll::-webkit-scrollbar {
  display: none;
}
```

In `Router`, remove overflow state, refs, dismissal effects, and More props, then pass only `directRoutes`, `settingsRoute`, selection props, and `<RiotStatusBar compact />`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `bun test src/components/navbar-rail.test.tsx src/components/router.test.tsx`

Expected: branded direct-rail and router tests pass.

- [ ] **Step 5: Run full verification**

Run: `bun test src`, `bun run lint`, `bun run build:vite`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `git diff --check`.

Expected: every command exits 0; existing Vite configuration and chunk-size warnings are acceptable.

- [ ] **Step 6: Commit the completed revision**

```powershell
git add src/components/navbar-rail.tsx src/components/navbar-rail.test.tsx src/components/navbar-layout.ts src/components/router.tsx src/components/router.test.tsx src/index.css
git commit -m "feat: show all routes in branded command rail"
```
