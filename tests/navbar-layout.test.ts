import { describe, expect, test } from "bun:test";
import { navbarLayout } from "../src/components/navbar-layout";

describe("navbarLayout", () => {
	test("allows the status dropdown to extend below the navbar", () => {
		expect(navbarLayout.root).not.toContain("overflow-hidden");
	});

	test("keeps account controls visible while tabs scroll horizontally", () => {
		expect(navbarLayout.tabsViewport).toContain("min-w-0");
		expect(navbarLayout.tabsViewport).toContain("overflow-x-auto");
		expect(navbarLayout.status).toContain("shrink-0");
	});

	test("uses compact tab spacing", () => {
		expect(navbarLayout.tabsList).toContain("gap-3");
		expect(navbarLayout.tab).toContain("whitespace-nowrap");
	});

	test("contains status menu content within the viewport", () => {
		const layout = navbarLayout as Record<string, string>;
		expect(layout.statusMenu ?? "").toContain("max-w-[calc(100vw-1rem)]");
		expect(layout.statusMessage ?? "").toContain("whitespace-normal");
		expect(layout.statusMessage ?? "").toContain("break-words");
	});
});
