export type TranslatorProvider = "google" | "deepl";
export type ChatScope = "friends" | "party" | "match";
export type ChatRoomKey = ChatScope | "matchTeam" | "matchAll";
export type ChatRooms = Partial<Record<ChatRoomKey, string>> & { _partyXmppDebug?: Record<string, any> };

export type ChatMessage = {
	id: string;
	conversationId: string;
	sender: string;
	senderName: string;
	body: string;
	timestamp: string | null;
	type: string;
	scope: ChatScope;
	isSelf: boolean;
	_raw?: any;
};

export type ChatFriend = {
	puuid: string;
	gameName: string;
	tagLine: string;
	displayName: string;
	status: string;
	statusMessage: string;
	product: string;
	queueId: string;
	partyId: string;
	partySize: number | null;
	maxPartySize: number | null;
	isOnline: boolean;
};

export type ChatResponse =
	| { success: true; messages: ChatMessage[]; rooms: ChatRooms; friends: ChatFriend[]; fetchedAt: string }
	| { success: false; code: "loginRequired" }
	| { success: false; error: string };

export type TranslateResponse =
	| { success: true; translatedText: string; provider: TranslatorProvider; targetLanguage: string }
	| { success: false; error: string };

export type ChatSendResponse =
	| { success: true }
	| { success: false; error: string };
