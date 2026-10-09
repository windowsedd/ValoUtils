import type { TimelineKill, TimelinePosition, TimelineRound } from "@/types/matches";

export type ReplayEvent =
	| { kind: "kill"; time: number; kill: TimelineKill; index: number; positions: TimelinePosition[] }
	| { kind: "plant" | "defuse"; time: number; player: string; positions: TimelinePosition[] };

/** Elapsed round time, never the in-game countdown. */
export const parseRoundTime = (value: string): number | null => {
	const match = /^(\d+):([0-5]\d)$/.exec(value.trim());
	if (!match) return null;
	const millis = (Number(match[1]) * 60 + Number(match[2])) * 1000;
	return Number.isSafeInteger(millis) ? millis : null;
};

export const replayEvents = (round: TimelineRound): ReplayEvent[] => {
	const events: ReplayEvent[] = round.kills.map((kill, index) => ({ kind: "kill", time: kill.time, kill, index, positions: kill.positions }));
	if (round.plant) events.push({ kind: "plant", ...round.plant });
	if (round.defuse) events.push({ kind: "defuse", ...round.defuse });
	return events.sort((a, b) => a.time - b.time);
};

/** Hold the last real snapshot; never infer positions from a later event. */
export const snapshotAt = (events: ReplayEvent[], time: number, selected?: ReplayEvent): ReplayEvent | undefined => {
	if (selected?.time === time && events.includes(selected)) return selected;
	let latest: ReplayEvent | undefined;
	for (const event of events) {
		if (event.time > time) break;
		latest = event;
	}
	return latest;
};

/** Linear animation between event snapshots; these intermediate positions are estimates. */
export const replayPositions = (events: ReplayEvent[], time: number): TimelinePosition[] => {
	const current = snapshotAt(events, time);
	if (!current) return [];
	const next = events[events.indexOf(current) + 1];
	if (!next || next.time <= current.time) return current.positions;
	const fraction = (time - current.time) / (next.time - current.time);
	const targets = new Map(next.positions.map(position => [position.subject, position]));
	return current.positions.map(position => {
		const target = targets.get(position.subject);
		if (!target) return position;
		const angle = Math.atan2(Math.sin(target.view - position.view), Math.cos(target.view - position.view));
		return {
			...position,
			x: position.x + (target.x - position.x) * fraction,
			y: position.y + (target.y - position.y) * fraction,
			view: position.view + angle * fraction,
		};
	});
};
