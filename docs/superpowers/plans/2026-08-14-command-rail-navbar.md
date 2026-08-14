# Compact Command Rail Navbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the floating top navbar with a permanently compact, icon-only left command rail.

**Architecture:** Keep route visibility and navigation state in `Router`, but partition visible routes into direct, overflow, and pinned Settings groups with a pure helper. A focused `NavbarRail` component renders the fixed-width rail and portaled overflow menu; `RiotStatusBar` supplies a compact trigger while preserving its current data and menu behavior.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, React Icons, Bun test, Tauri 2.

## Global Constraints

- The rail never expands.
- Render the first six visible non-Settings routes directly.
- Settings remains pinned near the bottom.
- Tooltips appear to the right on pointer hover and keyboard focus without changing layout.
- Preserve `goTo`, `tab_change` analytics, hidden-tab filtering, Riot status polling, and presence controls.
- Preserve the overflow menu's Arrow Up/Down, Home/End, Escape, selection, and Tab handoff behavior.

---

### Task 1: Partition Routes for the Rail

**Files:**
- Modify: `src/util/navbar-routes.ts`
- Modify: `src/util/navbar-routes.test.ts`

**Interfaces:**
- Consumes: `Route[]`, direct-route limit, and optional Settings route id.
- Produces: `partitionNavbarRoutes(routes, limit?, settingsId?)` returning `{ directRoutes, overflowRoutes, settingsRoute }`.

- [ ] **Step 1: Write failing partition tests**

```ts
test("pins Settings and keeps the first six non-Settings routes direct", () => {
  const result = partitionNavbarRoutes(routes, 6);
  expect(result.directRoutes.map(({ id }) => id)).toEqual([
    "profiles", "career", "matches", "live", "friends", "chat",
  ]);
  expect(result.overflowRoutes.map(({ id }) => id)).toEqual(["replays", "about"]);
  expect(result.settingsRoute?.id).toBe("settings");
});

test("handles missing Settings and empty routes", () => {
  expect(partitionNavbarRoutes([route("profiles")])).toEqual({
    directRoutes: [route("profiles")], overflowRoutes: [], settingsRoute: undefined,
  });
  expect(partitionNavbarRoutes([])).toEqual({
    directRoutes: [], overflowRoutes: [], settingsRoute: undefined,
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test src/util/navbar-routes.test.ts`

Expected: FAIL because `partitionNavbarRoutes` is not exported.

- [ ] **Step 3: Implement the pure partition helper**

```ts
export const partitionNavbarRoutes = (
  routes: Route[],
  limit = 6,
  settingsId = "settings",
) => {
  const settingsRoute = routes.find(({ id }) => id === settingsId);
  const navigationRoutes = routes.filter(({ id }) => id !== settingsId);
  return {
    directRoutes: navigationRoutes.slice(0, limit),
    overflowRoutes: navigationRoutes.slice(limit),
    settingsRoute,
  };
};
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `bun test src/util/navbar-routes.test.ts`

Expected: all navbar route tests pass.

- [ ] **Step 5: Commit the route model**

```powershell
git add src/util/navbar-routes.ts src/util/navbar-routes.test.ts
git commit -m "refactor: partition routes for command rail"
```

### Task 2: Build the Permanent Compact Rail

**Files:**
- Create: `src/components/navbar-rail.tsx`
- Create: `src/components/navbar-rail.test.tsx`
- Modify: `src/components/navbar-layout.ts`

**Interfaces:**
- Consumes: `directRoutes`, `overflowRoutes`, `settingsRoute`, `selectedId`, controlled overflow state/refs, translated labels, and selection callbacks.
- Produces: `NavbarRail` plus exported menu focus/position helpers.

- [ ] **Step 1: Write failing component and helper tests**

```tsx
test("renders an icon-only fixed-width rail with accessible route names", () => {
  const markup = renderToStaticMarkup(renderRail({ directRoutes: [route("profiles")] }));
  expect(markup).toContain('data-command-rail="compact"');
  expect(markup).toContain('aria-label="profiles"');
  expect(markup).toContain('data-tooltip="profiles"');
  expect(markup).not.toContain(">profiles</span></button>");
});

test("keeps Settings direct and marks only the exact route current", () => {
  const markup = renderToStaticMarkup(renderRail({
    directRoutes: [route("profiles")],
    overflowRoutes: [route("about")],
    settingsRoute: route("settings"),
    selectedId: "about",
    overflowOpen: true,
  }));
  expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  expect(markup).toMatch(/role="menuitem" aria-current="page"/);
  expect(markup).toContain('aria-label="settings"');
});

