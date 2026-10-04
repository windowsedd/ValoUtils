import { describe, expect, test } from "bun:test";
import { DUMMY_BOT_CID, dummyBotMessages } from "./use-dummy-bot-chat";

describe("dummy bot chat", () => {
  test("maps the bot transcript onto chat messages", () => {
    const messages = dummyBotMessages(
      [
        { id: "1", body: "$status", isSelf: true, timestamp: "2026-10-04T10:00:00.000Z" },
        { id: "2", body: "Appearing online.", isSelf: false, timestamp: "2026-10-04T10:00:01.000Z" },
      ],
      "ValoUtils Bot",
    );
    expect(messages.map((message) => [message.isSelf, message.senderName, message.conversationId])).toEqual([
      [true, "", DUMMY_BOT_CID],
      [false, "ValoUtils Bot", DUMMY_BOT_CID],
    ]);
    expect(messages[1].sender).not.toBe(messages[0].sender);
  });
});
