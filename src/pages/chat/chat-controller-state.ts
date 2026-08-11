import type { ChatChannel, ChatMessage } from "@/types/chat";
import { channelForCid, mergeChatMessages } from "./chat-model";

export type ChatControllerState = {
	selectedChannel: ChatChannel;
	selectedCid: string | null;
	historyByCid: Record<string, ChatMessage[]>;
	historyLoadingByCid: Record<string, string | undefined>;
	historyErrorByCid: Record<string, string | undefined>;
	draft: string;
	pendingSendId: string | null;
	pendingSendCid: string | null;
	pendingSendBody: string | null;
	sendError: string | null;
};

export const initialChatControllerState: ChatControllerState = {
	selectedChannel: "friends",
	selectedCid: null,
	historyByCid: {},
	historyLoadingByCid: {},
	historyErrorByCid: {},
	draft: "",
	pendingSendId: null,
	pendingSendCid: null,
	pendingSendBody: null,
	sendError: null,
};

export type ChatControllerAction =
	| { type: "selectChannel"; channel: ChatChannel; cid: string | null }
	| { type: "selectConversation"; cid: string }
	| { type: "historyStarted"; cid: string; requestId: string }
	| {
			type: "historySucceeded";
			cid: string;
			requestId: string;
			messages: ChatMessage[];
	  }
	| { type: "historyFailed"; cid: string; requestId: string; error: string }
	| { type: "setDraft"; draft: string }
	| { type: "sendStarted"; requestId: string; cid: string; body: string }
	| { type: "sendSucceeded"; requestId: string; sentAt: string }
	| { type: "sendFailed"; requestId: string; error: string }
	| { type: "summaryMessages"; messages: ChatMessage[] }
	| { type: "realtimeMessage"; message: ChatMessage };

const withoutKey = <T>(record: Record<string, T>, key: string) => {
	const next = { ...record };
	delete next[key];
	return next;
};

const reconcileOptimisticMessages = (
	existing: ChatMessage[],
	incoming: ChatMessage[],
) => {
	const selfBodies = incoming.filter((message) => message.isSelf).map((message) => message.body);
	return existing.filter((message) => {
		if (message._raw?.optimistic !== true) return true;
		const match = selfBodies.indexOf(message.body);
		if (match < 0) return true;
		selfBodies.splice(match, 1);
		return false;
	});
};

export const chatControllerReducer = (
	state: ChatControllerState,
	action: ChatControllerAction,
): ChatControllerState => {
	switch (action.type) {
		case "selectChannel":
			return {
				...state,
				selectedChannel: action.channel,
				selectedCid: action.cid,
				sendError: null,
			};
		case "selectConversation":
			return { ...state, selectedChannel: "friends", selectedCid: action.cid, sendError: null };
		case "historyStarted":
			return {
				...state,
				historyLoadingByCid: {
					...state.historyLoadingByCid,
					[action.cid]: action.requestId,
				},
				historyErrorByCid: withoutKey(state.historyErrorByCid, action.cid),
			};
		case "historySucceeded":
			if (state.historyLoadingByCid[action.cid] !== action.requestId) return state;
			return {
				...state,
				historyByCid: {
					...state.historyByCid,
					[action.cid]: mergeChatMessages(
						reconcileOptimisticMessages(
							state.historyByCid[action.cid] ?? [],
							action.messages,
						),
						action.messages,
					),
				},
				historyLoadingByCid: withoutKey(state.historyLoadingByCid, action.cid),
				historyErrorByCid: withoutKey(state.historyErrorByCid, action.cid),
			};
		case "historyFailed":
			if (state.historyLoadingByCid[action.cid] !== action.requestId) return state;
			return {
				...state,
				historyLoadingByCid: withoutKey(state.historyLoadingByCid, action.cid),
				historyErrorByCid: {
					...state.historyErrorByCid,
					[action.cid]: action.error,
				},
			};
		case "setDraft":
			return { ...state, draft: action.draft };
		case "sendStarted":
			if (state.pendingSendId) return state;
			return {
				...state,
				pendingSendId: action.requestId,
				pendingSendCid: action.cid,
				pendingSendBody: action.body,
				sendError: null,
			};
		case "sendSucceeded":
			if (state.pendingSendId !== action.requestId) return state;
			if (!state.pendingSendCid || !state.pendingSendBody) {
				return {
					...state,
					draft: "",
					pendingSendId: null,
					pendingSendCid: null,
					pendingSendBody: null,
					sendError: null,
				};
			}
			const pendingChannel = channelForCid(state.pendingSendCid);
			return {
				...state,
				historyByCid: {
					...state.historyByCid,
					[state.pendingSendCid]: mergeChatMessages(
						state.historyByCid[state.pendingSendCid] ?? [],
						[
							{
								id: `optimistic:${action.requestId}`,
								conversationId: state.pendingSendCid,
								sender: "",
								senderName: "",
								body: state.pendingSendBody,
								timestamp: action.sentAt,
								type: pendingChannel === "friends" ? "chat" : "groupchat",
								scope:
									pendingChannel === "friends"
										? "friends"
										: pendingChannel === "party"
											? "party"
											: "match",
								isSelf: true,
								_raw: { optimistic: true, requestId: action.requestId },
							},
						],
					),
				},
				draft: "",
				pendingSendId: null,
				pendingSendCid: null,
				pendingSendBody: null,
				sendError: null,
			};
		case "sendFailed":
			if (state.pendingSendId !== action.requestId) return state;
			return {
				...state,
				pendingSendId: null,
				pendingSendCid: null,
				pendingSendBody: null,
				sendError: action.error,
			};
		case "summaryMessages": {
			const grouped = new Map<string, ChatMessage[]>();
			for (const message of action.messages) {
				if (!message.conversationId) continue;
				grouped.set(message.conversationId, [
					...(grouped.get(message.conversationId) ?? []),
					message,
				]);
			}
			const historyByCid = { ...state.historyByCid };
			for (const [cid, messages] of grouped) {
				historyByCid[cid] = mergeChatMessages(historyByCid[cid] ?? [], messages);
			}
			return { ...state, historyByCid };
		}
		case "realtimeMessage": {
			const cid = action.message.conversationId;
			if (!cid) return state;
			return {
				...state,
				historyByCid: {
					...state.historyByCid,
					[cid]: mergeChatMessages(state.historyByCid[cid] ?? [], [action.message]),
				},
			};
		}
	}
};
