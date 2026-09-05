import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompetitiveSeason } from "../../types/live-game";
import { formatPreviousActLabel, previousActCards } from "./previous-acts";

const season = (
  seasonId: string,
  overrides: Partial<CompetitiveSeason> = {},
): CompetitiveSeason => ({
  seasonId,
  tier: 18,
  rankedRating: 40,
  wins: 10,
  games: 19,
  winsByTier: { "18": 8, "21": 2 },
  ...overrides,
});

const starts = new Map([
  ["act-now", 6],
  ["act-two", 4],
  ["act-one", 2],
  ["act-zero", 0],
]);
const labels = new Map([
  ["act-now", "V26A5"],
  ["act-two", "V26A4"],
  ["act-one", "V25A6"],
  ["act-zero", "V25A5"],
]);

describe("previous act labels", () => {
  test("inserts a colon before the act number", () => {
    expect(formatPreviousActLabel("V26A4")).toBe("V26:A4");
    expect(formatPreviousActLabel("V25A6")).toBe("V25:A6");
    expect(formatPreviousActLabel("E5A3")).toBe("E5:A3");
  });

  test("leaves non-standard labels alone", () => {
    expect(formatPreviousActLabel("12345678")).toBe("12345678");
  });
});

describe("previous act cards", () => {
  test("drops the current act and keeps newest previous peaks", () => {
    const cards = previousActCards(
      [
        season("act-now", { winsByTier: { "20": 4 } }),
        season("act-two"),
        season("act-one", { winsByTier: { "21": 9 }, games: 9, wins: 8 }),
      ],
      "act-now",
      starts,
      labels,
    );
    expect(cards.map((card) => card.seasonId)).toEqual(["act-two", "act-one"]);
    expect(cards[0]).toMatchObject({
      label: "V26:A4",
      peakTier: 21,
      games: 19,
      wins: 10,
      winRate: (10 / 19) * 100,
    });
    expect(cards[1].peakTier).toBe(21);
  });

  test("treats acts with no ranked wins as unrated", () => {
    const [card] = previousActCards(
      [season("act-one", { tier: 0, wins: 0, games: 1, winsByTier: {} })],
      "act-now",
      starts,
      labels,
    );
    expect(card.peakTier).toBe(0);
    expect(card.games).toBe(1);
    expect(card.winRate).toBe(0);
  });

  test("is empty while still in party or with only the current act", () => {
    expect(previousActCards([season("act-now")], "act-now", starts, labels)).toEqual([]);
  });
});

describe("live match wiring", () => {
  test("expanded live-match players render the previous acts strip", () => {
    const table = readFileSync(join(import.meta.dir, "live-scout-table.tsx"), "utf8");
    expect(table).toContain("<PreviousActsPanel");
    expect(table).toContain("inMatch");
    expect(table).toContain('snapshot.state === "coregame" || snapshot.state === "pregame"');
  });

  for (const locale of ["en", "ko", "zh-TW"] as const) {
    test(`${locale} localizes previous acts copy`, () => {
      const messages = JSON.parse(
        readFileSync(join(import.meta.dir, `../../i18n/locales/${locale}.json`), "utf8"),
      );
      for (const key of ["previousActs", "peakRating", "unrated", "actMatches"] as const) {
        expect(messages.liveGame[key]).toBeString();
        expect(messages.liveGame[key].trim().length).toBeGreaterThan(0);
      }
      expect(messages.liveGame.actMatches).toContain("{{count}}");
    });
  }
});
