import type { CompetitiveSeason } from "../../types/live-game";
import { seasonFallbackLabel, sortCompetitiveSeasons, tierRangeFromWins } from "./act-rank";

export type PreviousActCard = {
  seasonId: string;
  label: string;
  peakTier: number;
  games: number;
  wins: number;
  winRate: number | null;
};

export const formatPreviousActLabel = (label: string): string => {
  const match = label.match(/^(V\d+|E\d+)A(\d+)$/i);
  return match ? `${match[1]}:A${match[2]}` : label;
};

export const previousActCards = (
  seasons: readonly CompetitiveSeason[],
  currentSeasonId: string | null,
  starts: Map<string, number>,
  labels: Map<string, string>,
  limit = 8,
): PreviousActCard[] => {
  const current = currentSeasonId?.toLowerCase() ?? "";
  return sortCompetitiveSeasons([...seasons], starts)
    .filter((season) => season.seasonId.toLowerCase() !== current)
    .slice(0, limit)
    .map((season) => {
      const fromWins = tierRangeFromWins(season.winsByTier).peak;
      const peakTier = fromWins > 0 ? fromWins : season.tier >= 3 ? season.tier : 0;
      const games = Math.max(0, season.games);
      const wins = Math.max(0, season.wins);
      return {
        seasonId: season.seasonId,
        label: formatPreviousActLabel(
          labels.get(season.seasonId.toLowerCase()) ?? seasonFallbackLabel(season.seasonId),
        ),
        peakTier,
        games,
        wins,
        winRate: games > 0 ? (wins / games) * 100 : null,
      };
    });
};
