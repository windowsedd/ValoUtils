import { expect, test } from "bun:test";
import { liveStatsRequestKey } from "./live-game-events";

test("changes the recent-stat request identity when the queue changes", () => {
	expect(liveStatsRequestKey("same-roster", "competitive")).not.toBe(
		liveStatsRequestKey("same-roster", "unrated"),
	);
	expect(liveStatsRequestKey("same-roster", "SWIFTPLAY")).toBe("same-roster:swiftplay");
});
