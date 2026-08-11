import type { CompetitiveSeason } from "./live-game";

export type CompetitiveUpdate = {
	MatchID?: string;
	MapID?: string;
	MatchStartTime?: number;
	TierBeforeUpdate?: number;
	TierAfterUpdate?: number;
	RankedRatingAfterUpdate?: number;
	RankedRatingEarned?: number;
};

export type FriendProfileData = {
	currentTier: number;
	currentRR: number;
	peakTier: number;
	peakSeasonId: string | null;
	currentSeasonId: string | null;
	competitiveSeasons: CompetitiveSeason[];
	competitiveUpdates: { Matches?: CompetitiveUpdate[] };
};

export type FriendProfileResponse =
	| { success: true; puuid: string; profile: FriendProfileData }
	| {
			success: false;
			code: "invalidPlayer" | "loginRequired" | "unavailable";
			error?: string;
	  };
