import { describe, expect, test } from "bun:test";
import type { Route } from "@/types/router";
import {
  isOverflowRouteSelected,
  shouldDismissNavbarOverflow,
  splitNavbarRoutes,
} from "./navbar-routes";

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

  test("dismisses overflow only for Escape", () => {
    expect(shouldDismissNavbarOverflow("Escape")).toBe(true);
    expect(shouldDismissNavbarOverflow("Enter")).toBe(false);
  });
});