test("positions the menu to the right of the trigger", () => {
  expect(getOverflowMenuPosition({ top: 80, right: 64 }, 560)).toEqual({ top: 80, left: 72 });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test src/components/navbar-rail.test.tsx`

Expected: FAIL because `navbar-rail.tsx` does not exist.

- [ ] **Step 3: Implement the compact rail and right-side portaled menu**

```tsx
const RailButton = ({ route, active, translate, onSelect }: RailButtonProps) => {
  const label = translate(route.title);
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      data-tooltip={label}
      className={`${navbarLayout.railButton} ${active ? navbarLayout.railButtonActive : navbarLayout.railButtonInactive}`}
      onClick={() => onSelect(route.id)}
    >
      <span aria-hidden="true">{route.icon}</span>
      <span className={navbarLayout.tooltip} role="tooltip">{label}</span>
    </button>
  );
};

<aside className={navbarLayout.rail} data-command-rail="compact">
  <div className={navbarLayout.railMark} aria-label="ValoUtils">
    <span aria-hidden="true">V</span>
  </div>
  <nav className={navbarLayout.railNav} aria-label="Primary navigation">
    {directRoutes.map((route) => (
      <RailButton
        key={route.id}
        route={route}
        active={route.id === selectedId}
        translate={translate}
        onSelect={onSelect}
      />
    ))}
  </nav>
  <div className={navbarLayout.railBottom}>
    {settingsRoute && (
      <RailButton
        route={settingsRoute}
        active={settingsRoute.id === selectedId}
        translate={translate}
        onSelect={onSelect}
      />
    )}
    {statusControl}
  </div>
</aside>
```

Use fixed `w-16 min-w-16 max-w-16` rail tokens, `group`-based opacity/transform tooltip tokens, and `fixed z-50` menu tokens. Copy the proven focus logic from `NavbarDock`, changing only the geometry to `{ top: anchor.top, left: anchor.right + 8 }` with vertical viewport clamping.

- [ ] **Step 4: Run focused component tests and confirm GREEN**

Run: `bun test src/components/navbar-rail.test.tsx`

Expected: rail markup, exact current-route semantics, menu geometry, cyclic key navigation, and Tab handoff helpers all pass.

- [ ] **Step 5: Commit the compact rail**

```powershell
git add src/components/navbar-rail.tsx src/components/navbar-rail.test.tsx src/components/navbar-layout.ts
git commit -m "feat: add compact command rail"
```

### Task 3: Add the Compact Riot Account Trigger

**Files:**
- Modify: `src/components/riot-status-bar.tsx`
- Create: `src/components/riot-status-bar.test.tsx`
- Modify: `src/components/navbar-layout.ts`

**Interfaces:**
- Consumes: optional `compact?: boolean` prop.
- Produces: the existing full trigger by default and a square icon-only trigger for the rail.

- [ ] **Step 1: Write the failing compact-trigger test**

```tsx
test("compact mode keeps the account name accessible without visible text", () => {
  const markup = renderToStaticMarkup(<RiotStatusBar compact />);
  expect(markup).toContain('data-status-layout="compact"');
  expect(markup).toContain('aria-label="Connecting"');
  expect(markup).not.toContain('max-w-28 truncate');
});
```

Provide minimal translation and `window.Main` stubs in the test module so server rendering exercises real component markup.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test src/components/riot-status-bar.test.tsx`

Expected: FAIL because `compact` is not a valid prop and compact markup is absent.

- [ ] **Step 3: Implement compact mode without changing status behavior**

```tsx
type RiotStatusBarProps = { compact?: boolean };

type RiotStatusBarProps = { compact?: boolean };

const RiotStatusBar = ({ compact = false }: RiotStatusBarProps) => {
  // Keep the current state, polling effects, actions, translated labels, and menu JSX.
  return (
    <div
      ref={menuRef}
      className="relative select-none whitespace-nowrap"
      data-status-layout={compact ? "compact" : "full"}
    >
      <button
        type="button"
        aria-label={compact ? accountLabel : undefined}
        title={accountLabel}
        className={compact ? navbarLayout.statusTriggerCompact : navbarLayout.statusTrigger}
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <span className={`shrink-0 rounded-full ${compact ? "h-3 w-3" : "h-2 w-2"} ${dot[info.status]}`} />
        {!compact && (
          <>
            <span className="max-w-28 truncate xl:max-w-40">{accountLabel}</span>
            <span className={`grid h-6 w-6 shrink-0 place-items-center text-xs ${presence ? presenceColor[presence.mode] : "text-gray-600"}`}>
              {presence ? presenceIcon[presence.mode] : <FaUserSlash />}
            </span>
            <FaChevronDown className={`h-2.5 w-2.5 shrink-0 text-gray-600 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
          </>
        )}
      </button>
      {menuOpen && (
        <div className={compact ? navbarLayout.statusMenuCompact : navbarLayout.statusMenu} role="menu">
          {/* Retain the current account, settings, presence, relay, and warning menu children here unchanged. */}
        </div>
      )}
    </div>
  );
};
```

Anchor the compact menu with `left-full bottom-0 ml-2`; retain the existing top-right anchor for full mode.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `bun test src/components/riot-status-bar.test.tsx`

Expected: compact markup test passes without altering the current status-menu content.

- [ ] **Step 5: Commit compact Riot status**

```powershell
git add src/components/riot-status-bar.tsx src/components/riot-status-bar.test.tsx src/components/navbar-layout.ts
git commit -m "feat: compact riot status for command rail"
```

### Task 4: Integrate the Rail and Remove the Dock

**Files:**
- Modify: `src/components/router.tsx`
- Delete: `src/components/navbar-dock.tsx`
- Delete: `src/components/navbar-dock.test.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `partitionNavbarRoutes(routes)` and `NavbarRail`.
- Produces: a full-height row layout with unchanged route selection and analytics behavior.

