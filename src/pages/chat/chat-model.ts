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

export const shouldStickToBottom = (metrics: ScrollMetrics, sentBySelf: boolean) =>
	sentBySelf || metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 64;

export const shouldResetThreadPosition = (
	previousCid: string | null,
	nextCid: string | null,
) => previousCid !== nextCid;
