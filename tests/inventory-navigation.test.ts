import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "src/main.tsx"), "utf8");
const tools = readFileSync(join(root, "src/pages/Tools.tsx"), "utf8");
const page = readFileSync(join(root, "src/pages/Inventory.tsx"), "utf8");
const assets = readFileSync(join(root, "src/util/valorant-assets.ts"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;
const requiredInventoryKeys = [
	"title",
	"loading",
	"failedToLoad",
	"loginRequired",
	"loginRequiredDesc",
	"totalSpend",
	"items",
	"empty",
	"search",
	"searchPlaceholder",
	"unknownItem",
	"unpriced",
	"filterAll",
	"skinList",
	"gunsKnivesValue",
	"totalValue",
	"scopePurchased",
	"breakdownValue",
	"excludedRarity",
	"topUp",
	"rarity",
	"completeSets",
	"melee",
	"listPriceNote",
] as const;
const requiredFilterKeys = ["skins", "sprays", "cards", "buddies", "titles", "flex"] as const;

describe("Inventory navigation and filters", () => {
	test("lives inside Tools instead of a rail route", () => {
		expect(main).not.toContain('id: "inventory"');
		expect(main).not.toContain('title: "nav.inventory"');
		expect(tools).toContain('import Inventory from "@/pages/Inventory.tsx"');
		expect(tools).toContain('data-tools-inventory=""');
		expect(tools).toContain("<Inventory embedded");
		expect(tools).toContain("data-tool={value}");
		expect(tools).toContain('["inventory", t("tools.inventory")]');
	});

	test("loads entitlements over IPC and joins valorant-api.com catalogs", () => {
		expect(page).toContain('send("inventory:get"');
		expect(page).toContain('send("analytics:track", "inventory:view"');
		expect(page).toContain("getInventoryIndex");
		expect(page).toContain("summarizeSkins");
		expect(page).toContain("groupAccessories");
		expect(page).toContain("resolveOwnedAccessories");
		expect(page).toContain("filterInventory");
		expect(page).toContain("sumSpend");
		expect(page).toContain("data-inventory-filter=");
		expect(page).toContain("data-inventory-item=");
		expect(assets).toContain("/weapons?language=all");
		expect(assets).toContain("/themes?language=all");
		expect(assets).toContain("/sprays?language=all");
		expect(assets).toContain("/buddies?language=all");
	});

	for (const locale of locales) {
		test(`${locale} localizes Inventory navigation, filters and spend`, () => {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			);
			expect(messages.tools.inventory).toBeString();
			expect(messages.tools.inventory.trim().length).toBeGreaterThan(0);
			expect(messages.tools.lookup).toBeString();
			for (const key of requiredInventoryKeys) {
				expect(messages.inventory[key]).toBeString();
				expect((messages.inventory[key] as string).trim().length).toBeGreaterThan(0);
			}
			for (const key of requiredFilterKeys) {
				expect(messages.inventory.filter[key]).toBeString();
				expect((messages.inventory.filter[key] as string).trim().length).toBeGreaterThan(0);
			}
		});
	}
});
