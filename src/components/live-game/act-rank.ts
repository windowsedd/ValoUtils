import type { CompetitiveSeason } from "../../types/live-game";

export type ActRankTile = {
  tier: number;
  row: number;
  column: number;
  orientation: "up" | "down";
};

export type Point = readonly [number, number];

export type ActRankCellBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ActRankPalette = {
  name:
    | "iron"
    | "bronze"
    | "silver"
    | "gold"
    | "platinum"
    | "diamond"
    | "ascendant"
    | "immortal"
    | "radiant";
  dark: string;
  base: string;
  light: string;
  edge: string;
};

const ACT_RANK_PALETTES: readonly ActRankPalette[] = [
  { name: "iron", dark: "#454a50", base: "#707881", light: "#aeb5bb", edge: "#c8cdd1" },
  { name: "bronze", dark: "#70452f", base: "#a86d48", light: "#d79a69", edge: "#edb889" },
  { name: "silver", dark: "#66737e", base: "#9caab5", light: "#d9e1e6", edge: "#eef4f7" },
  { name: "gold", dark: "#9b681b", base: "#d6a12c", light: "#ffe17a", edge: "#fff0a4" },
  { name: "platinum", dark: "#167d83", base: "#27b4b6", light: "#80f0e5", edge: "#adfff4" },
  { name: "diamond", dark: "#6233a5", base: "#905ce0", light: "#cfadff", edge: "#eadcff" },
  { name: "ascendant", dark: "#176c50", base: "#27aa75", light: "#75e5ab", edge: "#a7f7cb" },
  { name: "immortal", dark: "#9d3152", base: "#dc5579", light: "#ff9ab2", edge: "#ffc1cf" },
  { name: "radiant", dark: "#8d6b28", base: "#d3ad55", light: "#fff0a7", edge: "#fff8cf" },
];

export const actRankPalette = (tier: number): ActRankPalette => {
  const paletteIndex = Math.min(8, Math.max(0, Math.floor((tier - 3) / 3)));
  return ACT_RANK_PALETTES[paletteIndex];
};

export const ACT_RANK_GEOMETRY = {
  width: 512,
  height: 512,
  centerX: 256,
  apexY: 48,
  baseY: 464,
  innerApexY: 96,
  innerBaseY: 411,
  rows: 7,
} as const;

export const ACT_RANK_CANVAS_SIZE = 512;
export const ACT_RANK_CONTENT_INSET = 10;

const equilateralHalfWidth = (height: number) => height / Math.sqrt(3);

export const outerTrianglePoints = (): readonly [Point, Point, Point] => {
  const halfWidth = equilateralHalfWidth(ACT_RANK_GEOMETRY.baseY - ACT_RANK_GEOMETRY.apexY);
  return [
    [ACT_RANK_GEOMETRY.centerX, ACT_RANK_GEOMETRY.apexY],
    [ACT_RANK_GEOMETRY.centerX - halfWidth, ACT_RANK_GEOMETRY.baseY],
    [ACT_RANK_GEOMETRY.centerX + halfWidth, ACT_RANK_GEOMETRY.baseY],
  ];
};

export const frameInnerTrianglePoints = (): readonly [Point, Point, Point] => {
  const halfWidth = equilateralHalfWidth(
    ACT_RANK_GEOMETRY.innerBaseY - ACT_RANK_GEOMETRY.innerApexY,
  );
  return [
    [ACT_RANK_GEOMETRY.centerX, ACT_RANK_GEOMETRY.innerApexY],
    [ACT_RANK_GEOMETRY.centerX - halfWidth, ACT_RANK_GEOMETRY.innerBaseY],
    [ACT_RANK_GEOMETRY.centerX + halfWidth, ACT_RANK_GEOMETRY.innerBaseY],
  ];
};

export const innerTrianglePoints = (): readonly [Point, Point, Point] => {
  const apexY = ACT_RANK_GEOMETRY.innerApexY + ACT_RANK_CONTENT_INSET * 2;
  const baseY = ACT_RANK_GEOMETRY.innerBaseY - ACT_RANK_CONTENT_INSET;
  const halfWidth = equilateralHalfWidth(baseY - apexY);
  return [
    [ACT_RANK_GEOMETRY.centerX, apexY],
    [ACT_RANK_GEOMETRY.centerX - halfWidth, baseY],
    [ACT_RANK_GEOMETRY.centerX + halfWidth, baseY],
  ];
};

