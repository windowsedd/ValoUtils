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
    const contentStart = career.indexOf("pageBodyClass", headerStart);
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

describe("match list column headers", () => {
  test("labels KDA ACS DPR FB and HS on recent matches", () => {
    const matches = readFileSync(join(root, "src/pages/Matches.tsx"), "utf8");
    expect(matches).toContain("data-match-list-headers");
    expect(matches).toContain('t("matches.kda")');
    expect(matches).toContain('t("matches.acs")');
    expect(matches).toContain('t("matches.dpr")');
    expect(matches).toContain('t("matches.fb")');
    expect(matches).toContain('t("matches.hs")');
    expect(matches).toContain('t("matches.mode")');
    expect(matches).toContain('t("matches.map")');
  });
});

describe("page body spacing", () => {
  test("keeps a gap under the page header on every tab", () => {
    const sectionCard = readFileSync(join(root, "src/components/section-card.tsx"), "utf8");
    expect(sectionCard).toContain("pageBodyClass =");
    expect(sectionCard).toContain("pt-4");
    const pages = [
      "SettingsProfiles.tsx",
      "PlayerCareer.tsx",
      "Matches.tsx",
      "Friends.tsx",
      "Store.tsx",
      "BattlePass.tsx",
      "Settings.tsx",
      "About.tsx",
      "DummyBot.tsx",
      "SwaggerPage.tsx",
    ];
    for (const page of pages) {
      expect(readFileSync(join(root, "src/pages", page), "utf8")).toContain("pageBodyClass");
    }
    expect(readFileSync(join(root, "src/pages/Chat.tsx"), "utf8")).toContain("pt-4");
    expect(readFileSync(join(root, "src/pages/Inventory.tsx"), "utf8")).toContain("pt-4");
    expect(readFileSync(join(root, "src/pages/Tools.tsx"), "utf8")).toContain("pt-4");
    expect(
      readFileSync(join(root, "src/components/live-game/live-scout-table.tsx"), "utf8"),
    ).toContain("pt-4");
  });
});
