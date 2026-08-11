import type { CompetitiveSeason } from "../../types/live-game";

export type ActRankTile = {
	tier: number;
	row: number;
	column: number;
	orientation: "up" | "down";
};

export type Point = readonly [number, number];

export const ACT_RANK_GEOMETRY = {
	width: 300,
	height: 360,
	centerX: 150,
	apexY: 12,
	baseY: 348,
	halfWidth: 122,
	innerScale: 0.91,
	rows: 8,
} as const;

export const outerTrianglePoints = (): readonly [Point, Point, Point] => [
	[ACT_RANK_GEOMETRY.centerX, ACT_RANK_GEOMETRY.apexY],
	[ACT_RANK_GEOMETRY.centerX - ACT_RANK_GEOMETRY.halfWidth, ACT_RANK_GEOMETRY.baseY],
	[ACT_RANK_GEOMETRY.centerX + ACT_RANK_GEOMETRY.halfWidth, ACT_RANK_GEOMETRY.baseY],
];

export const innerTrianglePoints = (): readonly [Point, Point, Point] => {
	const outer = outerTrianglePoints();
	const centroid: Point = [
		(outer[0][0] + outer[1][0] + outer[2][0]) / 3,
		(outer[0][1] + outer[1][1] + outer[2][1]) / 3,
	];
	const inset = ([x, y]: Point): Point => [
		centroid[0] + (x - centroid[0]) * ACT_RANK_GEOMETRY.innerScale,
		centroid[1] + (y - centroid[1]) * ACT_RANK_GEOMETRY.innerScale,
	];
	return [inset(outer[0]), inset(outer[1]), inset(outer[2])];
};

export const actRankCellPoints = (
	row: number,
	column: number,
): readonly [Point, Point, Point] => {
	const [apex, left, right] = innerTrianglePoints();
	const cellWidth = (right[0] - left[0]) / ACT_RANK_GEOMETRY.rows;
	const cellHeight = (left[1] - apex[1]) / ACT_RANK_GEOMETRY.rows;
	const top = apex[1] + row * cellHeight;
	const bottom = top + cellHeight;
	const x =
		ACT_RANK_GEOMETRY.centerX -
		((row + 1) * cellWidth) / 2 +
		(column * cellWidth) / 2;
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
const BADGE_TILE_COUNT = 9;
const BADGE_SLOTS = [
	[1, 1],
	[2, 1],
	[2, 2],
	[3, 2],
	[3, 3],
	[3, 4],
	[4, 3],
	[4, 4],
	[4, 5],
] as const;
const TILE_WIDTH = 63 / 512 * 100;
const TILE_HEIGHT = 56 / 512 * 100;
const FIRST_ROW_TOP = 160 / 512 * 100;

export const buildActRankTiles = (winsByTier: Record<string, number>): ActRankTile[] => {
	const tiers = Object.entries(winsByTier)
		.flatMap(([rawTier, rawCount]) => {
			const tier = Number(rawTier);
			const count = Math.max(0, Math.floor(Number(rawCount) || 0));
			return Number.isInteger(tier) && tier >= VALID_TIER_MIN && tier <= VALID_TIER_MAX
				? Array.from({ length: count }, () => tier)
				: [];
		})
		.sort((a, b) => b - a)
		.slice(0, BADGE_TILE_COUNT);

	return tiers.map((tier, index) => {
		const [row, column] = BADGE_SLOTS[index];
		return { tier, row, column, orientation: column % 2 === 0 ? "up" : "down" };
	});
};

export const actRankTileStyle = (
	tile: ActRankTile,
): { left: number; top: number; width: number; height: number } => {
	const rowWidth = TILE_WIDTH * (tile.row + 1);
	return {
		left: 50 - rowWidth / 2 + (tile.column * TILE_WIDTH) / 2,
		top: FIRST_ROW_TOP + tile.row * TILE_HEIGHT,
		width: TILE_WIDTH,
		height: TILE_HEIGHT,
	};
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
