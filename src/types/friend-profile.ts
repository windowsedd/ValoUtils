import type { CompetitiveSeason } from "./live-game";

export type FriendMatch = {
	matchId: string;
	startMillis: number;
	queueId: string;
	tierBefore: number | null;
	tierAfter: number | null;
	rankedRatingAfter: number | null;
	rrEarned: number | null;
};

export type FriendProfileData = {
	currentTier: number;
	currentRR: number;
	peakTier: number;
	peakSeasonId: string | null;
	currentSeasonId: string | null;
	competitiveSeasons: CompetitiveSeason[];
	matches: FriendMatch[];
};

export type FriendProfileResponse =
	| { success: true; puuid: string; profile: FriendProfileData }
	| {
			success: false;
			code: "invalidPlayer" | "loginRequired" | "unavailable";
			error?: string;
	  };
