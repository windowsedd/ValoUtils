import { describe, expect, test } from "bun:test";
import type { LivePlayer, RecentStatsState } from "../src/types/live-game";
import { buildTeamMatchup } from "../src/components/live-game/live-game-metrics";
import { isCurrentStatsAttempt } from "../src/components/live-game/live-game-events";
import { formatSeasonActLabel } from "../src/util/season-label";

const player = (puuid: string, teamId: string, isSelf = false) => ({ puuid, teamId, isSelf }) as LivePlayer;
const ready = (kd: number, winRate: number, acs: number, dpr: number): RecentStatsState => ({
	status: "ready",
	stats: { matches: 5, kills: 0, deaths: 0, assists: 0, wins: 0, kd, winRate, acs, dpr, history: [] },
});

describe("buildTeamMatchup", () => {
	test("averages ready players on the signed-in and opposing teams", () => {
		const players = [player("p1", "Blue", true), player("p2", "Blue"), player("p3", "Red")];
		const recent = { p1: ready(1, 50, 200, 140), p2: ready(2, 60, 220, 160), p3: ready(0.8, 40, 180, 120) };

		expect(buildTeamMatchup(players, recent)).toEqual({
			ally: { teamId: "Blue", players: 2, kd: 1.5, winRate: 55, acs: 210, dpr: 150 },
			enemy: { teamId: "Red", players: 1, kd: 0.8, winRate: 40, acs: 180, dpr: 120 },
		});
	});

	test("keeps metrics empty while one team has no ready statistics", () => {
		const players = [player("p1", "Ally", true), player("p2", "Enemy")];
		expect(buildTeamMatchup(players, { p1: ready(1.2, 60, 230, 155), p2: { status: "loading" } })).toEqual({
			ally: { teamId: "Ally", players: 1, kd: 1.2, winRate: 60, acs: 230, dpr: 155 },
			enemy: { teamId: "Enemy", players: 0, kd: null, winRate: null, acs: null, dpr: null },
		});
	});

	test("returns null without self or an opposing roster", () => {
		expect(buildTeamMatchup([player("p1", "Blue")], {})).toBeNull();
		expect(buildTeamMatchup([player("p1", "Blue", true)], {})).toBeNull();
	});
});

describe("isCurrentStatsAttempt", () => {
	test("accepts only events from the latest stats request", () => {
		expect(isCurrentStatsAttempt(3, 3)).toBe(true);
		expect(isCurrentStatsAttempt(2, 3)).toBe(false);
	});
});

describe("formatSeasonActLabel", () => {
	test("uses compact episode and year act labels", () => {
		expect(formatSeasonActLabel("E3", 5)).toBe("E3A5");
		expect(formatSeasonActLabel("V25", 5)).toBe("V25A5");
	});

	test("omits unresolved season labels", () => {
		expect(formatSeasonActLabel("", 5)).toBeNull();
		expect(formatSeasonActLabel("V25", 0)).toBeNull();
	});
});
