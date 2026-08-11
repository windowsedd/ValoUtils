import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const profile = readFileSync(join(root, "src/components/friends/friend-profile.tsx"), "utf8");
const matchHistory = readFileSync(
	join(root, "src/components/friends/friend-competitive-history.tsx"),
	"utf8",
);
const locales = ["en", "ko", "zh-TW"] as const;

describe("Friend profile rank summary", () => {
	test("renders the peak tier with a localized label", () => {
		expect(profile).toMatch(/profile\??\.peakTier/);
		expect(profile).toContain('t("friends.profilePeakRank")');
	});

	test("renders the episode and act for the peak rank", () => {
		expect(profile).toMatch(/profile\??\.peakSeasonId/);
		expect(profile).toContain('t("friends.profileEpisodeAct")');
	});

	test("shows the selected friend's agent portrait in match rows", () => {
		expect(matchHistory).toContain("assets.agents.get(player.characterId.toLowerCase())");
		expect(matchHistory).toContain("localize(agent.name)");
	});

	for (const locale of locales) {
		test(`${locale} provides the Peak Rank label`, () => {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			);
			expect(messages.friends.profilePeakRank).toBeString();
			expect(messages.friends.profilePeakRank.trim().length).toBeGreaterThan(0);
			expect(messages.friends.profileEpisodeAct).toBeString();
			expect(messages.friends.profileEpisodeAct.trim().length).toBeGreaterThan(0);
		});
	}
});
