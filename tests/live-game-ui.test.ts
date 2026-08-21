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

	test("shows damage per round next to ACS on live player stats", () => {
		expect(table).toContain('t("liveGame.dpr")');
		expect(table).toContain('field="dpr"');
		expect(table).toContain("stats.stats.dpr");
	});

	test("does not expose the raw live-game dump control", () => {
		expect(liveGamePage).not.toContain('window.Main.send("live-game:dump")');
		expect(liveGamePage).not.toContain("FaDownload");
	});

	test("live game reads the developer tools setting for debug output", () => {
		expect(liveGamePage).toContain("openDevTools");
		expect(liveGamePage).toContain("developer={developer}");
	});

	test("pregame roster shows both teams, hidden agents, and fallback copy", () => {
		expect(table).toContain('t("liveGame.pregameRoster"');
		expect(table).toContain('t("liveGame.enemyRosterUnavailable")');
		expect(table).toContain('t("liveGame.hiddenAgent")');
		expect(table).toContain("agentFallback");
		expect(table).toContain("developer && isPregame && debugText");
		expect(table).toContain("StreakBadge");
		expect(table).toContain("winStreak");
	});

	for (const locale of locales) {
		test(`${locale} provides pregame roster copy`, () => {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			);
			for (const key of ["enemyRosterUnavailable", "pregameRoster", "hiddenAgent", "pregameDebug", "winStreak", "loseStreak", "winStreakHint", "loseStreakHint"] as const) {
				expect(messages.liveGame[key]).toBeString();
				expect(messages.liveGame[key].trim().length).toBeGreaterThan(0);
			}
			expect(messages.liveGame.hiddenAgent).toBe("???");
		});
	}
});
