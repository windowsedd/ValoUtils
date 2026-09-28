import { expect, test } from "bun:test";
import {
  livePlayerStatsKey,
  liveStatsRequestKey,
  playersNeedingLiveStats,
  shouldPreserveReadyStats,
  shouldRequestLiveStats,
  shouldPauseLiveRequests,
} from "./live-game-events";

test("changes the recent-stat request identity when the queue changes", () => {
  expect(liveStatsRequestKey(["p2", "p1"], "competitive")).not.toBe(
    liveStatsRequestKey(["p1", "p2"], "unrated"),
  );
  expect(liveStatsRequestKey(["P2", "p1"], "SWIFTPLAY")).toBe("p1,p2:swiftplay");
});

test("pauses live requests after a complete pregame or coregame snapshot", () => {
  expect(shouldPauseLiveRequests("pregame", 10)).toBe(true);
  expect(shouldPauseLiveRequests("pregame", 5)).toBe(false);
  expect(shouldPauseLiveRequests("coregame", 10)).toBe(true);
  expect(shouldPauseLiveRequests("party", 10)).toBe(false);
  expect(shouldPauseLiveRequests("pregame", 10, "deathmatch")).toBe(false);
  expect(shouldPauseLiveRequests("pregame", 12, "DEATHMATCH")).toBe(true);
  expect(shouldPauseLiveRequests("pregame", 10, "hurm")).toBe(true);
});

test("keeps recent-stat identity stable across phase-specific snapshot keys", () => {
  const pregamePlayers = ["p3", "p1", "p2"];
  const coregamePlayers = ["P2", "p3", "P1"];
  expect(liveStatsRequestKey(pregamePlayers, "competitive")).toBe(
    liveStatsRequestKey(coregamePlayers, "COMPETITIVE"),
  );
});

test("normalizes per-player recent-stat keys across phase casing changes", () => {
  expect(livePlayerStatsKey("Player-PUUID")).toBe(livePlayerStatsKey("player-puuid"));
});

test("preserves ready stats only when explicitly retrying the same identity", () => {
  expect(shouldPreserveReadyStats(null, "p1:competitive", "p1:competitive")).toBe(true);
  expect(shouldPreserveReadyStats("p1:competitive", "p1:competitive", "p1:unrated")).toBe(false);
  expect(shouldPreserveReadyStats(null, "p1:competitive", "p1:unrated")).toBe(false);
});

test("does not pile recent-stat PD calls onto a live snapshot that is already throttled", () => {
  expect(shouldRequestLiveStats(undefined)).toBe(true);
  expect(shouldRequestLiveStats(null)).toBe(true);
  expect(shouldRequestLiveStats("unavailable")).toBe(true);
  expect(shouldRequestLiveStats("rateLimited")).toBe(false);
});

test("keeps ready ally stats when the coregame roster grows", () => {
  const recent = {
    ally: { status: "ready" },
    pending: { status: "loading" },
  };
  expect(playersNeedingLiveStats(["ALLY", "enemy", "pending"], recent)).toEqual(["enemy", "pending"]);
  expect(playersNeedingLiveStats(["ally"], recent)).toEqual([]);
});
