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