- [ ] **Step 1: Add a failing source-level integration assertion**

Add to `src/components/navbar-rail.test.tsx`:

```tsx
test("rail layout tokens are permanently fixed-width", () => {
  expect(navbarLayout.rail).toContain("w-16");
  expect(navbarLayout.rail).toContain("min-w-16");
  expect(navbarLayout.rail).toContain("max-w-16");
  expect(navbarLayout.rail).not.toContain("hover:w-");
  expect(navbarLayout.rail).not.toContain("group-hover:w-");
});
```

- [ ] **Step 2: Run the assertion and confirm RED**

Run: `bun test src/components/navbar-rail.test.tsx`

Expected: FAIL until final rail layout tokens exist.

- [ ] **Step 3: Wire the rail into Router and remove dock-only code**

```tsx
const { directRoutes, overflowRoutes, settingsRoute } = partitionNavbarRoutes(routes);

return (
  <div className="flex h-full min-h-0 w-full overflow-hidden">
    <NavbarRail
      directRoutes={directRoutes}
      overflowRoutes={overflowRoutes}
      settingsRoute={settingsRoute}
      selectedId={selectedId}
      overflowOpen={overflowOpen}
      overflowRef={overflowRef}
      overflowMenuRef={overflowMenuRef}
      moreLabel={t("nav.more")}
      translate={t}
      onSelect={selectRoute}
      onOverflowOpenChange={setOverflowOpen}
      statusControl={<RiotStatusBar compact />}
    />
    <main className="min-w-0 flex-1 overflow-y-auto">{body}</main>
  </div>
);
```

Delete `NavbarDock`, its test, its imports, and dock-only layout tokens. Keep the reduced-motion `.navbar-motion` rule and apply that class to rail buttons/tooltips.

- [ ] **Step 4: Run frontend tests and confirm GREEN**

Run: `bun test src`

Expected: all frontend tests pass; no test references `NavbarDock` or `splitNavbarRoutes`.

- [ ] **Step 5: Commit integration**

```powershell
git add src/components/router.tsx src/components/navbar-rail.tsx src/components/navbar-rail.test.tsx src/components/navbar-layout.ts src/index.css src/util/navbar-routes.ts src/util/navbar-routes.test.ts
git add -u src/components/navbar-dock.tsx src/components/navbar-dock.test.tsx
git commit -m "feat: replace navbar dock with command rail"
```

### Task 5: Verify the Complete Change

**Files:**
- Verify only; update implementation files only if a verification failure is reproduced by a new failing test.

**Interfaces:**
- Consumes: the completed command rail.
- Produces: evidence that tests, lint, TypeScript/Vite, Rust, and patch hygiene pass.

- [ ] **Step 1: Run all frontend tests**

Run: `bun test src`

Expected: 0 failures.

- [ ] **Step 2: Run lint**

Run: `bun run lint`

Expected: exit code 0.

- [ ] **Step 3: Run the production frontend build**

Run: `bun run build:vite`

Expected: exit code 0; existing chunk-size warnings are acceptable.

- [ ] **Step 4: Check the Tauri backend**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: exit code 0.

- [ ] **Step 5: Check patch hygiene and scope**

Run: `git diff --check` and `git status --short`

Expected: no whitespace errors; only planned command-rail files are changed and `.codex/` remains untracked and untouched.

- [ ] **Step 6: Commit any verification-only corrections**

```powershell
git add src
git commit -m "fix: polish command rail verification issues"
```

Skip this commit when verification required no corrections.
