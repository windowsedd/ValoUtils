import { describe, expect, test } from "bun:test";
import type { MatchDetails, MatchPlayer } from "@/types/matches";
import { matchDuels } from "./match-player-duels";

const player = (subject: string, teamId: string, role: MatchPlayer["role"] = "player") =>
	({ subject, teamId, role, gameName: subject, tagLine: "TAG", characterId: "" }) as MatchPlayer;

const details = (players: MatchPlayer[], duels?: MatchDetails["duels"]) =>
	({ matchId: "m", players, duels }) as MatchDetails;

const me = player("Me", "Blue");
const ally = player("Ally", "Blue");
const foe = player("Foe", "Red");
const coach = player("Coach", "Red", "coach");

describe("matchDuels", () => {
	test("reads kills, damage and openings against each opponent", () => {
		const lines = matchDuels(
			details([me, ally, foe, coach], {
				pairs: [
					{ from: "me", to: "foe", kills: 3, damage: 699 },
					{ from: "foe", to: "me", kills: 6, damage: 1269 },
				],
				openings: [
					{ killer: "me", victim: "foe" },
					{ killer: "foe", victim: "me" },
					{ killer: "foe", victim: "me" },
					{ killer: "foe", victim: "ally" },
				],
			}),
			me,
		);
		expect(lines).toEqual([
			{ player: foe, kills: 3, deaths: 6, dealt: 699, taken: 1269, openingsWon: 1, openingsLost: 2 },
		]);
	});

	test("lists teammates nowhere and coaches never", () => {
		const lines = matchDuels(details([me, ally, foe, coach], { pairs: [], openings: [] }), me)!;
		expect(lines.map((line) => line.player.subject)).toEqual(["Foe"]);
	});

	test("treats everyone as an opponent in deathmatch", () => {
		const solo = [player("Me", "a"), player("B", "b"), player("C", "c")];
		const lines = matchDuels(details(solo, { pairs: [], openings: [] }), solo[0])!;
		expect(lines.map((line) => line.player.subject)).toEqual(["B", "C"]);
	});

	test("is unavailable for scoreboards reduced before duels existed", () => {
		expect(matchDuels(details([me, foe]), me)).toBeNull();
	});
});
