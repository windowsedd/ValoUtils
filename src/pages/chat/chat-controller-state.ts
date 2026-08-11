import type { ChatChannel, ChatMessage } from "@/types/chat";
import { mergeChatMessages } from "./chat-model";

export type ChatControllerState = {
	selectedChannel: ChatChannel;
	selectedCid: string | null;
	historyByCid: Record<string, ChatMessage[]>;
	historyLoadingByCid: Record<string, string | undefined>;
	historyErrorByCid: Record<string, string | undefined>;
	draft: string;
	pendingSendId: string | null;
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
	| { type: "sendStarted"; requestId: string }
	| { type: "sendSucceeded"; requestId: string }
	| { type: "sendFailed"; requestId: string; error: string }
	| { type: "realtimeMessage"; message: ChatMessage };

const withoutKey = <T>(record: Record<string, T>, key: string) => {
	const next = { ...record };
	delete next[key];
	return next;
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
						state.historyByCid[action.cid] ?? [],
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
			return { ...state, pendingSendId: action.requestId, sendError: null };
		case "sendSucceeded":
			if (state.pendingSendId !== action.requestId) return state;
			return { ...state, draft: "", pendingSendId: null, sendError: null };
		case "sendFailed":
			if (state.pendingSendId !== action.requestId) return state;
			return {
				...state,
				pendingSendId: null,
				sendError: action.error,
			};
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
