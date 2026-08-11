import { describe, expect, test } from "bun:test";
import type { MatchPlayer } from "@/types/matches";
import { scoreboardPlayerInteraction } from "./match-scoreboard-selection";

const player: MatchPlayer = {
	subject: "player-puuid",
	gameName: "Clickable",
	tagLine: "TW1",
	role: "player",
	teamId: "Blue",
	partyId: "",
	characterId: "agent",
	competitiveTier: 18,
	playerCard: "card",
	accountLevel: 100,
	isSelf: false,
	kills: 20,
	deaths: 10,
	assists: 5,
	score: 5000,
	roundsPlayed: 20,
	acs: 250,
	damage: 3000,
	adr: 150,
	headshots: 20,
	bodyshots: 40,
	legshots: 5,
	headshotPercent: 30.7,
};

describe("scoreboard player interaction", () => {
	test("activates the exact valid player and exposes their Riot ID", () => {
		const selected: MatchPlayer[] = [];
		const interaction = scoreboardPlayerInteraction(player, (value) => selected.push(value));

		expect(interaction.selectable).toBe(true);
		expect(interaction.label).toContain("Clickable#TW1");
		interaction.activate?.();
		expect(selected).toEqual([player]);
	});

	test("stays non-interactive without a callback or a valid PUUID", () => {
		expect(scoreboardPlayerInteraction(player).selectable).toBe(false);
		expect(
			scoreboardPlayerInteraction({ ...player, subject: "   " }, () => {}).selectable,
		).toBe(false);
	});
});
