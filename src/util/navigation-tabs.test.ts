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
