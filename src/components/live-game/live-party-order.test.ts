import { describe, expect, test } from "bun:test";
import type { LivePlayer } from "@/types/live-game";
import { groupPlayersByParty } from "./live-party-order";

const player = (puuid: string, party: string | null): LivePlayer =>
	({ puuid, party }) as LivePlayer;

describe("groupPlayersByParty", () => {
	test("places each party together in first-seen order", () => {
		const result = groupPlayersByParty([
			player("solo-a", null),
			player("party-a-1", "Team 1"),
			player("party-b-1", "Team 2"),
			player("party-a-2", "Team 1"),
			player("solo-b", null),
			player("party-b-2", "Team 2"),
		]);

		expect(result.map(({ puuid }) => puuid)).toEqual([
			"solo-a",
			"party-a-1",
			"party-a-2",
			"party-b-1",
			"party-b-2",
			"solo-b",
		]);
	});

	test("does not mutate its input", () => {
		const input = [player("p1", "Team 1"), player("p2", null)];
		const original = [...input];
		groupPlayersByParty(input);
		expect(input).toEqual(original);
	});

	test("keeps identical anonymous labels inside separately grouped teams", () => {
		const allies = groupPlayersByParty([
			player("ally-solo", null),
			player("ally-party-1", "Team 1"),
			player("ally-party-2", "Team 1"),
		]);
		const enemies = groupPlayersByParty([
			player("enemy-party-1", "Team 1"),
			player("enemy-solo", null),
			player("enemy-party-2", "Team 1"),
		]);

		expect(allies.map(({ puuid }) => puuid)).toEqual([
			"ally-solo",
			"ally-party-1",
			"ally-party-2",
		]);
		expect(enemies.map(({ puuid }) => puuid)).toEqual([
			"enemy-party-1",
			"enemy-party-2",
			"enemy-solo",
		]);
	});
});
