/** VALORANT slice of a friend's presence. Null unless they're in the game. */
export type FriendValorantPresence = {
	/** Raw queue id: "competitive" | "unrated" | "swiftplay" | "deathmatch" | … */
	queueId: string;
	/** "MENUS" (lobby) | "PREGAME" (agent select) | "INGAME" */
	sessionLoopState: string;
	provisioningFlow: string;
	matchMap: string;
	allyScore: number | null;
	enemyScore: number | null;
	partyId: string;
	partySize: number | null;
	maxPartySize: number | null;
	isIdle: boolean;
	playerCardId: string;
	competitiveTier: number | null;
	accountLevel: number | null;
};

export type Friend = {
	puuid: string;
	gameName: string;
	tagLine: string;
	displayName: string;
	region: string;
	note: string;
	lastOnline: number | null;
	/** "chat" (online) | "away" | "dnd" (busy/in-match) | "mobile" | "" (offline) */
	state: string;
	/** "valorant" | "league_of_legends" | "riot_client" | … */
	product: string;
	isOnline: boolean;
	/** Actually in the game, not just running its client. See friends.rs. */
	playing: boolean;
	valorant: FriendValorantPresence | null;
};

export type FriendRequest = {
	puuid: string;
	gameName: string;
	tagLine: string;
	displayName: string;
	region: string;
	direction: "incoming" | "outgoing";
	note: string;
};

export type FriendsResponse =
	| { success: true; friends: Friend[]; requests: FriendRequest[]; fetchedAt: string }
	| { success: false; code: "loginRequired"; error?: string }
	| { success: false; code: null; error: string };
