/** One row from `/match-history/v1/history` — enough to render the collapsed list. */
export type MatchListEntry = {
  matchId: string;
  startMillis: number;
  queueId: string;
};

export type MatchTeam = {
  /** "Red" | "Blue", or a puuid in free-for-all modes like Deathmatch. */
  teamId: string;
  won: boolean;
  roundsWon: number;
  roundsPlayed: number;
};

export type MatchPlayer = {
  subject: string;
  gameName: string;
  tagLine: string;
  role: "player" | "coach";
  teamId: string;
  partyId: string;
  characterId: string;
  competitiveTier: number;
  playerCard: string;
  accountLevel: number;
  isSelf: boolean;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  roundsPlayed: number;
  /** Average Combat Score — computed backend-side, Riot doesn't return it. */
  acs: number;
  damage: number;
  /** Average Damage per Round — same value as `dpr`, kept for older clients. */
  adr: number;
  /** Damage per round. */
  dpr: number;
  /** Rounds where this player got the first kill. */
  firstBloods: number;
  headshots: number;
  bodyshots: number;
  legshots: number;
  headshotPercent: number;
};

export type MatchDetails = {
  matchId: string;
  mapId: string;
  queueId: string;
  gameMode: string;
  /** e.g. "aresriot.aws-ape1-prod.ap-gp-hongkong-1" */
  server: string;
  gameVersion: string;
  seasonId: string;
  startMillis: number;
  lengthMillis: number;
  isRanked: boolean;
  completionState: string;
  provisioningFlow: string;
  rounds: number;
  teams: MatchTeam[];
  players: MatchPlayer[];
};

export type MatchListResponse =
  | { success: true; matches: MatchListEntry[]; total: number; puuid: string }
  | { success: false; code: "loginRequired"; error?: string }
  | { success: false; code: null; error: string };

export type MatchDetailsResponse =
  | { success: true; match: MatchDetails; cached: boolean }
  | { success: false; matchId?: string; error: string };
