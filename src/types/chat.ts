export type TranslatorProvider = "google" | "deepl";
export type ChatScope = "friends" | "party" | "match";
export type ChatChannel = "friends" | "party" | "team" | "all";
export type ChatRoomKey = ChatScope | "matchTeam" | "matchAll";
export type ChatRooms = Partial<Record<ChatRoomKey, string>> & { _partyXmppDebug?: Record<string, any> };

export type ChatConversation = {
	cid: string;
	channel: ChatChannel;
	type: "chat" | "groupchat";
	title: string;
	participantPuuid: string;
	unreadCount: number;
	messageHistory: boolean | null;
	muted: boolean;
};

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
	note: string;
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
	| { success: true; messages: ChatMessage[]; rooms: ChatRooms; conversations: ChatConversation[]; friends: ChatFriend[]; fetchedAt: string }
	| { success: false; code: "loginRequired" }
	| { success: false; error: string };

export type ChatHistoryResponse =
	| { success: true; requestId: string; cid: string; messages: ChatMessage[] }
	| {
			success: false;
			requestId: string;
			cid: string;
			code: "loginRequired" | "unavailable" | null;
			error: string;
	  };

export type TranslateResponse =
	| { success: true; translatedText: string; provider: TranslatorProvider; targetLanguage: string }
	| { success: false; error: string };

export type ChatSendResponse =
	| {
			success: true;
			requestId: string;
			cid: string;
			type: "chat" | "groupchat";
			transport: "rest" | "xmpp";
	  }
	| { success: false; requestId: string; cid: string; error: string };
