import { expect, test } from "bun:test";
import {
  livePlayerStatsKey,
  liveStatsRequestKey,
  shouldPreserveReadyStats,
} from "./live-game-events";

test("changes the recent-stat request identity when the queue changes", () => {
  expect(liveStatsRequestKey(["p2", "p1"], "competitive")).not.toBe(
    liveStatsRequestKey(["p1", "p2"], "unrated"),
  );
  expect(liveStatsRequestKey(["P2", "p1"], "SWIFTPLAY")).toBe("p1,p2:swiftplay");
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
