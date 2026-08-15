import type {
	ChatChannel,
	ChatConversation,
	ChatFriend,
	ChatMessage,
	ChatPresenceSnapshot,
} from "@/types/chat";

export type FriendConversation = {
	cid: string;
	title: string;
	participantPuuid: string;
	statusKey: FriendGameStatus;
	unreadCount: number;
	latestTime: number;
	messages: ChatMessage[];
};

export type FriendGameStatus =
	| "offline"
	| "checking"
	| "reconnecting"
	| "inMatch"
	| "agentSelect"
	| "inLobby"
	| "away"
	| "online";

export const resolveFriendGameStatus = (
	friend: ChatFriend | undefined,
): FriendGameStatus => {
	if (friend?.presenceState === "syncing") return "checking";
	if (friend?.presenceState === "reconnecting") return "reconnecting";
	if (!friend?.isOnline) return "offline";
	if (friend.sessionLoopState === "INGAME") return "inMatch";
	if (friend.sessionLoopState === "PREGAME") return "agentSelect";
	if (friend.sessionLoopState === "MENUS") return "inLobby";
	if (friend.status.toLocaleLowerCase() === "away") return "away";
	return "online";
};

const presenceProductPriority = (product: string) => {
	switch (product.toLocaleLowerCase()) {
		case "valorant":
			return 3;
		case "league_of_legends":
			return 2;
		case "riot_client":
		case "keystone":
			return 1;
		default:
			return 0;
	}
};

export const applyPresenceSnapshot = (
	friends: ChatFriend[],
	snapshot: ChatPresenceSnapshot,
): ChatFriend[] =>
	friends.map((friend) => {
		const friendId = friend.puuid.toLocaleLowerCase();
		const resources =
			Object.entries(snapshot.friends).find(
				([puuid]) => puuid.toLocaleLowerCase() === friendId,
			)?.[1] ?? [];
		const selected = [...resources].sort(
			(left, right) =>
				presenceProductPriority(right.product) - presenceProductPriority(left.product),
		)[0];
		const ready = snapshot.state === "ready";
		return {
			...friend,
			presenceState: snapshot.state,
			isOnline: ready && resources.length > 0,
			product: ready ? (selected?.product ?? "") : "",
			status: ready ? (selected?.status ?? "offline") : "offline",
			statusMessage: ready ? (selected?.statusMessage ?? "") : "",
			sessionLoopState: ready ? (selected?.sessionLoopState ?? "") : "",
		};
	});

type ScrollMetrics = {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
};

const messageTime = (message: ChatMessage) => {
	const numeric = Number(message.timestamp);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = message.timestamp ? Date.parse(message.timestamp) : 0;
	return Number.isNaN(parsed) ? 0 : parsed;
};

const fallbackKey = (message: ChatMessage) =>
	`${message.conversationId}:${message.timestamp ?? ""}:${message.sender}:${message.body}`;

export const chatMessageKey = (message: ChatMessage) =>
	message.id ? `${message.conversationId}:${message.id}` : fallbackKey(message);

/**
 * Clock reading for the transcript gutter and the conversation list.
 *
 * Always 24-hour. A log column has to be one fixed width or the whole ruler
 * bends, and localised 12-hour time is 8 characters ("09:24 PM") against 5
 * ("21:24") — it wrapped the gutter onto two lines and doubled every row.
 */
export const formatClock = (value: string | number | null | undefined) => {
	// A conversation with no messages carries latestTime 0. Epoch zero is never a
	// real chat timestamp, so it reads as "no time" rather than "00:00".
	if (value === null || value === undefined || value === "" || value === 0) return "";
	const numeric = Number(value);
	const date = new Date(Number.isFinite(numeric) ? numeric : String(value));
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
};

/** Messages closer together than this read as one burst from the same speaker. */
const groupWindowMs = 5 * 60 * 1000;

/**
 * Whether a message opens a new group in the transcript — i.e. whether it needs
 * its own sender header. Consecutive messages from one person inside the group
 * window hang under the first, so a burst reads as a burst.
 */
export const startsMessageGroup = (
	previous: ChatMessage | undefined,
	current: ChatMessage,
) => {
	if (!previous) return true;
	if (previous.sender !== current.sender) return true;
	const gap = messageTime(current) - messageTime(previous);
	return !(gap >= 0 && gap < groupWindowMs);
};

export const mergeChatMessages = (...sets: ChatMessage[][]) => {
	const byKey = new Map<string, ChatMessage>();
	for (const item of sets.flat()) {
		const key = chatMessageKey(item);
		byKey.set(key, { ...byKey.get(key), ...item });
	}
	return [...byKey.values()].sort(
		(a, b) => messageTime(a) - messageTime(b) || a.id.localeCompare(b.id),
	);
};

