import { describe, expect, test } from "bun:test";
import type { Route } from "@/types/router";
import {
  filterVisibleRoutes,
  normalizeHiddenTabs,
  resolveSelectedRouteId,
  setTabHidden,
} from "./navigation-tabs";

const route = (id: string): Route => ({ id, title: `nav.${id}`, component: null });
const routes = [route("profiles"), route("matches"), route("settings"), route("about")];

describe("navigation tab preferences", () => {
  test("normalizes config to unique string route ids", () => {
    expect(normalizeHiddenTabs(["matches", 7, "about", "matches", null])).toEqual([
      "matches",
      "about",
    ]);
    expect(normalizeHiddenTabs(null)).toEqual([]);
  });

  test("filters requested routes but always retains Settings", () => {
    expect(
      filterVisibleRoutes(routes, ["profiles", "settings", "missing"]).map(({ id }) => id),
    ).toEqual(["matches", "settings", "about"]);
  });

  test("adds and removes ids without duplicates", () => {
    expect(setTabHidden(["matches"], "about", true)).toEqual(["matches", "about"]);
    expect(setTabHidden(["matches"], "matches", true)).toEqual(["matches"]);
    expect(setTabHidden(["matches", "about"], "matches", false)).toEqual(["about"]);
    expect(setTabHidden([], "settings", true)).toEqual([]);
  });

  test("keeps a selected route id or falls back to the first visible route", () => {
    expect(resolveSelectedRouteId(routes, "settings")).toBe("settings");
    expect(resolveSelectedRouteId(routes, "missing")).toBe("profiles");
    expect(resolveSelectedRouteId([], "profiles")).toBe("");
  });
});
