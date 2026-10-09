import { describe, expect, test } from "bun:test";
import type { TimelineKill, TimelineRound } from "@/types/matches";
import { abilitySlot, deadBefore, formatRoundTime, minimapPoint, onMinimap, visiblePlant } from "./match-minimap";

const ascent = {
	image: "ascent.png",
	xMultiplier: 0.00007,
	yMultiplier: -0.00007,
	xScalarToAdd: 0.813895,
	yScalarToAdd: 0.573242,
};

const kill = (victim: string, time: number): TimelineKill => ({
	time,
	killer: "k",
	victim,
	assistants: [],
	damageType: "Weapon",
	damageItem: "",
	secondary: false,
	victimLocation: null,
	positions: [],
});

describe("minimap projection", () => {
	test("swaps the axes: game Y moves the point across, game X moves it down", () => {
		expect(minimapPoint(ascent, { x: 0, y: 0 })).toEqual({ x: 0.813895, y: 0.573242 });
		const moved = minimapPoint(ascent, { x: 1000, y: -5000 });
		expect(moved.x).toBeCloseTo(0.813895 - 0.35);
		expect(moved.y).toBeCloseTo(0.573242 - 0.07);
	});

	test("keeps points near the image and drops ones far outside it", () => {
		expect(onMinimap({ x: 0.5, y: 1.02 })).toBe(true);
		expect(onMinimap({ x: 1.4, y: 0.5 })).toBe(false);
	});
});

describe("timeline helpers", () => {
	test("shows the spike only from its plant time in a selected kill snapshot", () => {
		const plant = { time: 60_000, player: "a", location: { x: 1, y: 2 }, positions: [] };
		const round = { plant } as TimelineRound;
		expect(visiblePlant(round, kill("b", 59_999))).toBeNull();
		expect(visiblePlant(round, kill("b", 60_000))).toBe(plant);
		expect(visiblePlant(round, kill("b", 65_000))).toBe(plant);
		expect(visiblePlant(round)).toBe(plant);
		expect(visiblePlant({ plant: null } as TimelineRound)).toBeNull();
	});

	test("formats round time as m:ss", () => {
		expect(formatRoundTime(0)).toBe("0:00");
		expect(formatRoundTime(65_900)).toBe("1:05");
	});

	test("counts only players killed before the selected kill", () => {
		const kills = [kill("a", 1), kill("b", 2), kill("c", 3)];
		const round = { kills } as TimelineRound;
		expect([...deadBefore(round, kills[2])]).toEqual(["a", "b"]);
		expect(deadBefore(round, kills[0]).size).toBe(0);
	});

	test("maps Riot's grenade item onto the valorant-api.com slot name", () => {
		expect(abilitySlot("GrenadeAbility")).toBe("grenade");
		expect(abilitySlot("ultimate")).toBe("ultimate");
	});
});