const cellPointsForTriangle = (
  triangle: readonly [Point, Point, Point],
  row: number,
  column: number,
): readonly [Point, Point, Point] => {
  const [apex, left, right] = triangle;
  const cellWidth = (right[0] - left[0]) / ACT_RANK_GEOMETRY.rows;
  const cellHeight = (left[1] - apex[1]) / ACT_RANK_GEOMETRY.rows;
  const top = apex[1] + row * cellHeight;
  const bottom = top + cellHeight;
  const x = ACT_RANK_GEOMETRY.centerX - ((row + 1) * cellWidth) / 2 + (column * cellWidth) / 2;
  return column % 2 === 0
    ? [
        [x + cellWidth / 2, top],
        [x, bottom],
        [x + cellWidth, bottom],
      ]
    : [
        [x, top],
        [x + cellWidth, top],
        [x + cellWidth / 2, bottom],
      ];
};

export const actRankCellPoints = (row: number, column: number) =>
  cellPointsForTriangle(innerTrianglePoints(), row, column);

export const actRankCrystalCellPoints = (row: number, column: number) =>
  cellPointsForTriangle(frameInnerTrianglePoints(), row, column);

const boundsFromPoints = (points: readonly Point[]): ActRankCellBounds => {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
};

export const actRankCellBounds = (row: number, column: number): ActRankCellBounds =>
  boundsFromPoints(actRankCellPoints(row, column));

export const actRankCrystalCellBounds = (row: number, column: number): ActRankCellBounds =>
  boundsFromPoints(actRankCrystalCellPoints(row, column));

export const buildLatticeCells = () =>
  Array.from({ length: ACT_RANK_GEOMETRY.rows }, (_, row) =>
    Array.from({ length: row * 2 + 1 }, (_, column) => ({
      row,
      column,
      orientation: column % 2 === 0 ? ("up" as const) : ("down" as const),
      points: actRankCellPoints(row, column),
    })),
  ).flat();

export const pointInsideInnerTriangle = (point: Point): boolean => {
  const [apex, left, right] = innerTrianglePoints();
  const cross = (a: Point, b: Point) =>
    (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  const signs = [cross(apex, left), cross(left, right), cross(right, apex)];
  return signs.every((value) => value >= -1e-7) || signs.every((value) => value <= 1e-7);
};

const VALID_TIER_MIN = 3;
const VALID_TIER_MAX = 27;
const BADGE_SLOTS = buildLatticeCells().map(({ row, column }) => [row, column] as const);

export const buildActRankTiles = (
  winsByTier: Record<string, number>,
  wins: number,
): ActRankTile[] => {
  const tileCount = Math.min(BADGE_SLOTS.length, Math.max(0, Math.floor(Number(wins) || 0)));
  const tiers = Object.entries(winsByTier)
    .flatMap(([rawTier, rawCount]) => {
      const tier = Number(rawTier);
      const count = Math.max(0, Math.floor(Number(rawCount) || 0));
      return Number.isInteger(tier) && tier >= VALID_TIER_MIN && tier <= VALID_TIER_MAX
        ? Array.from({ length: count }, () => tier)
        : [];
    })
    .sort((a, b) => b - a)
    .slice(0, tileCount);

  return tiers.map((tier, index) => {
    const [row, column] = BADGE_SLOTS[index];
    return { tier, row, column, orientation: column % 2 === 0 ? "up" : "down" };
  });
};

export const borderIndexForWins = (wins: number): number => {
  if (wins >= 100) return 5;
  if (wins >= 75) return 4;
  if (wins >= 50) return 3;
  if (wins >= 25) return 2;
  if (wins >= 9) return 1;
  return 0;
};

export const tierRangeFromWins = (
  winsByTier: Record<string, number>,
): { lowest: number; peak: number } => {
  const tiers = Object.entries(winsByTier)
    .filter(([, count]) => count > 0)
    .map(([tier]) => Number(tier))
    .filter((tier) => Number.isInteger(tier) && tier >= VALID_TIER_MIN && tier <= VALID_TIER_MAX);
  return tiers.length
    ? { lowest: Math.min(...tiers), peak: Math.max(...tiers) }
    : { lowest: 0, peak: 0 };
};

export const sortCompetitiveSeasons = (
  seasons: CompetitiveSeason[],
  starts: Map<string, number>,
): CompetitiveSeason[] =>
  [...seasons].sort((a, b) => {
    const dateDifference =
      (starts.get(b.seasonId.toLowerCase()) ?? 0) - (starts.get(a.seasonId.toLowerCase()) ?? 0);
    return dateDifference || a.seasonId.localeCompare(b.seasonId);
  });

export const initialSeasonId = (
  seasons: CompetitiveSeason[],
  currentSeasonId: string | null,
  starts: Map<string, number>,
): string | null => {
  if (currentSeasonId && seasons.some((season) => season.seasonId === currentSeasonId)) {
    return currentSeasonId;
  }
  return sortCompetitiveSeasons(seasons, starts)[0]?.seasonId ?? null;
};

export const seasonFallbackLabel = (seasonId: string): string => seasonId.slice(0, 8);
