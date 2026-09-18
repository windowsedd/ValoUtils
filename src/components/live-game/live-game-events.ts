export const isCurrentStatsAttempt = (eventAttempt: number, currentAttempt: number) =>
  eventAttempt === currentAttempt;

export const liveStatsRequestKey = (puuids: readonly string[], queueId: string) =>
  `${puuids
    .map((puuid) => puuid.toLowerCase())
    .sort()
    .join(",")}:${queueId.toLowerCase()}`;

export const livePlayerStatsKey = (puuid: string) => puuid.toLowerCase();

export const shouldPreserveReadyStats = (
  requestedKey: string | null,
  lastRequestedKey: string | null,
  nextKey: string,
) => requestedKey === null && lastRequestedKey === nextKey;

/** Skip the match-history burst while the live snapshot is already throttled. */
export const shouldRequestLiveStats = (warning?: string | null) => warning !== "rateLimited";

/** Ally stats fetched in pregame must not be requested again once coregame adds the other team. */
export const playersNeedingLiveStats = (
  puuids: readonly string[],
  recent: Readonly<Record<string, { status: string }>>,
) => puuids.filter((puuid) => recent[livePlayerStatsKey(puuid)]?.status !== "ready");
