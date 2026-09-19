import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const table = readFileSync(join(root, "src/components/live-game/live-scout-table.tsx"), "utf8");
const liveGamePage = readFileSync(join(root, "src/pages/LiveGame.tsx"), "utf8");
const main = readFileSync(join(root, "src/main.tsx"), "utf8");
const liveGameSession = readFileSync(
  join(root, "src/components/live-game/live-game-session.tsx"),
  "utf8",
);
const locales = ["en", "ko", "zh-TW"] as const;

describe("Live Match signed-in player marker", () => {
  test("the player row conditionally renders the localized Me badge", () => {
    expect(table).toContain("player.isSelf");
    expect(table).toContain('t("liveGame.me")');
  });

  for (const locale of locales) {
    test(`${locale} provides the Me badge copy`, () => {
      const messages = JSON.parse(
        readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
      );
      expect(messages.liveGame.me).toBeString();
      expect(messages.liveGame.me.trim().length).toBeGreaterThan(0);
    });
  }

  test("desktop grids cap the player column and keep spare width at the right edge", () => {
    expect(table.match(/md:grid-cols-\[minmax\(180px,300px\)/g)?.length).toBe(2);
    expect(table.match(/minmax\(34px,1fr\)\]/g)?.length).toBe(4);
  });

  test("shows damage per round next to ACS on live player stats", () => {
    expect(table).toContain('t("liveGame.dpr")');
    expect(table).toContain('field="dpr"');
    expect(table).toContain("stats.stats.dpr");
  });

  test("shows rank shields beside RR after recent stats resolve", () => {
    expect(table).toContain("<RankShieldBadge");
    expect(table).toContain(
      'remaining={stats?.status === "ready" ? stats.stats.rankShields : null}',
    );
  });

  test("does not expose the raw live-game dump control", () => {
    expect(liveGamePage).not.toContain('window.Main.send("live-game:dump")');
    expect(liveGamePage).not.toContain("FaDownload");
  });

  test("carries no pregame debug output", () => {
    // The dump was a developer-only panel of PUUIDs and merge counters. Nothing
    // reads it now, and nothing should put it back without a decision.
    expect(liveGamePage).not.toContain("openDevTools");
    expect(liveGamePage).not.toContain("developer");
    expect(table).not.toContain("pregameDebug");
    expect(table).not.toContain("PREGAME DEBUG");
  });

  test("pregame roster shows both teams, hidden agents, and fallback copy", () => {
    expect(table).toContain('t("liveGame.pregameRoster"');
    expect(table).toContain('t("liveGame.enemyRosterUnavailable")');
    expect(table).toContain('t("liveGame.hiddenAgent")');
    expect(table).toContain("agentFallback");
    expect(table).toContain("StreakBadge");
    expect(table).toContain("winStreak");
  });

  test("party colors are anonymous and hidden for solo players", () => {
    expect(table).toContain("groupPlayersByParty(players)");
    expect(table).toContain('t("liveGame.partyDetected", { party: player.party })');
    expect(table).toContain("partyColor(player.party)");
    expect(table).not.toContain(
      'className="w-2 h-2 rounded-full shrink-0" title={t("liveGame.partyDetected"',
    );
    expect(table).not.toContain(
      'aria-label={t("liveGame.unavailable")} className="text-[10px] text-gray-700"',
    );
    expect(table).not.toContain("player.partyId");
    expect(table).not.toContain("player.historicalParty");
    expect(table).not.toContain("player.partyConfidence");
  });

  test("party members use their shared color on the player row rail and label", () => {
    // The rail marks a party, not a team: it no longer takes a team colour
    // fallback, which used to put an identical bar on every row.
    expect(table).toContain("rowAccentColor(player.party)");
    expect(table).toContain("borderLeft: `3px solid ${rowAccentColor(player.party)}`");
    expect(table).not.toContain("teamColor");
    expect(table).toContain("color: partyColor(player.party)");
    expect(table).toContain(
      'const partyLabel = player.party ? t("liveGame.partyDetected", { party: player.party }) : null;',
    );
    expect(table).toContain('partyLabel ? `, ${partyLabel}` : ""');
  });

  test("rate-limit errors use localized copy instead of raw Riot output", () => {
    expect(table).toContain('error === "rateLimited"');
    expect(table).toContain('t("liveGame.rateLimited")');
    expect(table).toContain('error === "unavailable" ? t("liveGame.failedToLoad") : error');
  });

  test("shows the loading panel while a live match fetch replaces an idle snapshot", () => {
    expect(liveGamePage).toContain('loading && (!snapshot || snapshot.state === "idle")');
  });

  test("live match publishes the roster before pd ranks finish", () => {
    const liveBackend = readFileSync(join(root, "src-tauri/src/commands/live.rs"), "utf8");
    expect(liveBackend).toContain('app.emit("live-game:fetch"');
    expect(liveBackend).toContain("fetch_mmr: false");
    expect(liveBackend.indexOf("fetch_mmr: false")).toBeLessThan(
      liveBackend.indexOf("fetch_mmr: true"),
    );
  });

  test("live match reuses ready ally stats in coregame and skips stats while throttled", () => {
    expect(liveGameSession).toContain("shouldRequestLiveStats(response.warning)");
    expect(liveGameSession).toContain("playersNeedingLiveStats(puuids, recentRef.current)");
    expect(liveGameSession).toContain("existing?.status === \"ready\" ? existing");
  });

  test("keeps live match requests running on other pages", () => {
    expect(main).toContain("<LiveGameProvider>");
    expect(main).toContain("</LiveGameProvider>");
    expect(liveGameSession).toContain("timer = window.setTimeout(poll, pollDelayRef.current)");
    expect(liveGameSession).toContain('if (!document.hidden) window.Main.send("live-game:fetch")');
    expect(liveGamePage).not.toContain("setTimeout(poll");
    expect(liveGamePage).not.toContain("visibilitychange");
  });

  test("background live session only sends live-game channels", () => {
    const sends = [...liveGameSession.matchAll(/window\.Main\.send\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.every((channel) => channel.startsWith("live-game:"))).toBe(true);
  });

  for (const locale of locales) {
    test(`${locale} provides pregame roster copy`, () => {
      const messages = JSON.parse(
        readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
      );
      for (const key of [
        "enemyRosterUnavailable",
        "pregameRoster",
        "hiddenAgent",
        "winStreak",
        "loseStreak",
        "winStreakHint",
        "loseStreakHint",
        "rateLimited",
      ] as const) {
        expect(messages.liveGame[key]).toBeString();
        expect(messages.liveGame[key].trim().length).toBeGreaterThan(0);
      }
      expect(messages.liveGame.hiddenAgent).toBe("???");
    });
  }
});
