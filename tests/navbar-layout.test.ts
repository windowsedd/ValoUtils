import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { navbarLayout } from "../src/components/navbar-layout";

const root = join(import.meta.dir, "..");
const statusBar = readFileSync(join(root, "src/components/riot-status-bar.tsx"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;

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

	test("uses the Riot ID as the single account and presence menu trigger", () => {
		expect(statusBar).toContain('aria-haspopup="menu"');
		expect(statusBar).toContain("info.username");
		expect(statusBar).not.toContain('className="min-w-0 w-7 h-7');
	});

	test("moves the settings eye action into the account menu", () => {
		expect(statusBar).toContain('t("riotStatus.viewSettings")');
		for (const locale of locales) {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			);
			expect(messages.riotStatus.viewSettings).toBeString();
		}
	});
});
