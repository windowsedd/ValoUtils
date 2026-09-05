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
      draftByCid: { room: "keep me" },
      pendingSendId: "send-1",
      pendingSendCid: "room",
      pendingSendBody: "keep me",
    };
    const result = chatControllerReducer(sending, {
      type: "sendFailed",
      requestId: "send-1",
      error: "offline",
    });
    expect(result.draftByCid.room).toBe("keep me");
    expect(result.pendingSendId).toBeNull();
    expect(result.sendErrorByCid.room).toBe("offline");
  });

  test("clears draft only for the matching successful send", () => {
    const sending = {
      ...initialChatControllerState,
      draftByCid: { room: "sent" },
      pendingSendId: "send-2",
      pendingSendCid: "room",
      pendingSendBody: "sent",
    };
    const ignored = chatControllerReducer(sending, {
      type: "sendSucceeded",
      requestId: "send-1",
      sentAt: "3000",
    });
    const completed = chatControllerReducer(sending, {
      type: "sendSucceeded",
      requestId: "send-2",
      sentAt: "3000",
    });
    expect(ignored).toBe(sending);
    expect(completed.draftByCid.room).toBeUndefined();
    expect(completed.pendingSendId).toBeNull();
  });

  test("inserts a successful send immediately and replaces it when history catches up", () => {
    const sending = chatControllerReducer(
      {
        ...initialChatControllerState,
        selectedCid: "friend-cid",
        draft: "hello",
      },
      {
        type: "sendStarted",
        requestId: "send-3",
        cid: "friend-cid",
        body: "hello",
      },
    );
    const optimistic = chatControllerReducer(sending, {
      type: "sendSucceeded",
      requestId: "send-3",
      sentAt: "3000",
    });
    expect(optimistic.historyByCid["friend-cid"]?.[0]?.body).toBe("hello");
    expect(optimistic.historyByCid["friend-cid"]?.[0]?.isSelf).toBe(true);

    const loading = chatControllerReducer(optimistic, {
      type: "historyStarted",
      cid: "friend-cid",
      requestId: "history-3",
    });
    const reconciled = chatControllerReducer(loading, {
      type: "historySucceeded",
      cid: "friend-cid",
      requestId: "history-3",
      messages: [
        message({
          id: "riot-message",
          conversationId: "friend-cid",
          body: "hello",
          isSelf: true,
        }),
      ],
    });
    expect(reconciled.historyByCid["friend-cid"]?.map((item) => item.id)).toEqual(["riot-message"]);
  });

  test("keeps a new optimistic duplicate until history contains a nearby timestamp", () => {
    const oldMessage = message({
      id: "old-same-text",
      conversationId: "friend-cid",
      body: "same text",
      isSelf: true,
      timestamp: "99000",
    });
    const sending = chatControllerReducer(
      {
        ...initialChatControllerState,
        historyByCid: { "friend-cid": [oldMessage] },
      },
      {
        type: "sendStarted",
        requestId: "send-repeat",
        cid: "friend-cid",
        body: "same text",
      },
    );
    const optimistic = chatControllerReducer(sending, {
      type: "sendSucceeded",
      requestId: "send-repeat",
      sentAt: "100000",
    });
    const loading = chatControllerReducer(optimistic, {
      type: "historyStarted",
      cid: "friend-cid",
      requestId: "history-repeat",
    });
    const history = chatControllerReducer(loading, {
      type: "historySucceeded",
      cid: "friend-cid",
      requestId: "history-repeat",
      messages: [oldMessage],
    });
    expect(history.historyByCid["friend-cid"]?.map((item) => item.id)).toEqual([
      "old-same-text",
      "optimistic:send-repeat",
    ]);

    const loadingAgain = chatControllerReducer(history, {
      type: "historyStarted",
      cid: "friend-cid",
      requestId: "history-repeat-2",
    });
    const caughtUp = chatControllerReducer(loadingAgain, {
      type: "historySucceeded",
      cid: "friend-cid",
      requestId: "history-repeat-2",
      messages: [
        oldMessage,
        message({
          id: "new-same-text",
          conversationId: "friend-cid",
          body: "same text",
          isSelf: true,
          timestamp: "101000",
        }),
      ],
    });
    expect(caughtUp.historyByCid["friend-cid"]?.map((item) => item.id)).toEqual([
      "old-same-text",
      "new-same-text",
    ]);
  });

  test("reconciles repeated messages without Riot ids by stable message identity", () => {
    const oldMessage = message({
      id: "",
      conversationId: "friend-cid",
      body: "same text",
      isSelf: true,
      timestamp: "99000",
    });
    const sending = chatControllerReducer(
      {
        ...initialChatControllerState,
        historyByCid: { "friend-cid": [oldMessage] },
      },
      {
        type: "sendStarted",
        requestId: "send-no-id",
        cid: "friend-cid",
        body: "same text",
      },
    );
    const optimistic = chatControllerReducer(sending, {
      type: "sendSucceeded",
      requestId: "send-no-id",
      sentAt: "100000",
    });
    const loading = chatControllerReducer(optimistic, {
      type: "historyStarted",
      cid: "friend-cid",
      requestId: "history-no-id",
    });
    const caughtUp = chatControllerReducer(loading, {
      type: "historySucceeded",
      cid: "friend-cid",
      requestId: "history-no-id",
      messages: [
        oldMessage,
        message({
          id: "",
          conversationId: "friend-cid",
          body: "same text",
          isSelf: true,
          timestamp: "101000",
        }),
      ],
    });
    expect(caughtUp.historyByCid["friend-cid"]).toHaveLength(2);
    expect(
      caughtUp.historyByCid["friend-cid"]?.some((item) => item._raw?.optimistic === true),
    ).toBe(false);
  });

  test("keeps drafts and send errors scoped to their originating cid", () => {
    const drafted = chatControllerReducer(initialChatControllerState, {
      type: "setDraft",
      cid: "friend-cid",
      draft: "private text",
    });
    const sending = chatControllerReducer(drafted, {
      type: "sendStarted",
      requestId: "send-private",
      cid: "friend-cid",
      body: "private text",
    });
    const switched = chatControllerReducer(sending, {
      type: "selectChannel",
      channel: "party",
      cid: "party@ares-parties.ap",
    });
    const failed = chatControllerReducer(switched, {
      type: "sendFailed",
      requestId: "send-private",
      error: "offline",
    });
    expect(failed.draftByCid["friend-cid"]).toBe("private text");
    expect(failed.draftByCid["party@ares-parties.ap"]).toBeUndefined();
    expect(failed.sendErrorByCid["friend-cid"]).toBe("offline");
    expect(failed.sendErrorByCid["party@ares-parties.ap"]).toBeUndefined();
  });

  test("classifies an optimistic send from its cid after the user switches channels", () => {
    const sending = chatControllerReducer(initialChatControllerState, {
      type: "sendStarted",
      requestId: "send-switch",
      cid: "friend-cid",
      body: "still direct",
    });
    const switched = chatControllerReducer(sending, {
      type: "selectChannel",
      channel: "party",
      cid: "party@ares-parties.ap",
    });
    const completed = chatControllerReducer(switched, {
      type: "sendSucceeded",
      requestId: "send-switch",
      sentAt: "3000",
    });
    expect(completed.historyByCid["friend-cid"]?.[0]?.scope).toBe("friends");
    expect(completed.historyByCid["friend-cid"]?.[0]?.type).toBe("chat");
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
    expect(result.historyByCid["party@ares-parties.ap"]?.map((item) => item.id)).toEqual(["party"]);
    expect(result.historyByCid["game-blue@ares-coregame.ap"]?.map((item) => item.id)).toEqual([
      "team",
    ]);
  });
});

