import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CompetitiveSeason } from "../../types/live-game";
import {
	actRankTileStyle,
	borderIndexForWins,
	buildActRankTiles,
	initialSeasonId,
	seasonFallbackLabel,
	sortCompetitiveSeasons,
	tierRangeFromWins,
} from "./act-rank";

const season = (seasonId: string): CompetitiveSeason => ({
	seasonId,
	tier: 20,
	rankedRating: 40,
	wins: 10,
	games: 18,
	winsByTier: {},
});

describe("act rank badge", () => {
	test("keeps the nine highest tier wins and assigns tessellated slots", () => {
		const tiles = buildActRankTiles({ "20": 5, "24": 2, "22": 4, bad: 8, "28": 3 });
		expect(tiles.map((tile) => tile.tier)).toEqual([24, 24, 22, 22, 22, 22, 20, 20, 20]);
		expect(tiles.map((tile) => [tile.row, tile.column, tile.orientation])).toEqual([
			[0, 0, "up"],
			[1, 0, "up"],
			[1, 1, "down"],
			[1, 2, "up"],
			[2, 0, "up"],
			[2, 1, "down"],
			[2, 2, "up"],
			[2, 3, "down"],
			[2, 4, "up"],
		]);
	});

	test("selects borders at Riot win thresholds", () => {
		expect([0, 8, 9, 24, 25, 49, 50, 74, 75, 99, 100].map(borderIndexForWins)).toEqual([
			0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5,
		]);
	});

	test("finds the valid peak and lowest tiers", () => {
		expect(tierRangeFromWins({ "20": 3, "24": 1, "2": 9, "28": 9, bad: 9 })).toEqual({
			lowest: 20,
			peak: 24,
		});
		expect(tierRangeFromWins({ "20": 0 })).toEqual({ lowest: 0, peak: 0 });
	});

	test("maps tiles to the supplied 512px border grid", () => {
		expect(actRankTileStyle({ tier: 24, row: 0, column: 0, orientation: "up" })).toEqual({
			left: 43.84765625,
			top: 31.25,
			width: 12.3046875,
			height: 10.9375,
		});
		expect(actRankTileStyle({ tier: 20, row: 2, column: 4, orientation: "up" })).toEqual({
			left: 56.15234375,
			top: 53.125,
			width: 12.3046875,
			height: 10.9375,
		});
	});
});

describe("act selection", () => {
	test("sorts by season start and prefers the current act", () => {
		const seasons = [season("old"), season("current"), season("middle")];
		const starts = new Map([
			["old", 100],
			["middle", 200],
			["current", 300],
		]);
		expect(sortCompetitiveSeasons(seasons, starts).map((item) => item.seasonId)).toEqual([
			"current",
			"middle",
			"old",
		]);
		expect(initialSeasonId(seasons, "current", starts)).toBe("current");
		expect(initialSeasonId(seasons, "missing", starts)).toBe("current");
	});

	test("uses deterministic fallbacks", () => {
		expect(initialSeasonId([season("b"), season("a")], null, new Map())).toBe("a");
		expect(seasonFallbackLabel("12345678-abcd-efgh")).toBe("12345678");
	});
});

test("all valid tier orientations and borders have supplied assets", () => {
	for (let tier = 3; tier <= 27; tier++) {
		for (const orientation of ["up", "down"]) {
			expect(existsSync(join(process.cwd(), "public", "mmr", `${tier}_${orientation}.png`))).toBe(true);
		}
	}
	for (let border = 0; border <= 5; border++) {
		expect(existsSync(join(process.cwd(), "public", "mmr", `border${border}.png`))).toBe(true);
	}
});
