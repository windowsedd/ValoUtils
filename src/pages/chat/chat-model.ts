import type {
	ChatChannel,
	ChatConversation,
	ChatFriend,
	ChatMessage,
} from "@/types/chat";

export type FriendConversation = {
	cid: string;
	title: string;
	participantPuuid: string;
	unreadCount: number;
	latestTime: number;
	messages: ChatMessage[];
};

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

export const mergeChatMessages = (...sets: ChatMessage[][]) => {
	const byKey = new Map<string, ChatMessage>();
	for (const item of sets.flat()) {
		const key = item.id ? `${item.conversationId}:${item.id}` : fallbackKey(item);
		byKey.set(key, { ...byKey.get(key), ...item });
	}
	return [...byKey.values()].sort(
		(a, b) => messageTime(a) - messageTime(b) || a.id.localeCompare(b.id),
	);
};

export const buildFriendConversations = (
	messages: ChatMessage[],
	metadata: ChatConversation[] = [],
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
			return {
				cid,
				title: conversation?.title || other?.senderName || other?.sender || cid,
				participantPuuid: conversation?.participantPuuid || "",
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
