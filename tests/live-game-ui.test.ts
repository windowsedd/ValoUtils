import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const table = readFileSync(
	join(root, "src/components/live-game/live-scout-table.tsx"),
	"utf8",
);
const liveGamePage = readFileSync(join(root, "src/pages/LiveGame.tsx"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;

describe("Live Match signed-in player marker", () => {
	test("the player row conditionally renders the localized Me badge", () => {
		expect(table).toContain("player.isSelf");
		expect(table).toContain('t("liveGame.me")');
	});

	for (const locale of locales) {
		test(`${locale} provides the Me badge copy`, () => {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			);
			expect(messages.liveGame.me).toBeString();
			expect(messages.liveGame.me.trim().length).toBeGreaterThan(0);
		});
	}

	test("desktop grids cap the player column and keep spare width at the right edge", () => {
		expect(table.match(/md:grid-cols-\[minmax\(180px,300px\)/g)?.length).toBe(2);
		expect(table.match(/minmax\(34px,1fr\)\]/g)?.length).toBe(4);
	});

	test("does not expose the raw live-game dump control", () => {
		expect(liveGamePage).not.toContain('window.Main.send("live-game:dump")');
		expect(liveGamePage).not.toContain("FaDownload");
	});
});
