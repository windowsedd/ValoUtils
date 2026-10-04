import { expect, test } from "bun:test";
import type { MatchDetails, MatchPlayer } from "@/types/matches";
import type { MatchAssets } from "./match-scoreboard";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => undefined },
});
const { buildMatchAnalysisContext } = await import("./match-ai-analysis");
const assets: MatchAssets = {
  agents: new Map([["sage", { name: "Sage", icon: "" }]]),
  maps: new Map(),
  tiers: new Map(),
  seasons: new Map(),
};
const player = (isSelf: boolean, teamId: string): MatchPlayer =>
  ({
    subject: "private-puuid",
    gameName: "PrivateName",
    tagLine: "SECRET",
    isSelf,
    teamId,
    characterId: "sage",
    competitiveTier: 18,
    kills: 20,
    deaths: 10,
    assists: 5,
    acs: 240,
    dpr: 150,
    firstBloods: 3,
    headshotPercent: 30,
  }) as MatchPlayer;
const match = (players: MatchPlayer[]): MatchDetails =>
  ({
    mapId: "/Game/Maps/Ascent/Ascent",
    queueId: "competitive",
    rounds: 22,
    teams: [
      { teamId: "Blue", won: true, roundsWon: 13 },
      { teamId: "Red", won: false, roundsWon: 9 },
    ],
    players,
  }) as MatchDetails;
test("match context anonymizes players and includes self stats", () => {
  const context = buildMatchAnalysisContext(
    match([player(true, "Blue"), player(false, "Blue"), player(false, "Red")]),
    assets,
  );
  for (const secret of ["PrivateName", "SECRET", "private-puuid"])
    expect(context).not.toContain(secret);
  for (const label of ["You", "Ally 1", "Enemy 1", "Sage", "240", "150", "Ascent"])
    expect(context).toContain(label);
});
test("missing self and free-for-all do not leak team identifiers", () => {
  const context = buildMatchAnalysisContext(
    match([player(true, "private-puuid"), player(false, "enemy-puuid")]),
    assets,
  );
  expect(context).toContain("Enemy 1");
  expect(context).not.toContain("puuid");
  expect(buildMatchAnalysisContext(match([]), assets).length).toBeLessThan(20001);
});
test("context cap holds with oversized asset labels", () => {
  const big = { ...assets, agents: new Map([["sage", { name: "x".repeat(30000), icon: "" }]]) };
  expect(buildMatchAnalysisContext(match([player(true, "Blue")]), big).length).toBeLessThan(20001);
});
