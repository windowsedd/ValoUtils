import { describe, expect, test } from "bun:test";
import type { Route } from "@/types/router";
import { partitionNavbarRoutes } from "./navbar-routes";

const route = (id: string): Route => ({ id, title: `nav.${id}`, component: null });
const routes = [
  "profiles",
  "career",
  "matches",
  "live",
  "friends",
  "chat",
  "settings",
  "about",
  "fake-player",
].map(route);

describe("command rail route groups", () => {
  test("pins Settings and keeps every non-Settings route direct", () => {
    const result = partitionNavbarRoutes(routes);
    expect(result.directRoutes.map(({ id }) => id)).toEqual([
      "profiles",
      "career",
      "matches",
      "live",
      "friends",
      "chat",
      "about",
      "fake-player",
    ]);
    expect(result).not.toHaveProperty("overflowRoutes");
    expect(result.settingsRoute?.id).toBe("settings");
  });

  test("promotes remaining visible routes and handles no Settings route", () => {
    const visible = [route("chat"), route("about")];
    expect(partitionNavbarRoutes(visible)).toEqual({
      directRoutes: visible,
      settingsRoute: undefined,
    });
  });

  test("handles empty routes", () => {
    expect(partitionNavbarRoutes([])).toEqual({
      directRoutes: [],
      settingsRoute: undefined,
    });
  });
});
