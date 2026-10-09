export type TranslatorProvider = "google" | "deepl" | "ai";
export type ChatScope = "friends" | "party" | "match";
export type ChatChannel = "friends" | "party" | "team" | "all";
export type ChatPresenceState = "syncing" | "ready" | "reconnecting";
export type ChatRoomKey = ChatScope | "matchTeam" | "matchAll";
export type ChatRooms = Partial<Record<ChatRoomKey, string>> & {
  _partyXmppDebug?: Record<string, any>;
};

export type ChatConversation = {
  cid: string;
  channel: ChatChannel;
  type: "chat" | "groupchat";
  title: string;
  participantPuuid: string;
  unreadCount: number;
  mid?: string;
  messageHistory: boolean | null;
  muted: boolean;
  supportsHistory: boolean;
  /** Team/All room of a match that has ended, kept read-only until the next one. */
  ended?: boolean;
};

/** Match state when a party/team/all message arrived (from our own presence). */
export type ChatRound = {
  phase: "pregame" | "ingame";
  round?: number;
  allyScore?: number;
  enemyScore?: number;
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
  round?: ChatRound;
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
  sessionLoopState: string;
  product: string;
  queueId: string;
  partyId: string;
  partySize: number | null;
  maxPartySize: number | null;
  /** From Valorant presence; empty while offline (the UI keeps the last one seen). */
  playerCardId?: string;
  isOnline: boolean;
  presenceState: ChatPresenceState;
};

export type ChatPresenceResource = Pick<
  ChatFriend,
  "puuid" | "product" | "status" | "statusMessage" | "sessionLoopState"
> & {
  resource: string;
  private: unknown;
};

export type ChatPresenceSnapshot = {
  state: ChatPresenceState;
  generation: number;
  friends: Record<string, ChatPresenceResource[]>;
};

export type ChatResponse =
  | {
      success: true;
      messages: ChatMessage[];
      rooms: ChatRooms;
      conversations: ChatConversation[];
      friends: ChatFriend[];
      fetchedAt: string;
      ownerPuuid?: string;
      savedMatches?: SavedChatMatch[];
      savedHistoryError?: string | null;
    }
  | { success: false; code: "loginRequired" }
  | { success: false; error: string };

export type SavedChatMatch = {
  matchUuid: string;
  updatedAt: number;
  messages: ChatMessage[];
};

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
  | {
      success: true;
      translatedText: string;
      provider: TranslatorProvider;
      sourceLanguage: string;
      targetLanguage: string;
    }
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
