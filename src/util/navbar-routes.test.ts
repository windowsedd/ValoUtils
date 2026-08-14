import { describe, expect, test } from "bun:test";
import type { Route } from "@/types/router";
import {
  isOverflowRouteSelected,
  partitionNavbarRoutes,
  shouldDismissNavbarOverflow,
} from "./navbar-routes";

const route = (id: string): Route => ({ id, title: `nav.${id}`, component: null });
const routes = [
  "profiles",
  "career",
  "matches",
  "live",
  "friends",
  "chat",
  "replays",
  "settings",
  "about",
].map(route);

describe("command rail route groups", () => {
  test("pins Settings and keeps the first six non-Settings routes direct", () => {
    const result = partitionNavbarRoutes(routes);
    expect(result.directRoutes.map(({ id }) => id)).toEqual([
      "profiles",
      "career",
      "matches",
      "live",
      "friends",
      "chat",
    ]);
    expect(result.overflowRoutes.map(({ id }) => id)).toEqual(["replays", "about"]);
    expect(result.settingsRoute?.id).toBe("settings");
  });

  test("promotes remaining visible routes and handles no Settings route", () => {
    const visible = [route("chat"), route("about")];
    expect(partitionNavbarRoutes(visible)).toEqual({
      directRoutes: visible,
      overflowRoutes: [],
      settingsRoute: undefined,
    });
  });

  test("handles empty routes", () => {
    expect(partitionNavbarRoutes([])).toEqual({
      directRoutes: [],
      overflowRoutes: [],
      settingsRoute: undefined,
    });
  });

  test("reports when the active route lives in overflow", () => {
    const { overflowRoutes } = partitionNavbarRoutes(routes);
    expect(isOverflowRouteSelected(overflowRoutes, "about")).toBe(true);
    expect(isOverflowRouteSelected(overflowRoutes, "profiles")).toBe(false);
  });

  test("dismisses overflow only for Escape", () => {
    expect(shouldDismissNavbarOverflow("Escape")).toBe(true);
    expect(shouldDismissNavbarOverflow("Enter")).toBe(false);
  });
});
