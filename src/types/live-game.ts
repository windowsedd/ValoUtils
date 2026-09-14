export type LiveState = "coregame" | "pregame" | "party" | "idle";

export type LiveGameEvent = {
  id: string;
  kind: "agent-lock";
  /** Unix milliseconds when the backend first observed the event. */
  observedAt: number;
  playerId: string;
  agentId: string;
};

export type WeaponSkin = {
  skinId?: string;
  levelId?: string;
  chromaId?: string;
} | null;

export type LiveLoadout = {
  vandal: WeaponSkin;
  phantom: WeaponSkin;
  knife: WeaponSkin;
};

export type CompetitiveSeason = {
  seasonId: string;
  tier: number;
  rankedRating: number;
  wins: number;
  games: number;
  winsByTier: Record<string, number>;
};

export type LivePlayer = {
  puuid: string;
  gameName: string;
  tagLine: string;
  /** Riot team id ("Blue" / "Red") in coregame, agent team in pregame. */
  teamId: string | null;
  characterId: string | null;
  cardId: string | null;
  /** Account level, or null when the player hides it. */
  level: number | null;
  currentTier: number;
  currentRR: number;
  peakTier: number;
  /** Competitive act/season UUID of the peak; resolved to a label client-side. */
  peakSeasonId: string | null;
  currentSeasonId: string | null;
  competitiveSeasons: CompetitiveSeason[];
  /** "Team 1" / "Team 2" … when a multi-player party is detected, else null. */
  party: string | null;
  isSelf: boolean;
  incognito: boolean;
  /** In your actual Riot party (or you). Incognito never hides these names. */
  inMyParty?: boolean;
  loadout: LiveLoadout | null;
};

export type LiveMatchContext = {
  id: string | null;
  mapId: string | null;
  modeId: string | null;
  queueId: string;
  phase: Exclude<LiveState, "idle">;
};

export type LiveTeamSummary = {
  id: string;
  averageTier: number | null;
  ratedPlayers: number;
};

export type PlayerStreak = {
  kind: "win" | "lose" | null;
  matches: number;
  rr: number;
};

export type RecentPlayerStats = {
  matches: number;
  kills: number;
  deaths: number;
  assists: number;
  wins: number;
  kd: number;
  winRate: number;
  acs: number;
  dpr: number;
  rankShields: 0 | 1 | 2 | null;
  history: RecentMatchSummary[];
  streak?: PlayerStreak;
};

export type RecentMatchSummary = {
  matchId: string;
  startMillis: number;
  mapId: string;
  agentId: string;
  won: boolean;
  allyRounds: number;
  enemyRounds: number;
  kills: number;
  deaths: number;
  assists: number;
  acs: number;
  dpr: number;
};

export type RecentStatsState =
  | { status: "loading" }
  | { status: "ready"; stats: RecentPlayerStats }
  | { status: "error"; error: string };

export type RecentStatsEvent =
  | {
      rosterKey: string;
      attemptId: number;
      puuid: string;
      success: true;
      stats: RecentPlayerStats;
      error: null;
    }
  | {
      rosterKey: string;
      attemptId: number;
      puuid: string;
      success: false;
      stats: null;
      error: string;
    };

export type LiveGameResponse =
  | {
      success: true;
      state: LiveState;
      rosterKey: string;
      match: LiveMatchContext | null;
      teams: LiveTeamSummary[];
      players: LivePlayer[];
      events?: LiveGameEvent[];
      warning?: "rateLimited" | "unavailable" | null;
      /** Seconds until throttled requests are worth trying again. */
      retryInSeconds?: number | null;
    }
  | { success: false; code: "loginRequired" }
  | { success: false; error: string };
