import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "src/main.tsx"), "utf8");
const page = readFileSync(join(root, "src/pages/BattlePass.tsx"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;
const requiredBattlepassKeys = [
  "title",
  "loading",
  "failedToLoad",
  "loginRequired",
  "loginRequiredDesc",
  "level",
  "levelValue",
  "xpToNext",
  "complete",
  "premium",
  "freeTrack",
  "premiumTrack",
  "page",
  "epilogue",
  "claimed",
  "locked",
  "kindBattle",
  "kindEvent",
  "selectPass",
  "selectEvent",
  "noPass",
  "noPassDesc",
  "noEvent",
  "noEventDesc",
  "rewards",
  "daysLeft",
  "endsToday",
  "ended",
  "notStarted",
] as const;

describe("Battle Pass navigation and page viewer", () => {
  test("adds a hideable Battle Pass route after Store", () => {
    expect(main).toContain('import BattlePass from "@/pages/BattlePass.tsx"');
    expect(main).toContain('title: "nav.battlePass"');
    expect(main).toContain('id: "battle-pass"');
    expect(main.indexOf('id: "store"')).toBeLessThan(main.indexOf('id: "battle-pass"'));
    expect(main.indexOf('id: "battle-pass"')).toBeLessThan(main.indexOf('id: "settings"'));
  });

  test("loads player progress over IPC and joins valorant-api.com pages", () => {
    expect(page).toContain('send("battlepass:get"');
    expect(page).toContain('send("analytics:track", "battlepass:view"');
    expect(page).toContain("getBattlepassContracts");
    expect(page).toContain("getBattlepassReward");
    expect(page).toContain("data-battlepass-pages=");
    expect(page).toContain("data-battlepass-kind=");
    expect(page).toContain("data-battlepass-reward=");
    expect(page).toContain("buildChapterViews");
    expect(page).toContain("passesOfKind(catalog, kind)");
  });

  for (const locale of locales) {
    test(`${locale} localizes Battle Pass navigation and viewer states`, () => {
      const messages = JSON.parse(
        readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
      );
      expect(messages.nav.battlePass).toBeString();
      expect(messages.nav.battlePass.trim().length).toBeGreaterThan(0);
      for (const key of requiredBattlepassKeys) {
        expect(messages.battlepass[key]).toBeString();
        expect((messages.battlepass[key] as string).trim().length).toBeGreaterThan(0);
      }
    });
  }
});
