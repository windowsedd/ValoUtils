import { expect, test } from "bun:test";
import {
  LIVE_IDLE_POLL_MS,
  LIVE_MAX_POLL_MS,
  LIVE_POLL_MS,
  livePlayerStatsKey,
  nextLivePollDelay,
  shouldPauseForSnapshot,
  liveStatsRequestKey,
  playersNeedingLiveStats,
  shouldPreserveReadyStats,
  shouldRequestLiveStats,
} from "./live-game-events";

test("changes the recent-stat request identity when the queue changes", () => {
  expect(liveStatsRequestKey(["p2", "p1"], "competitive")).not.toBe(
    liveStatsRequestKey(["p1", "p2"], "unrated"),
  );
  expect(liveStatsRequestKey(["P2", "p1"], "SWIFTPLAY")).toBe("p1,p2:swiftplay");
});

test("backs off unchanged live polls and snaps back on a change", () => {
  expect(nextLivePollDelay("party", true, LIVE_POLL_MS)).toBe(10000);
  expect(nextLivePollDelay("party", true, 10000)).toBe(20000);
  expect(nextLivePollDelay("party", true, 20000)).toBe(LIVE_MAX_POLL_MS);
  expect(nextLivePollDelay("party", true, LIVE_MAX_POLL_MS)).toBe(LIVE_MAX_POLL_MS);
  expect(nextLivePollDelay("party", false, LIVE_MAX_POLL_MS)).toBe(LIVE_POLL_MS);
  expect(nextLivePollDelay("pregame", true, 20000)).toBe(LIVE_POLL_MS);
  expect(nextLivePollDelay("party", true, 20000, true)).toBe(LIVE_POLL_MS);
  expect(nextLivePollDelay("idle", true, LIVE_POLL_MS)).toBe(LIVE_IDLE_POLL_MS);
  expect(nextLivePollDelay("party", true, LIVE_IDLE_POLL_MS)).toBe(LIVE_MAX_POLL_MS);
});

test("does not pause again for a match that already ended", () => {
  expect(shouldPauseForSnapshot("coregame", "m1", null)).toBe(true);
  expect(shouldPauseForSnapshot("coregame", "M1", "m1")).toBe(false);
  expect(shouldPauseForSnapshot("coregame", "m2", "m1")).toBe(true);
  expect(shouldPauseForSnapshot("party", null, null)).toBe(false);
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
  expect(shouldRequestLiveStats(null, 40)).toBe(false);
  expect(shouldRequestLiveStats(null, null)).toBe(true);
});

test("keeps ready ally stats when the coregame roster grows", () => {
  const recent = {
    ally: { status: "ready" },
    pending: { status: "loading" },
  };
  expect(playersNeedingLiveStats(["ALLY", "enemy", "pending"], recent)).toEqual(["enemy", "pending"]);
  expect(playersNeedingLiveStats(["ally"], recent)).toEqual([]);
});
