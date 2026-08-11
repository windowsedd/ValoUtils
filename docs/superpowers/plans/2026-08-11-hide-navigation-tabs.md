# Hide Navigation Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent switches that let users hide every main navigation tab except Settings.

**Architecture:** Store hidden route ids as a `hiddenTabs` string array in the existing Tauri config store. Keep normalization, filtering, toggle updates, and selected-route fallback in a pure TypeScript module; `RouterProvider` consumes those helpers and exposes both visible and complete route lists, while Settings renders controls from the complete list.

**Tech Stack:** Tauri 2, Rust, React 19, TypeScript 6, Bun tests, i18next, HeroUI/Tailwind CSS

## Global Constraints

- `settings` must remain visible under every stored config value.
- Every other configured route receives its own hide switch.
- All tabs remain visible by default.
- Changes apply without restarting the app.
- Restored tabs return to their original order.
- Hidden tabs keep their backend features and data intact.
- Do not add tab reordering or global show-all/hide-all controls.
- Preserve unrelated modifications in the existing dirty worktree.

---

### Task 1: Navigation Preference Model

**Files:**
- Create: `src/util/navigation-tabs.ts`
- Create: `src/util/navigation-tabs.test.ts`

**Interfaces:**
- Consumes: `Route` from `src/types/router.ts`
- Produces: `normalizeHiddenTabs(value: unknown): string[]`
- Produces: `filterVisibleRoutes(routes: Route[], hiddenTabs: readonly string[]): Route[]`
- Produces: `setTabHidden(hiddenTabs: readonly string[], routeId: string, hidden: boolean): string[]`
- Produces: `resolveSelectedRouteId(routes: Route[], selectedId: string): string`

- [ ] **Step 1: Write the failing unit tests**

Create `src/util/navigation-tabs.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Route } from "@/types/router";
import {
  filterVisibleRoutes,
  normalizeHiddenTabs,
  resolveSelectedRouteId,
  setTabHidden,
} from "./navigation-tabs";

const route = (id: string): Route => ({ id, title: `nav.${id}`, component: null });
const routes = [route("profiles"), route("replays"), route("settings"), route("about")];

describe("navigation tab preferences", () => {
  test("normalizes config to unique string route ids", () => {
    expect(normalizeHiddenTabs(["replays", 7, "about", "replays", null])).toEqual([
      "replays",
      "about",
    ]);
    expect(normalizeHiddenTabs(null)).toEqual([]);
  });

  test("filters requested routes but always retains Settings", () => {
    expect(filterVisibleRoutes(routes, ["profiles", "settings", "missing"]).map(({ id }) => id))
      .toEqual(["replays", "settings", "about"]);
  });

  test("adds and removes ids without duplicates", () => {
    expect(setTabHidden(["replays"], "about", true)).toEqual(["replays", "about"]);
    expect(setTabHidden(["replays"], "replays", true)).toEqual(["replays"]);
    expect(setTabHidden(["replays", "about"], "replays", false)).toEqual(["about"]);
    expect(setTabHidden([], "settings", true)).toEqual([]);
  });

  test("keeps a selected route id or falls back to the first visible route", () => {
    expect(resolveSelectedRouteId(routes, "settings")).toBe("settings");
    expect(resolveSelectedRouteId(routes, "missing")).toBe("profiles");
    expect(resolveSelectedRouteId([], "profiles")).toBe("");
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
bun test src/util/navigation-tabs.test.ts
```

Expected: FAIL because `src/util/navigation-tabs.ts` does not exist.

- [ ] **Step 3: Implement the pure preference model**

Create `src/util/navigation-tabs.ts`:

```ts
import type { Route } from "@/types/router";

export const normalizeHiddenTabs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string"))];
};

export const filterVisibleRoutes = (
  routes: Route[],
  hiddenTabs: readonly string[],
): Route[] => {
  const hidden = new Set(hiddenTabs);
  return routes.filter((route) => route.id === "settings" || !hidden.has(route.id));
};

export const setTabHidden = (
  hiddenTabs: readonly string[],
  routeId: string,
  hidden: boolean,
): string[] => {
  if (routeId === "settings") return [...hiddenTabs];
  if (hidden) return [...new Set([...hiddenTabs, routeId])];
  return hiddenTabs.filter((id) => id !== routeId);
};

export const resolveSelectedRouteId = (routes: Route[], selectedId: string): string =>
  routes.some((route) => route.id === selectedId) ? selectedId : (routes[0]?.id ?? "");
```

- [ ] **Step 4: Run the unit tests and confirm GREEN**

Run:

```bash
bun test src/util/navigation-tabs.test.ts
```

Expected: 4 tests pass and 0 fail.

