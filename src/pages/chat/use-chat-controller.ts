import type {
  ChatChannel,
  ChatConversation,
  ChatFriend,
  ChatHistoryResponse,
  ChatMessage,
  ChatPresenceSnapshot,
  ChatResponse,
  ChatSendResponse,
  TranslateResponse,
} from "@/types/chat";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { chatControllerReducer, initialChatControllerState } from "./chat-controller-state";
import {
  applyPresenceSnapshot,
  buildFriendConversations,
  chatMessageKey,
  filterChatFriends,
  filterFriendConversations,
  findFriendConversationCid,
  visibleUnreadCount,
  forgetMarkedUnreadIfCleared,
  lastConversationMessageId,
  forgetMarkedUnread,
  rememberMarkedUnread,
  sessionMarkedUnread,
  isComposerCommand,
  mergeChatMessages,
  channelForCid,
  isIgnorableHistoryError,
  messagesForConversation,
  resolveChannelCid,
  supportsConversationHistory,
  withResolvedSenderNames,
} from "./chat-model";

const POLL_MS = 5000;

type ChatSummary = Extract<ChatResponse, { success: true }>;
type FriendAction = "invite" | "join";
type FriendActionResponse =
  | { success: true; action: FriendAction }
  | { success: false; error: string };
type CommandResponse = { success: true; reply: string } | { success: false; error: string };

const emptySummary: ChatSummary = {
  success: true,
  messages: [],
  rooms: {},
  conversations: [],
  friends: [],
  fetchedAt: "",
};

let requestSequence = 0;
const nextRequestId = (kind: "history" | "send" | "translate" | "command") =>
  `${kind}-${Date.now()}-${++requestSequence}`;

const parsePayload = <T>(payload: string): T | null => {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
};

