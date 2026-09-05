import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const router = readFileSync(join(import.meta.dir, "..", "src/components/router.tsx"), "utf8");

describe("dynamic navigation routes", () => {
  test("provider loads and filters hidden tabs", () => {
    expect(router).toContain('window.Main.on("config:get-all", onConfigLoaded)');
    expect(router).toContain("filterVisibleRoutes(allRoutes, hiddenTabs)");
    expect(router).toContain(
      'window.addEventListener("valoutils:config-changed", onConfigChanged)',
    );
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
