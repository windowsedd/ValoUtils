export type LiveState = "coregame" | "pregame" | "party" | "idle";

export type WeaponSkin = {
	skinId?: string;
	levelId?: string;
	chromaId?: string;
} | null;

export type LiveLoadout = {
	vandal: WeaponSkin;
	phantom: WeaponSkin;
	knife: WeaponSkin;
};

export type LivePlayer = {
	puuid: string;
	gameName: string;
	tagLine: string;
	/** Riot team id ("Blue" / "Red") in coregame, agent team in pregame. */
	teamId: string | null;
	characterId: string | null;
	cardId: string | null;
	/** Account level, or null when the player hides it. */
	level: number | null;
	currentTier: number;
	currentRR: number;
	peakTier: number;
	/** Competitive act/season UUID of the peak; resolved to a label client-side. */
	peakSeasonId: string | null;
	/** "Team 1" / "Team 2" … when a multi-player party is detected, else null. */
	party: string | null;
	incognito: boolean;
	loadout: LiveLoadout | null;
};

export type LiveGameResponse =
	| { success: true; state: LiveState; players: LivePlayer[] }
	| { success: false; code: "loginRequired" }
	| { success: false; error: string };
