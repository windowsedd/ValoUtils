import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatShotPercent, shotAccuracy } from "./match-accuracy";

const root = join(import.meta.dir, "../..");

describe("shot accuracy", () => {
  test("splits hits into head, body, and legs percents", () => {
    expect(shotAccuracy({ headshots: 20, bodyshots: 40, legshots: 5 })).toEqual({
      total: 65,
      zones: [
        { zone: "head", hits: 20, percent: (20 / 65) * 100 },
        { zone: "body", hits: 40, percent: (40 / 65) * 100 },
        { zone: "legs", hits: 5, percent: (5 / 65) * 100 },
      ],
    });
  });

  test("is zero when no shots landed", () => {
    expect(shotAccuracy({ headshots: 0, bodyshots: 0, legshots: 0 })).toEqual({
      total: 0,
      zones: [
        { zone: "head", hits: 0, percent: 0 },
        { zone: "body", hits: 0, percent: 0 },
        { zone: "legs", hits: 0, percent: 0 },
      ],
    });
  });

  test("formats two decimal places like the tracker readout", () => {
    expect(formatShotPercent(0)).toBe("0.00%");
    expect(formatShotPercent((20 / 65) * 100)).toBe("30.77%");
  });
});

describe("accuracy panel", () => {
  test("expanded scoreboard shows the body silhouette panel", () => {
    const scoreboard = readFileSync(join(import.meta.dir, "match-scoreboard.tsx"), "utf8");
    expect(scoreboard).toContain("<MatchAccuracy player={self} />");
  });

  for (const locale of ["en", "ko", "zh-TW"] as const) {
    test(`${locale} localizes accuracy zones and hit counts`, () => {
      const messages = JSON.parse(
        readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
      );
      for (const key of ["accuracy", "head", "body", "legs", "hits"] as const) {
        expect(messages.matches[key]).toBeString();
        expect(messages.matches[key].trim().length).toBeGreaterThan(0);
      }
      expect(messages.matches.hits).toContain("{{count}}");
    });
  }
});