export const buildFriendConversations = (
	messages: ChatMessage[],
	metadata: ChatConversation[] = [],
	friends: ChatFriend[] = [],
): FriendConversation[] => {
	const grouped = new Map<string, ChatMessage[]>();
	for (const item of messages.filter(
		(entry) => entry.scope === "friends" && entry.conversationId,
	)) {
		grouped.set(item.conversationId, [...(grouped.get(item.conversationId) ?? []), item]);
	}
	for (const conversation of metadata) {
		if (conversation.channel === "friends" && conversation.cid && !grouped.has(conversation.cid)) {
			grouped.set(conversation.cid, []);
		}
	}
	return [...grouped.entries()]
		.map(([cid, values]) => {
			const ordered = mergeChatMessages(values);
			const other = [...ordered].reverse().find((entry) => !entry.isSelf);
			const conversation = metadata.find((item) => item.cid === cid);
			const participant = idRoot(conversation?.participantPuuid || cid);
			const friend = friends.find((item) => idRoot(item.puuid) === participant);
			return {
				cid,
				title:
					conversation?.title || friend?.displayName || other?.senderName || other?.sender || cid,
				participantPuuid: conversation?.participantPuuid || "",
				statusKey: resolveFriendGameStatus(friend),
				unreadCount: conversation?.unreadCount ?? 0,
				latestTime: Math.max(0, ...ordered.map(messageTime)),
				messages: ordered,
			};
		})
		.sort((a, b) => b.latestTime - a.latestTime || a.title.localeCompare(b.title));
};

export const filterChatFriends = (friends: ChatFriend[], search: string) => {
	const query = search.trim().toLocaleLowerCase();
	if (!query) return friends;
	return friends.filter((friend) =>
		`${friend.displayName} ${friend.gameName} ${friend.tagLine} ${friend.note}`
			.toLocaleLowerCase()
			.includes(query),
	);
};

const idRoot = (value: string) => value.split("@")[0].toLocaleLowerCase();

const looksLikePuuid = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		idRoot(value),
	);

/** Party/team/all MUC nicks are PUUIDs. Prefer a friend's Riot id when we have one. */
export const resolveSenderName = (message: ChatMessage, friends: ChatFriend[]) => {
	const labeled = message.senderName.trim();
	if (labeled && !looksLikePuuid(labeled)) return labeled;
	const root = idRoot(message.sender || labeled);
	const friend = friends.find((item) => idRoot(item.puuid) === root);
	return friend?.displayName || labeled || message.sender;
};

export const withResolvedSenderNames = (messages: ChatMessage[], friends: ChatFriend[]) =>
	messages.map((message) => ({
		...message,
		senderName: resolveSenderName(message, friends),
	}));

export const filterFriendConversations = (
	conversations: FriendConversation[],
	friends: ChatFriend[],
	search: string,
) => {
	const query = search.trim().toLocaleLowerCase();
	if (!query) return conversations;
	return conversations.filter((conversation) => {
		const participant = idRoot(conversation.participantPuuid);
		const friend = friends.find((item) => idRoot(item.puuid) === participant);
		const searchable = [
			conversation.title,
			conversation.participantPuuid,
			friend?.displayName,
			friend?.gameName,
			friend?.tagLine,
			friend?.note,
		]
			.filter(Boolean)
			.join(" ")
			.toLocaleLowerCase();
		return searchable.includes(query);
	});
};

export const findFriendConversationCid = (
	friend: ChatFriend,
	conversations: ChatConversation[],
) =>
	conversations.find(
		(conversation) =>
			conversation.channel === "friends" &&
			idRoot(conversation.participantPuuid) === idRoot(friend.puuid),
	)?.cid ?? null;

export const channelForCid = (cid: string): ChatChannel => {
	const value = cid.toLocaleLowerCase();
	if (value.includes("@ares-parties.")) return "party";
	if (/-(blue|red)@ares-(coregame|pregame)\./.test(value)) return "team";
	if (/-all@ares-coregame\./.test(value)) return "all";
	return "friends";
};

export const supportsConversationHistory = (
	conversation: ChatConversation | null | undefined,
) => conversation?.supportsHistory === true;

export const shouldStickToBottom = (metrics: ScrollMetrics, sentBySelf: boolean) =>
	sentBySelf || metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 64;

export const shouldResetThreadPosition = (
	previousCid: string | null,
	nextCid: string | null,
) => previousCid !== nextCid;
