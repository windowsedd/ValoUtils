import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@/types/chat";
import { chatControllerReducer, initialChatControllerState } from "./chat-controller-state";

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
	id: "message-1",
	conversationId: "party@ares-parties.ap",
	sender: "friend",
	senderName: "Friend",
	body: "queue?",
	timestamp: "2000",
	type: "groupchat",
	scope: "party",
	isSelf: false,
	...overrides,
});

describe("chat controller state", () => {
	test("stores a completed history request under its own cid without changing selection", () => {
		const selected = {
			...initialChatControllerState,
			selectedCid: "new-cid",
			historyLoadingByCid: { "old-cid": "history-old" },
		};
		const result = chatControllerReducer(selected, {
			type: "historySucceeded",
			cid: "old-cid",
			requestId: "history-old",
			messages: [message({ conversationId: "old-cid" })],
		});
		expect(result.selectedCid).toBe("new-cid");
		expect(result.historyByCid["old-cid"]?.map((item) => item.id)).toEqual(["message-1"]);
		expect(result.historyLoadingByCid["old-cid"]).toBeUndefined();
	});

	test("ignores a history response superseded by a newer request", () => {
		const selected = {
			...initialChatControllerState,
			historyLoadingByCid: { room: "history-new" },
		};
		const result = chatControllerReducer(selected, {
			type: "historySucceeded",
			cid: "room",
			requestId: "history-old",
			messages: [message({ conversationId: "room" })],
		});
		expect(result).toBe(selected);
	});

	test("retains draft after send failure", () => {
		const sending = {
			...initialChatControllerState,
			selectedCid: "room",
			draft: "keep me",
			pendingSendId: "send-1",
		};
		const result = chatControllerReducer(sending, {
			type: "sendFailed",
			requestId: "send-1",
			error: "offline",
		});
		expect(result.draft).toBe("keep me");
		expect(result.pendingSendId).toBeNull();
		expect(result.sendError).toBe("offline");
	});

	test("clears draft only for the matching successful send", () => {
		const sending = {
			...initialChatControllerState,
			draft: "sent",
			pendingSendId: "send-2",
		};
		const ignored = chatControllerReducer(sending, {
			type: "sendSucceeded",
			requestId: "send-1",
		});
		const completed = chatControllerReducer(sending, {
			type: "sendSucceeded",
			requestId: "send-2",
		});
		expect(ignored).toBe(sending);
		expect(completed.draft).toBe("");
		expect(completed.pendingSendId).toBeNull();
	});

	test("merges a realtime message into its cid without switching selection or unread state", () => {
		const selected = {
			...initialChatControllerState,
			selectedChannel: "friends" as const,
			selectedCid: "friend-cid",
		};
		const result = chatControllerReducer(selected, {
			type: "realtimeMessage",
			message: message(),
		});
		expect(result.selectedChannel).toBe("friends");
		expect(result.selectedCid).toBe("friend-cid");
		expect(result.historyByCid["party@ares-parties.ap"]?.map((item) => item.id)).toEqual([
			"message-1",
		]);
	});

	test("merges one summary batch into separate cid caches", () => {
		const result = chatControllerReducer(initialChatControllerState, {
			type: "summaryMessages",
			messages: [
				message({ id: "party", conversationId: "party@ares-parties.ap" }),
				message({ id: "team", conversationId: "game-blue@ares-coregame.ap" }),
			],
		});
		expect(result.historyByCid["party@ares-parties.ap"]?.map((item) => item.id)).toEqual([
			"party",
		]);
		expect(result.historyByCid["game-blue@ares-coregame.ap"]?.map((item) => item.id)).toEqual([
			"team",
		]);
	});
});
