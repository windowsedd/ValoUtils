import type { ChatChannel, ChatMessage } from "@/types/chat";
import { channelForCid, chatMessageKey, mergeChatMessages } from "./chat-model";

export type ChatControllerState = {
  selectedChannel: ChatChannel;
  selectedCid: string | null;
  historyByCid: Record<string, ChatMessage[]>;
  historyLoadingByCid: Record<string, string | undefined>;
  historyErrorByCid: Record<string, string | undefined>;
  draftByCid: Record<string, string | undefined>;
  pendingSendId: string | null;
  pendingSendCid: string | null;
  pendingSendBody: string | null;
  pendingSendKnownMessageKeys: string[];
  sendErrorByCid: Record<string, string | undefined>;
  /**
   * Local-only command results, per room.
   *
   * Kept out of `historyByCid` on purpose: these were never sent to anyone,
   * so a history refresh or a poll must not be able to overwrite them, and
   * they must never reach the merge that reconciles real messages.
   */
  systemByCid: Record<string, SystemLine[] | undefined>;
};

export type SystemLine = {
  id: string;
  /** What the player typed, echoed so the result has context. */
  command: string;
  body: string;
  failed: boolean;
};

export const initialChatControllerState: ChatControllerState = {
  selectedChannel: "friends",
  selectedCid: null,
  historyByCid: {},
  historyLoadingByCid: {},
  historyErrorByCid: {},
  draftByCid: {},
  pendingSendId: null,
  pendingSendCid: null,
  pendingSendBody: null,
  pendingSendKnownMessageKeys: [],
  sendErrorByCid: {},
  systemByCid: {},
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
  | { type: "setDraft"; cid: string; draft: string }
  | { type: "sendStarted"; requestId: string; cid: string; body: string }
  | { type: "sendSucceeded"; requestId: string; sentAt: string }
  | { type: "sendFailed"; requestId: string; error: string }
  | { type: "summaryMessages"; messages: ChatMessage[] }
  | { type: "realtimeMessage"; message: ChatMessage }
  | {
      type: "commandResult";
      cid: string;
      id: string;
      command: string;
      body: string;
      failed: boolean;
    };

/** Plenty for a session's worth of commands, bounded so the thread can't grow forever. */
const MAX_SYSTEM_LINES = 50;

const withoutKey = <T>(record: Record<string, T>, key: string) => {
  const next = { ...record };
  delete next[key];
  return next;
};

const reconcileOptimisticMessages = (existing: ChatMessage[], incoming: ChatMessage[]) => {
  const selfMessages = incoming.filter((message) => message.isSelf);
  const timestamp = (message: ChatMessage) => {
    const numeric = Number(message.timestamp);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = message.timestamp ? Date.parse(message.timestamp) : 0;
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return existing.filter((message) => {
    if (message._raw?.optimistic !== true) return true;
    const knownMessageKeys = new Set<string>(message._raw?.knownServerMessageKeys ?? []);
    const optimisticTime = timestamp(message);
    const match = selfMessages.findIndex((candidate) => {
      const candidateTime = timestamp(candidate);
      return (
        !knownMessageKeys.has(chatMessageKey(candidate)) &&
        candidate.body === message.body &&
        optimisticTime > 0 &&
        candidateTime > 0 &&
        Math.abs(candidateTime - optimisticTime) <= 30_000
      );
    });
    if (match < 0) return true;
    selfMessages.splice(match, 1);
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
      };
    case "selectConversation":
      return { ...state, selectedChannel: "friends", selectedCid: action.cid };
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
            reconcileOptimisticMessages(state.historyByCid[action.cid] ?? [], action.messages),
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
      return {
        ...state,
        draftByCid: { ...state.draftByCid, [action.cid]: action.draft },
      };
    case "sendStarted":
      if (state.pendingSendId) return state;
      return {
        ...state,
        pendingSendId: action.requestId,
        pendingSendCid: action.cid,
        pendingSendBody: action.body,
        pendingSendKnownMessageKeys: (state.historyByCid[action.cid] ?? [])
          .filter((message) => message._raw?.optimistic !== true)
          .map(chatMessageKey),
        sendErrorByCid: withoutKey(state.sendErrorByCid, action.cid),
      };
    case "sendSucceeded":
      if (state.pendingSendId !== action.requestId) return state;
      if (!state.pendingSendCid || !state.pendingSendBody) {
        return {
          ...state,
          pendingSendId: null,
          pendingSendCid: null,
          pendingSendBody: null,
          pendingSendKnownMessageKeys: [],
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
                _raw: {
                  optimistic: true,
                  requestId: action.requestId,
                  knownServerMessageKeys: state.pendingSendKnownMessageKeys,
                },
              },
            ],
          ),
        },
        draftByCid: withoutKey(state.draftByCid, state.pendingSendCid),
        pendingSendId: null,
        pendingSendCid: null,
        pendingSendBody: null,
        pendingSendKnownMessageKeys: [],
        sendErrorByCid: withoutKey(state.sendErrorByCid, state.pendingSendCid),
      };
    case "sendFailed":
      if (state.pendingSendId !== action.requestId) return state;
      if (!state.pendingSendCid) {
        return {
          ...state,
          pendingSendId: null,
          pendingSendBody: null,
          pendingSendKnownMessageKeys: [],
        };
      }
      return {
        ...state,
        sendErrorByCid: {
          ...state.sendErrorByCid,
          [state.pendingSendCid]: action.error,
        },
        pendingSendId: null,
        pendingSendCid: null,
        pendingSendBody: null,
        pendingSendKnownMessageKeys: [],
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
    case "commandResult": {
      const existing = state.systemByCid[action.cid] ?? [];
      return {
        ...state,
        systemByCid: {
          ...state.systemByCid,
          // Bounded so a long session of commands cannot grow the
          // thread without limit.
          [action.cid]: [
            ...existing,
            {
              id: action.id,
              command: action.command,
              body: action.body,
              failed: action.failed,
            },
          ].slice(-MAX_SYSTEM_LINES),
        },
      };
    }
  }
};
