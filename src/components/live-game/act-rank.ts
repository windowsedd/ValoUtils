import type { CompetitiveSeason } from "../../types/live-game";

export type ActRankTile = {
	tier: number;
	row: number;
	column: number;
	orientation: "up" | "down";
};

const VALID_TIER_MIN = 3;
const VALID_TIER_MAX = 27;
const BADGE_TILE_COUNT = 9;
const TILE_WIDTH = 48 / 512 * 100;
const TILE_HEIGHT = 42 / 512 * 100;
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
		const row = index === 0 ? 0 : index <= 3 ? 1 : 2;
		const rowStart = row === 0 ? 0 : row === 1 ? 1 : 4;
		const column = index - rowStart;
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
