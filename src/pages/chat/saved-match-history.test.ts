import { expect, test } from "bun:test";
import { savedMatchMessages } from "./saved-match-history";
import type { ChatMessage, SavedChatMatch } from "@/types/chat";

const match: SavedChatMatch = {
  matchUuid: "match-a", updatedAt: 1,
  messages: [
    { id: "team", conversationId: "match-a-blue@ares-coregame.ap", timestamp: "2" },
    { id: "all", conversationId: "match-a-all@ares-coregame.ap", timestamp: "1" },
    { id: "pregame", conversationId: "match-b-blue@ares-pregame.ap", timestamp: "3" },
  ] as ChatMessage[],
};

test("saved history separates Team and All and excludes another match", () => {
  expect(savedMatchMessages(match, "team").map(m => m.id)).toEqual(["team"]);
  expect(savedMatchMessages(match, "all").map(m => m.id)).toEqual(["all"]);
});

test("saved history does not appear in private or party chat", () => {
  expect(savedMatchMessages(match, "friends")).toEqual([]);
  expect(savedMatchMessages(match, "party")).toEqual([]);
  expect(savedMatchMessages(undefined, "team")).toEqual([]);
});
