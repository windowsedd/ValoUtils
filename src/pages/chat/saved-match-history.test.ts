import { expect, test } from "bun:test";
import { matchesNeedingDetails, matchOutcome, relativeDay, savedMatchList, savedMatchMessages, summarizeSavedMatch, withFetchedDetails } from "./saved-match-history";
import type { ChatMessage, SavedChatMatch, SavedMatchDetails } from "@/types/chat";

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

const details = (won: boolean | null, roundsWon: number, roundsLost: number): SavedMatchDetails => ({
  mapId: "/Game/Maps/Ascent/Ascent", queueId: "competitive", gameMode: "", agentId: "a",
  won, roundsWon, roundsLost, startMillis: 5,
});

test("outcome reads win, loss, draw, or nothing without a team result", () => {
  expect(matchOutcome(details(true, 13, 9))).toBe("win");
  expect(matchOutcome(details(false, 9, 13))).toBe("loss");
  expect(matchOutcome(details(false, 12, 12))).toBe("draw");
  expect(matchOutcome(details(null, 0, 0))).toBeNull();
  expect(matchOutcome(undefined)).toBeNull();
});

test("saved details are kept, fetched ones fill gaps, and only gaps need lookups", () => {
  const saved = { ...older, details: details(true, 13, 9) };
  const merged = withFetchedDetails([saved, newer], new Map([["m1", details(false, 1, 13)], ["m2", details(true, 13, 2)]]));
  expect(merged[0]).toBe(saved);
  expect(merged[1]!.details?.roundsLost).toBe(2);
  expect(matchesNeedingDetails([saved, newer, { ...newer, matchUuid: "m3", updatedAt: 1000 }])).toEqual(["m3", "m2"]);
});

test("summary uses the match start time once details exist", () => {
  expect(summarizeSavedMatch({ ...older, details: details(true, 13, 9) }, "team")).toMatchObject({ at: 5 });
});
