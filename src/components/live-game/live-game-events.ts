export const isCurrentStatsAttempt = (eventAttempt: number, currentAttempt: number) =>
  eventAttempt === currentAttempt;

export const liveStatsRequestKey = (puuids: readonly string[], queueId: string) =>
  `${puuids
    .map((puuid) => puuid.toLowerCase())
    .sort()
    .join(",")}:${queueId.toLowerCase()}`;

export const livePlayerStatsKey = (puuid: string) => puuid.toLowerCase();

export const LIVE_POLL_MS = 5000;
// Idle means VALORANT is not running — the client puts you in a party of one the
// moment it is. Nothing can change until it launches, so stop asking so often.
export const LIVE_IDLE_POLL_MS = 15000;
export const LIVE_MAX_POLL_MS = 30000;

/**
 * Delay before the next Live Game poll. An unchanged answer doubles the wait up
 * to 30s; any change snaps back to 5s. Agent select and a party in queue stay
 * at 5s so locks and a found match land quickly.
 */
export const nextLivePollDelay = (state: string, unchanged: boolean, previousDelay: number, inQueue = false) => {
  if (state === "idle") return LIVE_IDLE_POLL_MS;
  if (state === "pregame" || inQueue || !unchanged) return LIVE_POLL_MS;
  return Math.min(Math.max(previousDelay, LIVE_POLL_MS) * 2, LIVE_MAX_POLL_MS);
};

/** While paused for a match, still ask once a minute in case the end signal is missed. */
export const LIVE_PAUSED_HEARTBEAT_MS = 60000;

/**
 * Whether a snapshot should pause Live Game polling. Core-game keeps serving a
 * finished match for a while, so the match chat already reported as ended must
 * not pause again, or the next match is never noticed.
 */
export const shouldPauseForSnapshot = (state: string, matchId: string | null | undefined, endedMatchId: string | null) =>
  state === "coregame" && !(matchId && endedMatchId && matchId.toLowerCase() === endedMatchId.toLowerCase());

export const shouldPreserveReadyStats = (
  requestedKey: string | null,
  lastRequestedKey: string | null,
  nextKey: string,
) => requestedKey === null && lastRequestedKey === nextKey;

/** Skip the match-history burst while the live snapshot is already throttled. */
/** Stats spend the PD budget, so hold them while it is cooling down, even when the roster itself is complete. */
export const shouldRequestLiveStats = (warning?: string | null, retryInSeconds?: number | null) =>
  warning !== "rateLimited" && !retryInSeconds;

/** Ally stats fetched in pregame must not be requested again once coregame adds the other team. */
export const playersNeedingLiveStats = (
  puuids: readonly string[],
  recent: Readonly<Record<string, { status: string }>>,
) => puuids.filter((puuid) => recent[livePlayerStatsKey(puuid)]?.status !== "ready");
