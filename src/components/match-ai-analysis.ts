import type { MatchDetails } from "@/types/matches";
import type { MatchAssets } from "./match-scoreboard";
import { mapName } from "@/util/valorant-maps";
import { queueLabel } from "@/util/valorant-queues";
import { localize } from "@/util/valorant-assets";
import { tierName } from "@/util/valorant-ranks";

export function buildMatchAnalysisContext(details: MatchDetails, assets: MatchAssets): string {
  const self = details.players.find((p) => p.isSelf);
  const ownTeam = self && details.teams.find((team) => team.teamId === self.teamId);
  let allies = 0;
  let enemies = 0;
  return JSON.stringify({
    map: mapName(details.mapId, assets.maps),
    queue: queueLabel(details.queueId),
    result: ownTeam ? (ownTeam.won ? "Win" : "Loss") : "Unknown",
    rounds: details.rounds,
    score: details.teams.map((team) => ({
      team: self && team.teamId === self.teamId ? "mine" : "enemy",
      roundsWon: team.roundsWon,
    })),
    players: details.players
      .filter((p) => p.role !== "coach")
      .map((p) => {
        const mine = p.isSelf || (!!self && p.teamId === self.teamId);
        return {
          label: p.isSelf ? "You" : mine ? `Ally ${++allies}` : `Enemy ${++enemies}`,
          team: mine ? "mine" : "enemy",
          isSelf: p.isSelf,
          agent: localize(assets.agents.get(p.characterId.toLowerCase())?.name) || "Unknown",
          rank: tierName(p.competitiveTier),
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          acs: p.acs,
          dpr: p.dpr ?? p.adr,
          firstBloods: p.firstBloods,
          headshotPercent: p.headshotPercent,
        };
      }),
  }).slice(0, 20000);
}