describe("command results", () => {
  const result = (overrides: Partial<Parameters<typeof chatControllerReducer>[1]> = {}) =>
    ({
      type: "commandResult" as const,
      cid: "party@ares-parties.ap",
      id: "command-1",
      command: ".send team fr gl hf",
      body: "Sent to team (fr): bonne chance",
      failed: false,
      ...overrides,
    }) as Parameters<typeof chatControllerReducer>[1];

  test("keeps command output out of the message history", () => {
    // These were never sent to anyone, so a history refresh must not be
    // able to overwrite them and the merge must never see them.
    const next = chatControllerReducer(initialChatControllerState, result());
    expect(next.systemByCid["party@ares-parties.ap"]).toHaveLength(1);
    expect(next.historyByCid["party@ares-parties.ap"]).toBeUndefined();
  });

  test("records results per room, in order", () => {
    const first = chatControllerReducer(initialChatControllerState, result());
    const second = chatControllerReducer(
      first,
      result({ id: "command-2", command: ".tran 2", body: "1. 好的 → okay" }),
    );
    const other = chatControllerReducer(
      second,
      result({ cid: "team@ares-coregame.ap", id: "command-3" }),
    );
    expect(other.systemByCid["party@ares-parties.ap"]?.map((line) => line.id)).toEqual([
      "command-1",
      "command-2",
    ]);
    expect(other.systemByCid["team@ares-coregame.ap"]).toHaveLength(1);
  });

  test("marks a failure so it can be shown apart from a result", () => {
    const next = chatControllerReducer(
      initialChatControllerState,
      result({ body: "Unknown command '.nope'.", failed: true }),
    );
    expect(next.systemByCid["party@ares-parties.ap"]?.[0]?.failed).toBe(true);
  });

  test("stays bounded over a long session", () => {
    let state = initialChatControllerState;
    for (let index = 0; index < 60; index++) {
      state = chatControllerReducer(state, result({ id: `command-${index}` }));
    }
    const lines = state.systemByCid["party@ares-parties.ap"] ?? [];
    expect(lines).toHaveLength(50);
    // Oldest dropped, newest kept.
    expect(lines[0]?.id).toBe("command-10");
    expect(lines[49]?.id).toBe("command-59");
  });
});
