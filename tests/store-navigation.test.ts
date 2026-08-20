import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const page = readFileSync(join(root, "src/pages/Store.tsx"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;
const requiredStoreKeys = [
	"title",
	"loading",
	"failedToLoad",
	"loginRequired",
	"loginRequiredDesc",
	"dailyOffers",
	"featuredBundle",
	"nightMarket",
	"accessoryStore",
	"hiddenCard",
	"unknownItem",
] as const;

describe("Store page and kingdom accessory shelf", () => {
	test("loads the storefront over IPC and joins valorant-api.com assets", () => {
		expect(page).toContain('send("store:get"');
		expect(page).toContain("getSkinLevel");
		expect(page).toContain("getBundle");
		expect(page).toContain("getStoreItem");
		expect(page).toContain("item.itemTypeId");
		expect(page).toContain("data?.accessory?.offers");
		expect(page).not.toContain("setSkins(new Map(entries))");
	});

	for (const locale of locales) {
		test(`${locale} localizes Store and accessory-shelf states`, () => {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			);
			expect(messages.nav.store).toBeString();
			expect(messages.nav.store.trim().length).toBeGreaterThan(0);
			for (const key of requiredStoreKeys) {
				expect(messages.store[key]).toBeString();
				expect((messages.store[key] as string).trim().length).toBeGreaterThan(0);
			}
		});
	}
});
