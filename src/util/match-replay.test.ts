import { expect, test } from "bun:test";
import type { TimelineKill, TimelineRound } from "@/types/matches";
import { parseRoundTime, replayEvents, replayPositions, snapshotAt } from "./match-replay";

test("round time is elapsed m:ss and rejects malformed input", () => {
	expect(parseRoundTime("1:39")).toBe(99_000);
	expect(parseRoundTime("0:00")).toBe(0);
	for (const value of ["1:60", "-1:39", "abc", "1:3", "1:39.5"]) expect(parseRoundTime(value)).toBeNull();
});

test("estimates movement between recorded positions and holds unmatched players", () => {
	const events = replayEvents({ kills: [
		{ time: 10_000, positions: [{ subject: "a", x: 0, y: 10, view: 0 }, { subject: "b", x: 4, y: 5, view: 1 }] },
		{ time: 20_000, positions: [{ subject: "a", x: 20, y: 30, view: Math.PI / 2 }] },
	], plant: null, defuse: null } as TimelineRound);
	expect(replayPositions(events, 15_000)[0]).toEqual({ subject: "a", x: 10, y: 20, view: Math.PI / 4 });
	expect(replayPositions(events, 15_000)[1]).toEqual({ subject: "b", x: 4, y: 5, view: 1 });
	expect(replayPositions(events, 9_999)).toEqual([]);
	expect(replayPositions(events, 20_000)).toEqual(events[1].positions);
	expect(replayPositions(events, 25_000)).toEqual(events[1].positions);
	expect(events[0].positions[0].x).toBe(0);
});

test("replay uses the latest recorded kill, plant or defuse without looking ahead", () => {
	const kills = [{ time: 10_000, positions: [] }, { time: 30_000, positions: [] }] as TimelineKill[];
	const round = { kills, plant: { time: 20_000, player: "a", location: null, positions: [] }, defuse: { time: 40_000, player: "b", location: null, positions: [] } } as TimelineRound;
	const events = replayEvents(round);
	expect(events.map(event => event.time)).toEqual([10_000, 20_000, 30_000, 40_000]);
	expect(snapshotAt(events, 9_999)).toBeUndefined();
	expect(snapshotAt(events, 10_000)?.kind).toBe("kill");
	expect(snapshotAt(events, 25_000)?.kind).toBe("plant");
	expect(snapshotAt(events, 39_999)?.kill).toBe(kills[1]);
	expect(snapshotAt(events, 40_000)?.kind).toBe("defuse");
	expect(replayEvents({ kills: [], plant: null, defuse: null } as TimelineRound)).toEqual([]);
});

test("feed selection preserves a specific kill when multiple events share its time", () => {
	const events = replayEvents({ kills: [
		{ time: 10_000, victim: "first", positions: [] },
		{ time: 10_000, victim: "second", positions: [] },
	], plant: null, defuse: null } as TimelineRound);
	expect(snapshotAt(events, 10_000, events[0])).toBe(events[0]);
	expect(snapshotAt(events, 10_000)).toBe(events[1]);
	expect(snapshotAt(events, 9_999, events[0])).toBeUndefined();
});
