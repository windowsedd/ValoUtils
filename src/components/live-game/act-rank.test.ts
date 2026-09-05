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
  test("renders all fourteen valid wins in tier order and fills the lattice row by row", () => {
    const tiles = buildActRankTiles({ "20": 35, "24": 2, "22": 12, bad: 8, "28": 3, "18": -2 }, 14);
    expect(tiles.map((tile) => tile.tier)).toEqual([
      24, 24, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22,
    ]);
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
      [3, 0, "up"],
      [3, 1, "down"],
      [3, 2, "up"],
      [3, 3, "down"],
      [3, 4, "up"],
    ]);
  });

  test("fills the complete seven-row lattice and caps only beyond its 49 cells", () => {
    const full = buildActRankTiles({ "20": 60 }, 60);
    expect(full).toHaveLength(49);
    expect(full.at(-1)).toMatchObject({ row: 6, column: 12, orientation: "up" });
    expect(buildActRankTiles({ "20": 49 }, 14)).toHaveLength(14);
    expect(buildActRankTiles({ "20": 49 }, 0)).toHaveLength(0);
    expect(buildActRankTiles({ "20": 49 }, -5)).toHaveLength(0);
  });

  test("fits tier PNGs into the shared seven-row lattice cells", () => {
    const actRankCellBounds = (
      actRankGeometry as typeof actRankGeometry & {
        actRankCellBounds?: (
          row: number,
          column: number,
        ) => {
          left: number;
          top: number;
          width: number;
          height: number;
        };
      }
    ).actRankCellBounds;
    expect(actRankCellBounds).toBeDefined();
    if (!actRankCellBounds) return;
    const first = actRankCellBounds(0, 0);
    expect(first.top).toBe(116);
    expect(first.height).toBeCloseTo(285 / 7, 10);
    expect(first.width).toBeCloseTo((2 * 285) / Math.sqrt(3) / 7, 10);
    expect(first.left + first.width / 2).toBeCloseTo(256, 10);

    const down = actRankCellBounds(1, 1);
    expect(down.top).toBeCloseTo(116 + 285 / 7, 10);
    expect(down.height).toBeCloseTo(285 / 7, 10);
    expect(down.left + down.width / 2).toBeCloseTo(256, 10);
  });

  test("builds Rank crystal cells against the frame interior", () => {
    type TestPoint = readonly [number, number];
    const geometry = actRankGeometry as typeof actRankGeometry & {
      actRankCrystalCellPoints?: (
        row: number,
        column: number,
      ) => readonly [TestPoint, TestPoint, TestPoint];
      actRankCrystalCellBounds?: (
        row: number,
        column: number,
      ) => { left: number; top: number; width: number; height: number };
    };
    expect(geometry.actRankCrystalCellPoints).toBeDefined();
    expect(geometry.actRankCrystalCellBounds).toBeDefined();
    if (!geometry.actRankCrystalCellPoints || !geometry.actRankCrystalCellBounds) return;

    const [apex] = geometry.actRankCrystalCellPoints(0, 0);
    const firstBounds = geometry.actRankCrystalCellBounds(0, 0);
    const lastRowBounds = geometry.actRankCrystalCellBounds(6, 0);
    expect(apex).toEqual([256, 96]);
    expect(firstBounds.top).toBe(96);
    expect(firstBounds.height).toBe(45);
    expect(lastRowBounds.top + lastRowBounds.height).toBe(411);
  });

  test("builds a symmetric near-equilateral reference triangle", () => {
    expect(actRankGeometry.ACT_RANK_GEOMETRY).toMatchObject({
      width: 512,
      height: 512,
      centerX: 256,
      apexY: 48,
      baseY: 464,
    });
    const outerTrianglePoints = (
      actRankGeometry as typeof actRankGeometry & {
        outerTrianglePoints?: () => readonly [
          readonly [number, number],
          readonly [number, number],
          readonly [number, number],
        ];
      }
    ).outerTrianglePoints;
    expect(outerTrianglePoints).toBeDefined();
    if (!outerTrianglePoints) return;
    const [apex, left, right] = outerTrianglePoints();
    expect(apex).toEqual([256, 48]);
    expect(apex[0]).toBe((left[0] + right[0]) / 2);
    expect((right[0] - left[0]) / (left[1] - apex[1])).toBeCloseTo(2 / Math.sqrt(3), 5);
    expect(left[1]).toBe(464);
    expect(left[1]).toBe(right[1]);
  });

  test("insets the content triangle from the official frame interior", () => {
    type TestPoint = readonly [number, number];
    const geometry = actRankGeometry as typeof actRankGeometry & {
      ACT_RANK_CONTENT_INSET?: number;
      frameInnerTrianglePoints?: () => readonly [TestPoint, TestPoint, TestPoint];
    };
    expect(geometry.ACT_RANK_CONTENT_INSET).toBe(10);
    expect(geometry.frameInnerTrianglePoints).toBeDefined();
    if (!geometry.frameInnerTrianglePoints) return;

    const [frameApex, frameLeft, frameRight] = geometry.frameInnerTrianglePoints();
    const [contentApex, contentLeft, contentRight] = geometry.innerTrianglePoints();
    expect(frameApex).toEqual([256, 96]);
    expect(frameLeft[1]).toBe(411);
    expect(frameRight[1]).toBe(411);
    expect(contentApex).toEqual([256, 116]);
    expect(contentLeft[1]).toBe(401);
    expect(contentRight[1]).toBe(401);

    const lineDistance = (point: TestPoint, start: TestPoint, end: TestPoint) =>
      Math.abs(
        (end[0] - start[0]) * (start[1] - point[1]) - (start[0] - point[0]) * (end[1] - start[1]),
      ) / Math.hypot(end[0] - start[0], end[1] - start[1]);

    expect(lineDistance(contentLeft, frameApex, frameLeft)).toBeCloseTo(10, 10);
    expect(lineDistance(contentRight, frameApex, frameRight)).toBeCloseTo(10, 10);
  });

  test("builds one aligned lattice whose neighboring cells share vertices", () => {
    type TestPoint = readonly [number, number];
    type TestCell = {
      row: number;
      column: number;
      points: readonly [TestPoint, TestPoint, TestPoint];
    };
    const geometry = actRankGeometry as typeof actRankGeometry & {
      actRankCellPoints?: (
        row: number,
        column: number,
      ) => readonly [TestPoint, TestPoint, TestPoint];
      buildLatticeCells?: () => TestCell[];
      pointInsideInnerTriangle?: (point: TestPoint) => boolean;
    };
    expect([
      typeof geometry.actRankCellPoints,
      typeof geometry.buildLatticeCells,
      typeof geometry.pointInsideInnerTriangle,
    ]).toEqual(["function", "function", "function"]);
    if (
      !geometry.actRankCellPoints ||
      !geometry.buildLatticeCells ||
      !geometry.pointInsideInnerTriangle
    )
      return;

    const cells = geometry.buildLatticeCells();
    expect(cells).toHaveLength(49);
    for (const cell of cells) {
      for (const point of cell.points) expect(geometry.pointInsideInnerTriangle(point)).toBe(true);
    }

    const leftCell = geometry.actRankCellPoints(2, 1);
    const rightCell = geometry.actRankCellPoints(2, 2);
    const shared = leftCell.filter(([x, y]) =>
      rightCell.some(
        ([otherX, otherY]) => Math.abs(x - otherX) < 1e-7 && Math.abs(y - otherY) < 1e-7,
      ),
    );
    expect(shared).toHaveLength(2);

    const firstCell = geometry.actRankCellPoints(0, 0);
    const [a, b, c] = firstCell;
    const distance = ([x1, y1]: TestPoint, [x2, y2]: TestPoint) => Math.hypot(x2 - x1, y2 - y1);
    expect(distance(a, b)).toBeCloseTo(distance(b, c), 10);
    expect(distance(b, c)).toBeCloseTo(distance(c, a), 10);
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
      expect(existsSync(join(process.cwd(), "public", "mmr", `${tier}_${orientation}.png`))).toBe(
        true,
      );
    }
  }
  for (let border = 0; border <= 5; border++) {
    expect(existsSync(join(process.cwd(), "public", "mmr", `border${border}.png`))).toBe(true);
  }
});
