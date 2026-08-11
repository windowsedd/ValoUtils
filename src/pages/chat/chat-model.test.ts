import { describe, expect, test } from "bun:test";
import type { ChatFriend, ChatMessage } from "@/types/chat";
import {
	buildFriendConversations,
	channelForCid,
	filterChatFriends,
	filterFriendConversations,
	findFriendConversationCid,
	mergeChatMessages,
	shouldStickToBottom,
} from "./chat-model";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
	id: "m-1",
	conversationId: "friend-cid",
	sender: "friend-puuid",
	senderName: "ALEKSANDAR",
	body: "hello",
	timestamp: "1000",
	type: "chat",
	scope: "friends",
	isSelf: false,
	...overrides,
});

const friend: ChatFriend = {
	puuid: "friend-puuid",
	gameName: "ALEKSANDAR",
	tagLine: "4830",
	displayName: "ALEKSANDAR#4830",
	note: "我能架住",
	status: "chat",
	statusMessage: "",
	product: "valorant",
	queueId: "competitive",
	partyId: "party-1",
	partySize: 2,
	maxPartySize: 5,
	isOnline: true,
};

describe("chat model", () => {
	test("merges REST and XMPP messages by cid and id in chronological order", () => {
		const result = mergeChatMessages(
			[message({ id: "older", timestamp: "1000" })],
			[
				message({ id: "older", timestamp: "1000" }),
				message({ id: "newer", timestamp: "2000" }),
			],
		);
		expect(result.map((item) => item.id)).toEqual(["older", "newer"]);
	});

	test("uses sender, timestamp, and body when Riot omits a message id", () => {
		const result = mergeChatMessages(
			[message({ id: "", timestamp: "1000" })],
			[message({ id: "", timestamp: "1000" })],
		);
		expect(result).toHaveLength(1);
	});

	test("sorts friend conversations by newest message", () => {
		const groups = buildFriendConversations([
			message({ id: "one", conversationId: "one", timestamp: "1000" }),
			message({ id: "two", conversationId: "two", timestamp: "3000", senderName: "SULAGE" }),
		]);
		expect(groups.map((group) => group.cid)).toEqual(["two", "one"]);
	});

	test("keeps Riot-provided direct conversations before history has messages", () => {
		const conversations = buildFriendConversations([], [
			{
				cid: "direct-cid",
				channel: "friends",
				type: "chat",
				title: "ALEKSANDAR#4830",
				participantPuuid: "friend-puuid",
				unreadCount: 0,
				messageHistory: true,
				muted: false,
			},
		]);
		expect(conversations).toHaveLength(1);
		expect(conversations[0]?.cid).toBe("direct-cid");
		expect(conversations[0]?.messages).toEqual([]);
	});

	test("searches friends by Riot ID and note", () => {
		expect(filterChatFriends([friend], "4830")).toHaveLength(1);
		expect(filterChatFriends([friend], "架住")).toHaveLength(1);
		expect(filterChatFriends([friend], "missing")).toHaveLength(0);
	});

	test("matches a friend only to a Riot-provided direct conversation", () => {
		const conversations = [
			{
				cid: "friend-puuid@chat.ap",
				channel: "friends" as const,
				type: "chat" as const,
				title: "ALEKSANDAR#4830",
				participantPuuid: "friend-puuid",
				unreadCount: 0,
				messageHistory: true,
				muted: false,
			},
		];
		expect(findFriendConversationCid(friend, conversations)).toBe("friend-puuid@chat.ap");
		expect(findFriendConversationCid({ ...friend, puuid: "other" }, conversations)).toBeNull();
	});

	test("searches direct conversations by the matched friend note", () => {
		const conversations = buildFriendConversations(
			[message({ conversationId: "friend-puuid@chat.ap" })],
			[
				{
					cid: "friend-puuid@chat.ap",
					channel: "friends",
					type: "chat",
					title: "ALEKSANDAR#4830",
					participantPuuid: "friend-puuid",
					unreadCount: 0,
					messageHistory: true,
					muted: false,
				},
			],
		);
		expect(filterFriendConversations(conversations, [friend], "架住")).toHaveLength(1);
		expect(filterFriendConversations(conversations, [friend], "missing")).toHaveLength(0);
	});

	test("classifies only exact Riot room families", () => {
		expect(channelForCid("party@ares-parties.ap")).toBe("party");
		expect(channelForCid("match-blue@ares-coregame.ap")).toBe("team");
		expect(channelForCid("match-red@ares-pregame.ap")).toBe("team");
		expect(channelForCid("match-all@ares-coregame.ap")).toBe("all");
		expect(channelForCid("friend-cid")).toBe("friends");
	});

	test("sticks only near the bottom or after own send", () => {
		expect(
			shouldStickToBottom({ scrollHeight: 1000, scrollTop: 650, clientHeight: 300 }, false),
		).toBe(true);
		expect(
			shouldStickToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 }, false),
		).toBe(false);
		expect(
			shouldStickToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 }, true),
		).toBe(true);
	});
});
