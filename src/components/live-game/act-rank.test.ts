import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CompetitiveSeason } from "../../types/live-game";
import * as actRankGeometry from "./act-rank";
import {
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
	test("keeps the nine highest tier wins and assigns the asymmetric reference cluster", () => {
		const tiles = buildActRankTiles({ "20": 5, "24": 2, "22": 4, bad: 8, "28": 3 });
		expect(tiles.map((tile) => tile.tier)).toEqual([24, 24, 22, 22, 22, 22, 20, 20, 20]);
		expect(tiles.map((tile) => [tile.row, tile.column, tile.orientation])).toEqual([
			[1, 1, "down"],
			[2, 1, "down"],
			[2, 2, "up"],
			[3, 2, "up"],
			[3, 3, "down"],
			[3, 4, "up"],
			[4, 3, "down"],
			[4, 4, "up"],
			[4, 5, "down"],
		]);
	});

	test("builds a symmetric triangle that is taller than it is wide", () => {
		const outerTrianglePoints = (
			actRankGeometry as typeof actRankGeometry & {
				outerTrianglePoints?: () => readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
			}
		).outerTrianglePoints;
		expect(outerTrianglePoints).toBeDefined();
		if (!outerTrianglePoints) return;
		const [apex, left, right] = outerTrianglePoints();
		expect(apex[0]).toBe((left[0] + right[0]) / 2);
		expect(right[0] - left[0]).toBeLessThan(left[1] - apex[1]);
		expect(left[1]).toBe(right[1]);
	});

	test("derives a centered inset border from the outer triangle", () => {
		const innerTrianglePoints = (
			actRankGeometry as typeof actRankGeometry & {
				innerTrianglePoints?: () => readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
			}
		).innerTrianglePoints;
		expect(innerTrianglePoints).toBeDefined();
		if (!innerTrianglePoints) return;
		const [apex, left, right] = innerTrianglePoints();
		expect(apex[0]).toBe((left[0] + right[0]) / 2);
		expect(left[0]).toBeGreaterThan(28);
		expect(right[0]).toBeLessThan(272);
		expect(apex[1]).toBeGreaterThan(12);
		expect(left[1]).toBeLessThan(348);
	});

	test("builds one aligned lattice whose neighboring cells share vertices", () => {
		type TestPoint = readonly [number, number];
		type TestCell = { row: number; column: number; points: readonly [TestPoint, TestPoint, TestPoint] };
		const geometry = actRankGeometry as typeof actRankGeometry & {
			actRankCellPoints?: (row: number, column: number) => readonly [TestPoint, TestPoint, TestPoint];
			buildLatticeCells?: () => TestCell[];
			pointInsideInnerTriangle?: (point: TestPoint) => boolean;
		};
		expect([
			typeof geometry.actRankCellPoints,
			typeof geometry.buildLatticeCells,
			typeof geometry.pointInsideInnerTriangle,
		]).toEqual(["function", "function", "function"]);
		if (!geometry.actRankCellPoints || !geometry.buildLatticeCells || !geometry.pointInsideInnerTriangle) return;

		const cells = geometry.buildLatticeCells();
		expect(cells).toHaveLength(64);
		for (const cell of cells) {
			for (const point of cell.points) expect(geometry.pointInsideInnerTriangle(point)).toBe(true);
		}

		const leftCell = geometry.actRankCellPoints(2, 1);
		const rightCell = geometry.actRankCellPoints(2, 2);
		const shared = leftCell.filter(([x, y]) =>
			rightCell.some(([otherX, otherY]) => Math.abs(x - otherX) < 1e-7 && Math.abs(y - otherY) < 1e-7),
		);
		expect(shared).toHaveLength(2);
	});

	test("maps every competitive tier band to its Valorant palette", () => {
		const actRankPalette = (
			actRankGeometry as typeof actRankGeometry & {
				actRankPalette?: (tier: number) => { name: string };
			}
		).actRankPalette;
		expect(actRankPalette).toBeDefined();
		if (!actRankPalette) return;
		expect([3, 6, 9, 12, 15, 18, 21, 24, 27].map((tier) => actRankPalette(tier).name)).toEqual([
			"iron",
			"bronze",
			"silver",
			"gold",
			"platinum",
			"diamond",
			"ascendant",
			"immortal",
			"radiant",
		]);
		expect(actRankPalette(20).name).toBe("diamond");
		expect(actRankPalette(26).name).toBe("immortal");
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