- [ ] **Step 5: Commit the model**

```bash
git add src/util/navigation-tabs.ts src/util/navigation-tabs.test.ts
git commit -m "feat: add navigation tab preferences"
```

---

### Task 2: Persist Hidden Tab IDs

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/app.rs`
- Create: `tests/navigation-tabs-config.test.ts`

**Interfaces:**
- Consumes: existing `ConfigStore`, `config:get-all`, and `config:set`
- Produces: `hiddenTabs` JSON array in the config defaults and `config_get_all` response

- [ ] **Step 1: Write the failing backend wiring test**

Create `tests/navigation-tabs-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const appCommand = readFileSync(join(root, "src-tauri/src/commands/app.rs"), "utf8");
const tauriApp = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");

describe("hidden navigation config", () => {
  test("defaults hiddenTabs to an empty array", () => {
    expect(tauriApp).toContain('config_defaults.insert("hiddenTabs".into(), json!([]));');
  });

  test("returns hiddenTabs from config_get_all", () => {
    expect(appCommand).toContain('"hiddenTabs": get_or("hiddenTabs", json!([]))');
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
bun test tests/navigation-tabs-config.test.ts
```

Expected: 2 tests fail because neither Rust file contains `hiddenTabs`.

- [ ] **Step 3: Add the config default and allowlist entry**

In `src-tauri/src/lib.rs`, add beside the other `config_defaults` entries:

```rust
config_defaults.insert("hiddenTabs".into(), json!([]));
```

In the JSON object returned by `config_get_all` in `src-tauri/src/commands/app.rs`, add:

```rust
"hiddenTabs": get_or("hiddenTabs", json!([])),
```

The existing `config_set` command already accepts arbitrary JSON values, so it needs no change.

- [ ] **Step 4: Run the focused test and Rust type check**

Run:

```bash
bun test tests/navigation-tabs-config.test.ts
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: 2 tests pass; `cargo check` exits 0.

- [ ] **Step 5: Commit config persistence**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/app.rs tests/navigation-tabs-config.test.ts
git commit -m "feat: persist hidden navigation tabs"
```

---

### Task 3: Make Router Visibility Dynamic

**Files:**
- Modify: `src/components/router.tsx`
- Create: `tests/navigation-tabs-router.test.ts`

**Interfaces:**
- Consumes: all four helpers from `src/util/navigation-tabs.ts`
- Consumes: `CustomEvent<{ key: string; value: unknown }>` named `valoutils:config-changed`
- Produces: `useConfiguredRoutes(): Route[]`, returning the complete unfiltered route list
- Produces: a Router context whose `routes` value contains visible routes only

- [ ] **Step 1: Write the failing router wiring tests**

Create `tests/navigation-tabs-router.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const router = readFileSync(
  join(import.meta.dir, "..", "src/components/router.tsx"),
  "utf8",
);

describe("dynamic navigation routes", () => {
  test("provider loads and filters hidden tabs", () => {
    expect(router).toContain('window.Main.on("config:get-all", onConfigLoaded)');
    expect(router).toContain("filterVisibleRoutes(allRoutes, hiddenTabs)");
    expect(router).toContain('window.addEventListener("valoutils:config-changed", onConfigChanged)');
  });

  test("exposes complete routes for Settings controls", () => {
    expect(router).toContain("export const useConfiguredRoutes");
    expect(router).toContain("allRoutes");
  });

  test("selection resolves by route id", () => {
    expect(router).toContain("resolveSelectedRouteId(routerContext.routes, selectedId)");
    expect(router).not.toContain("routerContext.routes[selected]");
  });
});
```

- [ ] **Step 2: Run the router test and confirm RED**

Run:

```bash
bun test tests/navigation-tabs-router.test.ts
```

Expected: 3 tests fail because the router has no config-driven filtering or complete-route hook.

- [ ] **Step 3: Extend the route context and provider**

In `src/components/router.tsx`, import `useMemo` and the navigation helpers, then replace the context shape and provider with:

```tsx
type RouterContextValue = {
  routes: Route[];
  allRoutes: Route[];
};

const RouterContext = createContext<RouterContextValue>({ routes: [], allRoutes: [] });

export const useConfiguredRoutes = () => useContext(RouterContext).allRoutes;

const RouterProvider: React.FC<RouterProps & { children: React.ReactNode | React.ReactNode[] }> = ({
  routes: allRoutes,
  children,
}) => {
  const [hiddenTabs, setHiddenTabs] = useState<string[]>([]);

  useEffect(() => {
    const onConfigLoaded = (message: string) => {
      window.Main.removeListener("config:get-all", onConfigLoaded);
      try {
        setHiddenTabs(normalizeHiddenTabs(JSON.parse(message)?.hiddenTabs));
      } catch {
        setHiddenTabs([]);
      }
    };
    window.Main.on("config:get-all", onConfigLoaded);
    window.Main.send("config:get-all");
    return () => window.Main.removeListener("config:get-all", onConfigLoaded);
  }, []);

  useEffect(() => {
    const onConfigChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
      if (detail?.key === "hiddenTabs") setHiddenTabs(normalizeHiddenTabs(detail.value));
    };
    window.addEventListener("valoutils:config-changed", onConfigChanged);
    return () => window.removeEventListener("valoutils:config-changed", onConfigChanged);
  }, []);

  const routes = useMemo(
    () => filterVisibleRoutes(allRoutes, hiddenTabs),
    [allRoutes, hiddenTabs],
  );

  return (
    <RouterContext.Provider value={{ routes, allRoutes }}>
      {children}
    </RouterContext.Provider>
  );
};
```

Add these imports:

```tsx
import React, { createContext, Key, useContext, useEffect, useMemo, useState } from "react";
import {
  filterVisibleRoutes,
  normalizeHiddenTabs,
  resolveSelectedRouteId,
} from "@/util/navigation-tabs";
```

- [ ] **Step 4: Track selection by route id**

Replace the numeric `selected` state and body effect in `useRouter` with:

```tsx
const [selectedId, setSelectedId] = useState(routerContext.routes[0]?.id ?? "");
const resolvedSelectedId = resolveSelectedRouteId(routerContext.routes, selectedId);
const body = routerContext.routes.find((route) => route.id === resolvedSelectedId)?.component;

useEffect(() => {
  if (resolvedSelectedId !== selectedId) setSelectedId(resolvedSelectedId);
}, [resolvedSelectedId, selectedId]);
```

Keep `goTo` as an id lookup that calls `setSelectedId(id)`. Replace `goToIndex` with:

```tsx
const goToIndex = (index: number) => {
  const route = routerContext.routes[index];
  if (route) {
    setSelectedId(route.id);
  } else {
    console.error(`Route with index "${index}" not found.`);
  }
};
```

Return `selectedId: resolvedSelectedId` from `useRouter`.

- [ ] **Step 5: Run router and model tests**

Run:

```bash
bun test src/util/navigation-tabs.test.ts tests/navigation-tabs-router.test.ts
```

Expected: 7 tests pass and 0 fail.

- [ ] **Step 6: Commit dynamic routing**

```bash
git add src/components/router.tsx tests/navigation-tabs-router.test.ts
git commit -m "feat: filter hidden navigation routes"
```

---

### Task 4: Add Navigation Tab Settings and Localized Copy

**Files:**
- Modify: `src/pages/Settings.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Create: `tests/navigation-tabs-settings.test.ts`

**Interfaces:**
- Consumes: `useConfiguredRoutes(): Route[]`
- Consumes: `normalizeHiddenTabs(value): string[]` and `setTabHidden(hiddenTabs, routeId, hidden): string[]`
- Produces: `AppConfig.hiddenTabs: string[]`
- Produces: `CustomEvent("valoutils:config-changed", { detail: { key, value } })`

- [ ] **Step 1: Write the failing Settings and locale test**

Create `tests/navigation-tabs-settings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const settings = readFileSync(join(root, "src/pages/Settings.tsx"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;

describe("navigation tab settings", () => {
  test("renders controls from complete routes but excludes Settings", () => {
    expect(settings).toContain("useConfiguredRoutes()");
    expect(settings).toContain('route.id !== "settings"');
    expect(settings).toContain("hiddenTabs: normalizeHiddenTabs(config.hiddenTabs)");
    expect(settings).toContain('setConfig("hiddenTabs", nextHiddenTabs)');
    expect(settings).toContain('detail: { key, value }');
  });

  for (const locale of locales) {
    test(`${locale} contains navigation visibility copy`, () => {
      const messages = JSON.parse(
        readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
      ).settings;
      expect(messages.sectionNavigation).toBeString();
      expect(messages.hideTab).toBeString();
      expect(messages.hideTabDesc).toBeString();
    });
  }
});
```

- [ ] **Step 2: Run the Settings test and confirm RED**

Run:

```bash
bun test tests/navigation-tabs-settings.test.ts
```

Expected: 4 tests fail because Settings and locale files do not contain the new controls or keys.

- [ ] **Step 3: Extend Settings state and config events**

In `src/pages/Settings.tsx`, import `useConfiguredRoutes` and `setTabHidden`:

```tsx
import { useConfiguredRoutes } from "@/components/router";
import { normalizeHiddenTabs, setTabHidden } from "@/util/navigation-tabs";
```

Add `hiddenTabs: string[]` to `AppConfig`, add `hiddenTabs: []` to the initial state, and obtain the configured routes inside `Settings`:

```tsx
const configuredRoutes = useConfiguredRoutes();
const configurableRoutes = configuredRoutes.filter((route) => route.id !== "settings");
```

Replace the `config:get-all` callback's direct `setAppConfig(JSON.parse(msg))` call so old or malformed values keep the safe default:

```tsx
const config = JSON.parse(msg) as Partial<AppConfig>;
setAppConfig((current) => ({
  ...current,
  ...config,
  hiddenTabs: normalizeHiddenTabs(config.hiddenTabs),
}));
```

Change `setConfig` to accept arrays and include event detail:

```tsx
const setConfig = (key: string, value: boolean | string | string[]) => {
  window.Main.send("config:set", key, value);
  setAppConfig((prev) => ({ ...prev, [key]: value }));
  window.dispatchEvent(
    new CustomEvent("valoutils:config-changed", { detail: { key, value } }),
  );
};
```

Add the tab update helper inside `Settings`:

```tsx
const setRouteHidden = (routeId: string, hidden: boolean) => {
  const nextHiddenTabs = setTabHidden(appConfig.hiddenTabs, routeId, hidden);
  setConfig("hiddenTabs", nextHiddenTabs);
};
```

- [ ] **Step 4: Render the Navigation Tabs section**

Add this section after the existing App section:

```tsx
<SectionCard title={t("settings.sectionNavigation")} accent="#22d3ee">
  <div className="flex flex-col px-1">
    {configurableRoutes.map((route) => (
      <SettingRow
        key={route.id}
        icon={route.icon ?? <FaEyeSlash />}
        label={t("settings.hideTab", { tab: t(route.title) })}
        description={t("settings.hideTabDesc")}
        right={
          <Toggle
            checked={appConfig.hiddenTabs.includes(route.id)}
            onChange={(hidden) => setRouteHidden(route.id, hidden)}
          />
        }
      />
    ))}
  </div>
</SectionCard>
```

- [ ] **Step 5: Add all three locale entries**

Add these keys inside the `settings` object in `src/i18n/locales/en.json`:

```json
"sectionNavigation": "Navigation Tabs",
"hideTab": "Hide {{tab}} tab",
"hideTabDesc": "Remove this tab from the main navigation"
```

Add the equivalent keys to `src/i18n/locales/ko.json`:

```json
"sectionNavigation": "탐색 탭",
"hideTab": "{{tab}} 탭 숨기기",
"hideTabDesc": "메인 탐색 메뉴에서 이 탭을 숨깁니다"
```

Add the equivalent keys to `src/i18n/locales/zh-TW.json`:

```json
"sectionNavigation": "導覽分頁",
"hideTab": "隱藏 {{tab}} 分頁",
"hideTabDesc": "從主導覽列隱藏此分頁"
```

- [ ] **Step 6: Run Settings, router, and model tests**

Run:

```bash
bun test src/util/navigation-tabs.test.ts tests/navigation-tabs-config.test.ts tests/navigation-tabs-router.test.ts tests/navigation-tabs-settings.test.ts
```

Expected: 13 tests pass and 0 fail.

- [ ] **Step 7: Commit Settings UI and translations**

```bash
git add src/pages/Settings.tsx src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json tests/navigation-tabs-settings.test.ts
git commit -m "feat: add navigation visibility settings"
```

---

### Task 5: Final Verification

**Files:**
- Verify only; no planned source changes

**Interfaces:**
- Consumes: completed Tasks 1–4
- Produces: fresh evidence that focused behavior, existing navbar behavior, typing, Rust, and production bundling remain valid

- [ ] **Step 1: Run navigation and navbar regression tests**

Run:

```bash
bun test src/util/navigation-tabs.test.ts tests/navigation-tabs-config.test.ts tests/navigation-tabs-router.test.ts tests/navigation-tabs-settings.test.ts tests/navbar-layout.test.ts
```

Expected: all tests pass and 0 fail.

- [ ] **Step 2: Run TypeScript checking and the production frontend build**

Run:

```bash
bunx tsc --noEmit
bun run build:vite
```

Expected: both commands exit 0. Existing Vite native-config and chunk-size warnings are acceptable.

- [ ] **Step 3: Run Rust checking**

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: command exits 0.

- [ ] **Step 4: Check the committed feature diff**

Run:

```bash
git diff --check HEAD~4..HEAD
git status --short
```

Expected: feature commits contain no whitespace errors. Pre-existing unrelated worktree changes remain uncommitted and untouched.
