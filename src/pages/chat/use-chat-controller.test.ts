import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./use-chat-controller.ts", import.meta.url), "utf8");

describe("useChatController IPC lifecycle", () => {
  test("uses request promises and owns only push subscriptions", () => {
    expect(source).toContain('listenEvent("chat:message", onRealtimeMessage)');
    expect(source).toContain('listenEvent("chat:presence", onPresence)');
    expect(source).toContain('stopRealtimeMessage()');
    expect(source).toContain('stopPresence()');
    expect(source).not.toContain("window.Main");
    expect(source).not.toContain('"chat_disconnect"');
  });

  test("presence snapshots update friends without waiting for summary polling", () => {
    expect(source).toContain("friends: applyPresenceSnapshot(current.friends, snapshot)");
    expect(source).not.toContain('window.Main.send("chat:get"); // presence');
  });

  test("requests history and sends with request ids", () => {
    expect(source).toContain('args: [requestId, cid]');
    expect(source).toContain('args: [requestId, selectedCid, text]');
    expect(source).toContain("invoke<");
    expect(source).toContain('"chat_mark_read"');
    expect(source).toContain("lastConversationMessageId");
    expect(source).toContain("sessionMarkedUnread");
    expect(source).toContain("if (riotUnread <= 0) return");
    expect(source).toContain(
      'if (!cid || !supportsHistory || channelForCid(cid) !== "friends") return',
    );
    expect(source).toContain("isIgnorableHistoryError(response.error)");
    expect(source).toContain('requestHistory(response.cid, response.type === "chat")');
  });

  test("commands carry the selected conversation so .ascii knows the room", () => {
    expect(source).toContain('args: [text, selectedCid]');
    // The raw command still never reaches the room.
    expect(source).toContain("if (isComposerCommand(text)) {");
    expect(source).not.toContain('window.Main.send("chat:send", requestId, selectedCid, text);\n    if (isComposerCommand');
  });

  test("realtime messages update cache without selecting a channel", () => {
    expect(source).toContain('dispatch({ type: "realtimeMessage", message })');
    expect(source).not.toContain("selectChannel(channelForCid(message.conversationId))");
  });

  test("party thread includes lines stored under a MUC alias of the selected room", () => {
    expect(source).toContain("messagesForConversation(");
    expect(source).not.toContain("message.conversationId === state.selectedCid");
  });
});
