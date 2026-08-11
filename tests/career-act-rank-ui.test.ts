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
});
