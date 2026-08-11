import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const modalPath = join(root, "src/components/match-player-profile-modal.tsx");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("clickable match player profiles", () => {
	test("provides a dedicated modal with profile states and shared career sections", () => {
		expect(existsSync(modalPath)).toBe(true);
		if (!existsSync(modalPath)) return;
		const modal = readFileSync(modalPath, "utf8");
		expect(modal).toContain("subscribeMatchPlayerProfile");
		expect(modal).toContain("profileLoading");
		expect(modal).toContain("profileFailed");
		expect(modal).toContain("<ActRankPanel");
		expect(modal).toContain("<FriendMatchHistory");
		expect(modal).toContain("playerProfilesEnabled={false}");
	});

	test("wires profile selection into Matches and shared friend match history", () => {
		const matches = source("src/pages/Matches.tsx");
		const history = source("src/components/friends/friend-competitive-history.tsx");
		for (const caller of [matches, history]) {
			expect(caller).toContain("useMatchPlayerProfileModal");
			expect(caller).toContain("onPlayerSelect={openMatchPlayerProfile}");
		}
	});

	test("keeps nested modal match histories from opening another profile modal", () => {
		expect(source("src/components/friends/friend-competitive-history.tsx")).toContain(
			"playerProfilesEnabled = true",
		);
	});

	test("cleans up only its own match-detail listener when the modal closes", () => {
		const scoreboard = source("src/components/match-scoreboard.tsx");
		expect(scoreboard).toContain('removeListener("match:details", onMatchDetails)');
		expect(scoreboard).not.toContain('removeAllListeners("match:details")');
	});
});
