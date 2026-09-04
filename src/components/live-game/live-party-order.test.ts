import { describe, expect, test } from "bun:test";
import type { LivePlayer } from "@/types/live-game";
import { groupPlayersByParty, orderTeamsSelfFirst, selfTeamId } from "./live-party-order";

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

const member = (puuid: string, teamId: string | null, isSelf = false): LivePlayer =>
	({ puuid, teamId, isSelf }) as LivePlayer;

describe("selfTeamId", () => {
	test("reports the team the signed-in player is on", () => {
		expect(selfTeamId([member("a", "Blue"), member("b", "Red", true)])).toBe("Red");
	});

	test("is null when no player is flagged as self", () => {
		expect(selfTeamId([member("a", "Blue"), member("b", "Red")])).toBeNull();
	});
});

describe("orderTeamsSelfFirst", () => {
	const ids = (entries: string[], self: string | null) =>
		orderTeamsSelfFirst(entries, (id) => id, self);

	test("puts our own team first even when we are on Red", () => {
		expect(ids(["Blue", "Red"], "Red")).toEqual(["Red", "Blue"]);
	});

	test("leaves our own team first when we are already on Blue", () => {
		expect(ids(["Blue", "Red"], "Blue")).toEqual(["Blue", "Red"]);
	});

	test("handles the pregame Ally/Enemy naming", () => {
		expect(ids(["Enemy", "Ally"], "Ally")).toEqual(["Ally", "Enemy"]);
	});

	test("falls back to Riot's naming when there is no self player", () => {
		expect(ids(["Red", "Blue"], null)).toEqual(["Blue", "Red"]);
		expect(ids(["Enemy", "Ally"], null)).toEqual(["Ally", "Enemy"]);
	});

	test("sinks the unresolved bucket to the end", () => {
		expect(ids(["all", "Red", "Blue"], "Red")).toEqual(["Red", "Blue", "all"]);
	});

	test("is stable for teams that rank equally", () => {
		expect(ids(["Red", "Blue", "Green"], "Blue")).toEqual(["Blue", "Red", "Green"]);
	});
});
