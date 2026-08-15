import { describe, expect, test } from "bun:test";
import type { ChatFriend, ChatMessage } from "@/types/chat";
import * as chatModel from "./chat-model";
import {
	buildFriendConversations,
	channelForCid,
	chatMessageKey,
	filterChatFriends,
	filterFriendConversations,
	findFriendConversationCid,
	formatClock,
	mergeChatMessages,
	resolveFriendGameStatus,
	supportsConversationHistory,
	shouldStickToBottom,
	shouldResetThreadPosition,
	startsMessageGroup,
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
	sessionLoopState: "",
	product: "valorant",
	queueId: "competitive",
	partyId: "party-1",
	partySize: 2,
	maxPartySize: 5,
	isOnline: true,
	presenceState: "ready",
};

describe("chat model", () => {
	test("resolves a party PUUID sender to the friend's Riot id", () => {
		const named = chatModel.resolveSenderName(
			message({
				sender: "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1",
				senderName: "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1",
			}),
			[
				{
					...friend,
					puuid: "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1",
					displayName: "習慣被依賴づ#JP1",
				},
			],
		);
		expect(named).toBe("習慣被依賴づ#JP1");
	});

	test("keeps a real game name instead of looking it up", () => {
		expect(chatModel.resolveSenderName(message({ senderName: "Friend" }), [])).toBe(
			"Friend",
		);
	});

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

	test("scopes Riot message ids to their conversation", () => {
		const first = message({ id: "same", conversationId: "cid-a" });
		const second = message({ id: "same", conversationId: "cid-b" });
		expect(chatMessageKey(first)).not.toBe(chatMessageKey(second));
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
				supportsHistory: true,
			},
		]);
		expect(conversations).toHaveLength(1);
		expect(conversations[0]?.cid).toBe("direct-cid");
		expect(conversations[0]?.messages).toEqual([]);
	});

	test("labels a self-only direct conversation from the matched friend", () => {
		const conversations = buildFriendConversations(
			[
				message({
					conversationId: "friend-puuid@jp1.pvp.net",
					sender: "self-puuid",
					senderName: "Me",
					isSelf: true,
				}),
			],
			[
				{
					cid: "friend-puuid@jp1.pvp.net",
					channel: "friends",
					type: "chat",
					title: "",
					participantPuuid: "friend-puuid",
					unreadCount: 0,
					messageHistory: true,
					muted: false,
					supportsHistory: true,
				},
			],
			[friend],
		);
		expect(conversations[0]?.title).toBe("ALEKSANDAR#4830");
	});

	test("resolves localized friend game status keys in priority order", () => {
		expect(resolveFriendGameStatus({ ...friend, isOnline: false })).toBe("offline");
		expect(
			resolveFriendGameStatus({ ...friend, sessionLoopState: "INGAME", status: "away" }),
		).toBe("inMatch");
		expect(
			resolveFriendGameStatus({ ...friend, sessionLoopState: "PREGAME", status: "away" }),
		).toBe("agentSelect");
		expect(
			resolveFriendGameStatus({ ...friend, sessionLoopState: "MENUS", status: "away" }),
		).toBe("inLobby");
		expect(resolveFriendGameStatus({ ...friend, status: "away" })).toBe("away");
		expect(resolveFriendGameStatus({ ...friend, status: "chat" })).toBe("online");
	});

	test("sync state has priority over stale online data", () => {
		expect(
			resolveFriendGameStatus({ ...friend, presenceState: "syncing", isOnline: true }),
		).toBe("checking");
		expect(
			resolveFriendGameStatus({ ...friend, presenceState: "reconnecting", isOnline: true }),
		).toBe("reconnecting");
	});

	test("applies a ready snapshot and offlines absent friends", () => {
		expect(typeof chatModel.applyPresenceSnapshot).toBe("function");
		const result = chatModel.applyPresenceSnapshot(
			[friend, { ...friend, puuid: "offline" }],
			{
				state: "ready",
				generation: 2,
				friends: {
					[friend.puuid]: [
						{
							puuid: friend.puuid,
							resource: "RC-1",
							product: "valorant",
							status: "chat",
							statusMessage: "",
							sessionLoopState: "INGAME",
							private: {},
						},
					],
				},
			},
		);

		expect(result[0]).toMatchObject({
			presenceState: "ready",
			isOnline: true,
			sessionLoopState: "INGAME",
		});
		expect(result[1]).toMatchObject({ presenceState: "ready", isOnline: false });
	});

	test("attaches the matched friend's status to a direct conversation", () => {
		const result = buildFriendConversations(
			[],
			[
				{
					cid: "friend-puuid@jp1.pvp.net",
					channel: "friends",
					type: "chat",
					title: "",
					participantPuuid: "friend-puuid",
					unreadCount: 0,
					messageHistory: true,
					muted: false,
					supportsHistory: true,
				},
			],
			[{ ...friend, sessionLoopState: "INGAME" }],
		);

		expect(result[0]?.statusKey).toBe("inMatch");
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
				supportsHistory: true,
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
					supportsHistory: true,
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

	test("requests REST history only for supported direct conversations", () => {
		expect(
			supportsConversationHistory({
				cid: "friend@jp1.pvp.net",
				channel: "friends",
				type: "chat",
				title: "",
				participantPuuid: "friend",
				unreadCount: 0,
				messageHistory: true,
				muted: false,
				supportsHistory: true,
			}),
		).toBe(true);
		expect(
			supportsConversationHistory({
				cid: "game-blue@ares-coregame.jp1.pvp.net",
				channel: "team",
				type: "groupchat",
				title: "",
				participantPuuid: "",
				unreadCount: 0,
				messageHistory: null,
				muted: false,
				supportsHistory: false,
			}),
		).toBe(false);
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

	test("resets thread position only when the selected cid changes", () => {
		expect(shouldResetThreadPosition("friend-a", "friend-b")).toBe(true);
		expect(shouldResetThreadPosition("friend-a", "friend-a")).toBe(false);
	});

	test("clock readings stay one fixed width so the transcript gutter can't wrap", () => {
		const morning = formatClock(Date.UTC(2026, 7, 15, 4, 5));
		const evening = formatClock(Date.UTC(2026, 7, 15, 21, 24));

		expect(morning).toMatch(/^\d{2}:\d{2}$/);
		expect(evening).toMatch(/^\d{2}:\d{2}$/);
		expect(evening.length).toBe(morning.length);
		expect(evening).not.toContain("M");
	});

	test("clock reading is empty for missing or unparseable timestamps", () => {
		expect(formatClock(null)).toBe("");
		expect(formatClock(undefined)).toBe("");
		expect(formatClock("")).toBe("");
		expect(formatClock(0)).toBe("");
		expect(formatClock("not a date")).toBe("");
	});

	test("groups consecutive messages from one sender inside the burst window", () => {
		const first = message({ id: "m-1", timestamp: "1000000" });
		const soon = message({ id: "m-2", timestamp: "1060000" });
		const late = message({ id: "m-3", timestamp: "1400000" });
		const other = message({ id: "m-4", sender: "other-puuid", timestamp: "1060000" });

		expect(startsMessageGroup(undefined, first)).toBe(true);
		expect(startsMessageGroup(first, soon)).toBe(false);
		expect(startsMessageGroup(first, late)).toBe(true);
		expect(startsMessageGroup(first, other)).toBe(true);
	});

	test("starts a new group when timestamps are missing or run backwards", () => {
		const first = message({ id: "m-1", timestamp: "1000000" });
		const backwards = message({ id: "m-2", timestamp: "900000" });
		const undated = message({ id: "m-3", timestamp: "" });

		expect(startsMessageGroup(first, backwards)).toBe(true);
		expect(startsMessageGroup(first, undated)).toBe(true);
	});
});
