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
  "logs",
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

  test("leaves Logs off the rail until it is asked for", () => {
    expect(partitionNavbarRoutes(routes).logsRoute).toBeUndefined();
    expect(partitionNavbarRoutes(routes, "settings", true).logsRoute?.id).toBe("logs");
  });

  test("keeps Logs out of the direct stack even when shown, so it sits beside Settings", () => {
    const shown = partitionNavbarRoutes(routes, "settings", true);

    expect(shown.directRoutes.map(({ id }) => id)).not.toContain("logs");
  });

  test("promotes remaining visible routes and handles no Settings route", () => {
    const visible = [route("chat"), route("about")];
    expect(partitionNavbarRoutes(visible)).toEqual({
      directRoutes: visible,
      logsRoute: undefined,
      settingsRoute: undefined,
    });
  });

  test("handles empty routes", () => {
    expect(partitionNavbarRoutes([])).toEqual({
      directRoutes: [],
      logsRoute: undefined,
      settingsRoute: undefined,
    });
  });

  test("asking for a Logs route that is not there yields nothing", () => {
    expect(partitionNavbarRoutes([route("chat")], "settings", true).logsRoute).toBeUndefined();
  });
});
