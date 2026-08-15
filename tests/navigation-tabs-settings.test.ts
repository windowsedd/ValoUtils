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

	test("shows the live Riot chat API URL and lockfile port", () => {
		expect(settings).toContain("/chat/v6/messages");
		expect(settings).toContain("settings.chatApiLabel");
		expect(settings).toContain("clientPort");
	});

	for (const locale of locales) {
		test(`${locale} contains navigation visibility copy`, () => {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			).settings;
			expect(messages.sectionNavigation).toBeString();
			expect(messages.hideTab).toBeString();
			expect(messages.hideTabDesc).toBeString();
			expect(messages.chatApiLabel).toBeString();
		});
	}
});
