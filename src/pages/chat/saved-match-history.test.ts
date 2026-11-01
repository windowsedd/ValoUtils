import { expect, test } from "bun:test";
import { relativeDay, savedMatchList, savedMatchMessages, summarizeSavedMatch } from "./saved-match-history";
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

const line = (id: string, room: "blue" | "all", at: number, senderName: string, body: string) =>
  ({ id, conversationId: `m1-${room}@ares-coregame.ap`, timestamp: String(at), sender: senderName, senderName, body }) as ChatMessage;

const older: SavedChatMatch = {
  matchUuid: "m1", updatedAt: 50,
  messages: [line("1", "blue", 10, "Ally", "rotate b"), line("2", "all", 20, "Enemy", "gg"), line("3", "blue", 30, "Ally", "nice")],
};
const newer: SavedChatMatch = { matchUuid: "m2", updatedAt: 900, messages: [] };

test("summary counts each room, speakers, and shows the viewed room's last line", () => {
  const team = summarizeSavedMatch(older, "team");
  expect([team.team, team.all, team.speakers, team.at, team.last?.body]).toEqual([2, 1, 2, 30, "nice"]);
  expect(summarizeSavedMatch(older, "all").last?.body).toBe("gg");
  expect(summarizeSavedMatch(newer, "team")).toMatchObject({ at: 900, last: null, team: 0 });
});

test("list is newest first and search matches text or speaker", () => {
  expect(savedMatchList([older, newer], "team").map(m => m.matchUuid)).toEqual(["m2", "m1"]);
  expect(savedMatchList([older, newer], "team", " ROTATE ").map(m => m.matchUuid)).toEqual(["m1"]);
  expect(savedMatchList([older, newer], "team", "enemy").map(m => m.matchUuid)).toEqual(["m1"]);
  expect(savedMatchList([older, newer], "team", "nothing")).toEqual([]);
});

test("relative day labels today and yesterday only", () => {
  const now = new Date(2026, 10, 1, 15).getTime();
  expect(relativeDay(new Date(2026, 10, 1, 0, 5).getTime(), now)).toBe("today");
  expect(relativeDay(new Date(2026, 9, 31, 23).getTime(), now)).toBe("yesterday");
  expect(relativeDay(new Date(2026, 9, 30, 23).getTime(), now)).toBeNull();
});
