import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MatchPlayer } from "@/types/matches";
import { formatDpr } from "./match-dpr";
import { scoreboardPlayerInteraction } from "./match-scoreboard-selection";

const player: MatchPlayer = {
	subject: "player-puuid",
	gameName: "Clickable",
	tagLine: "TW1",
	role: "player",
	teamId: "Blue",
	partyId: "",
	characterId: "agent",
	competitiveTier: 18,
	playerCard: "card",
	accountLevel: 100,
	isSelf: false,
	kills: 20,
	deaths: 10,
	assists: 5,
	score: 5000,
	roundsPlayed: 20,
	acs: 250,
	damage: 3000,
	adr: 150,
	dpr: 150,
	firstBloods: 3,
	headshots: 20,
	bodyshots: 40,
	legshots: 5,
	headshotPercent: 30.7,
};

describe("scoreboard player interaction", () => {
	test("activates the exact valid player and exposes their Riot ID", () => {
		const selected: MatchPlayer[] = [];
		const interaction = scoreboardPlayerInteraction(player, (value) => selected.push(value));

		expect(interaction.selectable).toBe(true);
		expect(interaction.label).toContain("Clickable#TW1");
		interaction.activate?.();
		expect(selected).toEqual([player]);
	});

	test("stays non-interactive without a callback or a valid PUUID", () => {
		expect(scoreboardPlayerInteraction(player).selectable).toBe(false);
		expect(
			scoreboardPlayerInteraction({ ...player, subject: "   " }, () => {}).selectable,
		).toBe(false);
	});
});

describe("first bloods", () => {
	test("scoreboard stats include first bloods next to DPR", () => {
		const source = readFileSync(join(import.meta.dir, "match-scoreboard.tsx"), "utf8");
		expect(source).toContain('t("matches.firstBloods")');
		expect(source).toContain("self.firstBloods");
		expect(source).toContain('t("matches.fb")');
		expect(source).toContain("player.firstBloods");
	});

	for (const locale of ["en", "ko", "zh-TW"] as const) {
		test(`${locale} localizes first bloods`, () => {
			const messages = JSON.parse(
				readFileSync(join(import.meta.dir, `../i18n/locales/${locale}.json`), "utf8"),
			);
			expect(messages.matches.firstBloods).toBeString();
			expect(messages.matches.fb).toBeString();
		});
	}
});

describe("damage per round", () => {
	test("uses dpr, then adr, then damage / rounds", () => {
		expect(formatDpr(player)).toBe("150");
		expect(formatDpr({ ...player, dpr: Number.NaN, adr: 148 })).toBe("148");
		expect(formatDpr({ ...player, dpr: Number.NaN, adr: Number.NaN, damage: 3010, roundsPlayed: 20 })).toBe("151");
	});
});
