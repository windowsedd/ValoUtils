import type { FriendMatch } from "@/types/friend-profile";

const numberOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export const normalizeCareerMatches = (history: any, competitiveUpdates: any): FriendMatch[] => {
	const updates = new Map<string, any>(
		(competitiveUpdates?.Matches ?? [])
			.filter((update: any) => typeof update?.MatchID === "string")
			.map((update: any) => [update.MatchID, update]),
	);

	return (history?.History ?? []).flatMap((entry: any) => {
		if (typeof entry?.MatchID !== "string" || !entry.MatchID) return [];
		const update = updates.get(entry.MatchID);
		return [{
			matchId: entry.MatchID,
			startMillis: typeof entry.GameStartTime === "number" ? entry.GameStartTime : 0,
			queueId: typeof entry.QueueID === "string" ? entry.QueueID : "",
			tierBefore: numberOrNull(update?.TierBeforeUpdate),
			tierAfter: numberOrNull(update?.TierAfterUpdate),
			rankedRatingAfter: numberOrNull(update?.RankedRatingAfterUpdate),
			rrEarned: numberOrNull(update?.RankedRatingEarned),
		}];
	});
};