export const useChatController = () => {
  const [state, dispatch] = useReducer(chatControllerReducer, initialChatControllerState);
  const [summary, setSummary] = useState<ChatSummary>(emptySummary);
  const [loading, setLoading] = useState(true);
  const [loginRequired, setLoginRequired] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [friendSearch, setFriendSearch] = useState("");
  const [translatedByMessageId, setTranslatedByMessageId] = useState<Record<string, string>>({});
  const [translatingMessageId, setTranslatingMessageId] = useState<string | null>(null);
  const [translationErrorByMessageId, setTranslationErrorByMessageId] = useState<
    Record<string, string>
  >({});
  const [friendActionError, setFriendActionError] = useState<string | null>(null);
  const [markReadError, setMarkReadError] = useState<string | null>(null);
  const [pendingFriendAction, setPendingFriendAction] = useState<string | null>(null);
  const [markedUnreadByCid, setMarkedUnreadByCid] = useState<Record<string, number>>(() => ({
    ...sessionMarkedUnread,
  }));
  const translationMessageRef = useRef<string | null>(null);
  const commandRef = useRef<{ cid: string; command: string } | null>(null);

  const refreshSummary = useCallback(() => {
    window.Main?.send("chat:get");
  }, []);

  const requestHistory = useCallback((cid: string, supportsHistory: boolean) => {
    if (!cid || !supportsHistory || channelForCid(cid) !== "friends") return;
    const requestId = nextRequestId("history");
    dispatch({ type: "historyStarted", cid, requestId });
    window.Main.send("chat:history", requestId, cid);
  }, []);

  useEffect(() => {
    if (!window.Main) return;

    const onSummary = (payload: string) => {
      const response = parsePayload<ChatResponse>(payload);
      setLoading(false);
      if (!response) {
        setSummaryError("Invalid chat summary response.");
        return;
      }
      if (!response.success) {
        const requiresLogin = "code" in response && response.code === "loginRequired";
        setLoginRequired(requiresLogin);
        setSummaryError("error" in response ? response.error : null);
        return;
      }
      setLoginRequired(false);
      setSummaryError(null);
      setSummary(response);
      setMarkedUnreadByCid((current) =>
        forgetMarkedUnreadIfCleared(response.conversations, current),
      );
      dispatch({ type: "summaryMessages", messages: response.messages });
    };

    const onHistory = (payload: string) => {
      const response = parsePayload<ChatHistoryResponse>(payload);
      if (!response) return;
      if (response.success) {
        dispatch({
          type: "historySucceeded",
          cid: response.cid,
          requestId: response.requestId,
          messages: response.messages,
        });
        return;
      }
      if (isIgnorableHistoryError(response.error)) {
        dispatch({
          type: "historySucceeded",
          cid: response.cid,
          requestId: response.requestId,
          messages: [],
        });
        return;
      }
      dispatch({
        type: "historyFailed",
        cid: response.cid,
        requestId: response.requestId,
        error: response.error,
      });
    };

    const onRealtimeMessage = (payload: string) => {
      const message = parsePayload<ChatMessage>(payload);
      if (!message?.conversationId || !message.id) return;
      dispatch({ type: "realtimeMessage", message });
    };

    const onPresence = (payload: string) => {
      const snapshot = parsePayload<ChatPresenceSnapshot>(payload);
      if (
        !snapshot ||
        !(["syncing", "ready", "reconnecting"] as const).includes(snapshot.state) ||
        !Number.isFinite(snapshot.generation) ||
        !snapshot.friends ||
        typeof snapshot.friends !== "object"
      ) {
        return;
      }
      setSummary((current) => ({
        ...current,
        friends: applyPresenceSnapshot(current.friends, snapshot),
      }));
    };

    const onSend = (payload: string) => {
      const response = parsePayload<ChatSendResponse>(payload);
      if (!response) return;
      if (response.success) {
        dispatch({
          type: "sendSucceeded",
          requestId: response.requestId,
          sentAt: new Date().toISOString(),
        });
        requestHistory(response.cid, response.type === "chat");
        return;
      }
      dispatch({
        type: "sendFailed",
        requestId: response.requestId,
        error: response.error,
      });
    };

    const onTranslate = (payload: string) => {
      const response = parsePayload<TranslateResponse>(payload);
      const messageId = translationMessageRef.current;
      translationMessageRef.current = null;
      setTranslatingMessageId(null);
      if (!messageId) return;
      if (!response?.success) {
        setTranslationErrorByMessageId((current) => ({
          ...current,
          [messageId]: response?.error ?? "Translation failed.",
        }));
        return;
      }
      setTranslationErrorByMessageId((current) => {
        const next = { ...current };
        delete next[messageId];
        return next;
      });
      setTranslatedByMessageId((current) => ({
        ...current,
        [messageId]: response.translatedText,
      }));
    };

    const onFriendAction = (payload: string) => {
      const response = parsePayload<FriendActionResponse>(payload);
      setPendingFriendAction(null);
      if (!response) {
        setFriendActionError("Invalid friend action response.");
        return;
      }
      if (!response.success) {
        setFriendActionError(response.error);
        return;
      }
      setFriendActionError(null);
      refreshSummary();
    };

    const onMarkRead = (payload: string) => {
      const response = parsePayload<{ success: boolean; cid?: string; error?: string }>(payload);
      // A failed mark-read used to vanish: nothing listened on this channel,
      // so the badge stayed hidden while the game still showed the messages
      // as unread. Put the count back and say why.
      if (response && !response.success) {
        const cid = response.cid ?? "";
        if (cid) setMarkedUnreadByCid((current) => forgetMarkedUnread(cid, current));
        setMarkReadError(response.error || "Could not mark the conversation as read.");
        return;
      }
      setMarkReadError(null);
    };

    const onCommand = (payload: string) => {
      // The command that produced this reply — the reply itself carries no
      // room, and the player may have switched channels while it ran.
      const pending = commandRef.current;
      commandRef.current = null;
      if (!pending) return;
      const response = parsePayload<CommandResponse>(payload);
      dispatch({
        type: "commandResult",
        cid: pending.cid,
        id: nextRequestId("command"),
        command: pending.command,
        body: response
          ? response.success
            ? response.reply
            : response.error
          : "Invalid command response.",
        failed: !response?.success,
      });
    };

    window.Main.on("chat:get", onSummary);
    window.Main.on("chat:history", onHistory);
    window.Main.on("chat:message", onRealtimeMessage);
    window.Main.on("chat:presence", onPresence);
    window.Main.on("chat:send", onSend);
    window.Main.on("chat:command", onCommand);
    window.Main.on("chat:translate", onTranslate);
    window.Main.on("chat:friend-action", onFriendAction);
    window.Main.on("chat:mark-read", onMarkRead);
    refreshSummary();
    const interval = window.setInterval(refreshSummary, POLL_MS);

    return () => {
      window.clearInterval(interval);
      window.Main.removeListener("chat:get", onSummary);
      window.Main.removeListener("chat:history", onHistory);
      window.Main.removeListener("chat:message", onRealtimeMessage);
      window.Main.removeListener("chat:presence", onPresence);
      window.Main.removeListener("chat:send", onSend);
      window.Main.removeListener("chat:command", onCommand);
      window.Main.removeListener("chat:translate", onTranslate);
      window.Main.removeListener("chat:friend-action", onFriendAction);
      window.Main.removeListener("chat:mark-read", onMarkRead);
    };
  }, [refreshSummary, requestHistory]);

  // Room channels re-derive their conversation whenever the summary changes,
  // so a room that appears after the channel was selected gets adopted and a
  // room that ends gets dropped. Resolving only on click handled the second
  // case and silently missed the first.
  useEffect(() => {
    if (state.selectedChannel === "friends") return;
    const cid = resolveChannelCid(
      state.selectedChannel,
      state.selectedCid,
      summary.conversations,
      summary.rooms,
    );
    if (cid === state.selectedCid) return;
    dispatch({ type: "selectChannel", channel: state.selectedChannel, cid });
    if (cid) {
      const conversation = summary.conversations.find((item) => item.cid === cid);
      requestHistory(cid, supportsConversationHistory(conversation));
    }
  }, [
    requestHistory,
    state.selectedChannel,
    state.selectedCid,
    summary.conversations,
    summary.rooms,
  ]);

  const selectChannel = useCallback(
    (channel: ChatChannel) => {
      if (channel === "friends") {
        const cid = state.selectedChannel === "friends" ? state.selectedCid : null;
        dispatch({ type: "selectChannel", channel, cid });
        return;
      }
      const cid = resolveChannelCid(channel, null, summary.conversations, summary.rooms);
      const conversation = summary.conversations.find((item) => item.cid === cid);
      dispatch({ type: "selectChannel", channel, cid });
      if (cid) requestHistory(cid, supportsConversationHistory(conversation));
    },
    [
      requestHistory,
      state.selectedChannel,
      state.selectedCid,
      summary.conversations,
      summary.rooms,
    ],
  );

  const markConversationRead = useCallback(
    (cid: string) => {
      if (!cid) return;
      const conversation = summary.conversations.find((item) => item.cid === cid);
      const riotUnread = conversation?.unreadCount ?? 0;
      const markedAt = rememberMarkedUnread(cid, riotUnread);
      setMarkedUnreadByCid((current) =>
        current[cid] === markedAt ? current : { ...current, [cid]: markedAt },
      );
      if (riotUnread <= 0) return;
      const mid = lastConversationMessageId(
        [...summary.messages, ...(state.historyByCid[cid] ?? [])],
        cid,
        conversation?.mid ?? "",
      );
      window.Main?.send("chat:mark-read", cid, mid, conversation?.type ?? "chat");
    },
    [state.historyByCid, summary.conversations, summary.messages],
  );

  const selectConversation = useCallback(
    (cid: string) => {
      dispatch({ type: "selectConversation", cid });
      const conversation = summary.conversations.find((item) => item.cid === cid);
      requestHistory(cid, supportsConversationHistory(conversation));
      markConversationRead(cid);
    },
    [markConversationRead, requestHistory, summary.conversations],
  );

  useEffect(() => {
    if (!state.selectedCid) return;
    const conversation = summary.conversations.find((item) => item.cid === state.selectedCid);
    if ((conversation?.unreadCount ?? 0) <= 0) return;
    markConversationRead(state.selectedCid);
  }, [markConversationRead, state.selectedCid, summary.conversations]);

  const openFriendChat = useCallback(
    (friend: ChatFriend) => {
      const cid = findFriendConversationCid(friend, summary.conversations);
      if (cid) selectConversation(cid);
      return cid;
    },
    [selectConversation, summary.conversations],
  );
  const canOpenFriendChat = useCallback(
    (friend: ChatFriend) => Boolean(findFriendConversationCid(friend, summary.conversations)),
    [summary.conversations],
  );

  const retryHistory = useCallback(() => {
    if (state.selectedCid) {
      const conversation = summary.conversations.find((item) => item.cid === state.selectedCid);
      requestHistory(state.selectedCid, supportsConversationHistory(conversation));
    }
  }, [requestHistory, state.selectedCid, summary.conversations]);

  const setDraft = useCallback(
    (draft: string) => {
      if (state.selectedCid) dispatch({ type: "setDraft", cid: state.selectedCid, draft });
    },
    [state.selectedCid],
  );

  const sendMessage = useCallback(() => {
    if (state.pendingSendId) return;
    const selectedCid = state.selectedCid;
    const text = selectedCid ? (state.draftByCid[selectedCid] ?? "").trim() : "";
    if (!text || !selectedCid) return;
    // A command is routed to its executor instead of being posted. Sending
    // it as a message would leak the raw line to the room and then have the
    // poller run it a second time when it read our own message back.
    if (isComposerCommand(text)) {
      commandRef.current = { cid: selectedCid, command: text };
      dispatch({ type: "setDraft", cid: selectedCid, draft: "" });
      window.Main.send("chat:command", text);
      return;
    }
    const requestId = nextRequestId("send");
    dispatch({ type: "sendStarted", requestId, cid: selectedCid, body: text });
    window.Main.send("chat:send", requestId, selectedCid, text);
  }, [state.draftByCid, state.pendingSendId, state.selectedCid]);

  const translateMessage = useCallback(
    (message: ChatMessage) => {
      if (translatingMessageId) return;
      const messageKey = chatMessageKey(message);
      translationMessageRef.current = messageKey;
      setTranslatingMessageId(messageKey);
      setTranslationErrorByMessageId((current) => {
        const next = { ...current };
        delete next[messageKey];
        return next;
      });
      nextRequestId("translate");
      window.Main.send("chat:translate", message.body);
    },
    [translatingMessageId],
  );

  const runFriendAction = useCallback(
    (action: FriendAction, friend: ChatFriend) => {
      if (pendingFriendAction) return;
      setPendingFriendAction(friend.puuid);
      setFriendActionError(null);
      window.Main.send("chat:friend-action", action, friend);
    },
    [pendingFriendAction],
  );

  const allCachedMessages = useMemo(
    () => mergeChatMessages(summary.messages, ...Object.values(state.historyByCid)),
    [state.historyByCid, summary.messages],
  );
  const conversations = useMemo(
    () =>
      buildFriendConversations(allCachedMessages, summary.conversations, summary.friends).map(
        (item) => ({
          ...item,
          unreadCount: visibleUnreadCount(item.unreadCount, markedUnreadByCid[item.cid]),
        }),
      ),
    [allCachedMessages, markedUnreadByCid, summary.conversations, summary.friends],
  );
  const filteredConversations = useMemo(
    () => filterFriendConversations(conversations, summary.friends, conversationSearch),
    [conversationSearch, conversations, summary.friends],
  );
  const selectedFriendConversation = useMemo(
    () => conversations.find((item) => item.cid === state.selectedCid) ?? null,
    [conversations, state.selectedCid],
  );
  const friends = useMemo(
    () => filterChatFriends(summary.friends, friendSearch),
    [friendSearch, summary.friends],
  );
  const selectedConversation = useMemo(
    () =>
      state.selectedCid
        ? (summary.conversations.find((conversation) => conversation.cid === state.selectedCid) ??
          null)
        : null,
    [state.selectedCid, summary.conversations],
  );
  const visibleMessages = useMemo(
    () =>
      withResolvedSenderNames(
        messagesForConversation(state.selectedCid, state.historyByCid, summary.messages),
        summary.friends,
      ),
    [state.historyByCid, state.selectedCid, summary.friends, summary.messages],
  );
  const availableChannels = useMemo(
    () => ({
      friends: true,
      party: summary.conversations.some((conversation) => conversation.channel === "party"),
      team: summary.conversations.some((conversation) => conversation.channel === "team"),
      all: summary.conversations.some((conversation) => conversation.channel === "all"),
    }),
    [summary.conversations],
  );

  const selectedCid = state.selectedCid;
  const systemLines = selectedCid ? (state.systemByCid[selectedCid] ?? []) : [];
  const historyLoading = selectedCid ? Boolean(state.historyLoadingByCid[selectedCid]) : false;
  const rawHistoryError = selectedCid ? (state.historyErrorByCid[selectedCid] ?? null) : null;
  const historyError = isIgnorableHistoryError(rawHistoryError) ? null : rawHistoryError;
  const draft = selectedCid ? (state.draftByCid[selectedCid] ?? "") : "";
  const sendError = selectedCid ? (state.sendErrorByCid[selectedCid] ?? null) : null;

  return {
    summary,
    loading,
    loginRequired,
    summaryError: isIgnorableHistoryError(summaryError) ? null : summaryError,
    selectedChannel: state.selectedChannel,
    selectedCid,
    selectedConversation,
    availableChannels,
    conversations: filteredConversations,
    selectedFriendConversation,
    conversationSearch,
    setConversationSearch,
    friends,
    friendSearch,
    setFriendSearch,
    visibleMessages,
    systemLines,
    historyLoading,
    historyError,
    draft,
    setDraft,
    sending: Boolean(state.pendingSendId),
    sendError,
    translatedByMessageId,
    translationErrorByMessageId,
    translatingMessageId,
    pendingFriendAction,
    friendActionError,
    markReadError,
    selectChannel,
    selectConversation,
    markConversationRead,
    openFriendChat,
    canOpenFriendChat,
    refreshSummary,
    retryHistory,
    sendMessage,
    translateMessage,
    runFriendAction,
  };
};

export type ChatController = ReturnType<typeof useChatController>;
export type { ChatConversation };
