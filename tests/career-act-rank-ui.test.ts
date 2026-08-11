import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const career = readFileSync(join(root, "src/pages/PlayerCareer.tsx"), "utf8");

describe("Career Act Rank", () => {
	test("renders the shared Act Rank panel before recent matches", () => {
		expect(career).toContain("<ActRankPanel");
		expect(career).toContain("competitiveSeasons={data.competitiveSeasons}");
		expect(career.indexOf("<ActRankPanel")).toBeLessThan(career.indexOf("<FriendMatchHistory"));
	});

	test("loads season assets and initializes the selected act", () => {
		expect(career).toContain("getSeasonAssets");
		expect(career).toContain("initialSeasonId");
	});

	test("keeps rank details in the Current Rank card but removes them from the page header", () => {
		const headerStart = career.indexOf("<PageHeader");
		const contentStart = career.indexOf('<div className="flex min-h-0', headerStart);
		const header = career.slice(headerStart, contentStart);

		expect(headerStart).toBeGreaterThan(-1);
		expect(contentStart).toBeGreaterThan(headerStart);
		expect(header).not.toContain("<RankBadge");
		expect(header).not.toContain("tierName(currentTier)");
		expect(header).not.toContain("currentTier > 0");

		const currentRank = career.slice(career.indexOf('title={t("career.currentRank")}'));
		expect(currentRank).toContain("<RankBadge");
		expect(currentRank).toContain("tierName(currentTier)");
		expect(currentRank).toContain("{currentRR} RR");
	});
});
