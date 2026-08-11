export const isCurrentStatsAttempt = (eventAttempt: number, currentAttempt: number) =>
	eventAttempt === currentAttempt;

export const liveStatsRequestKey = (rosterKey: string, queueId: string) =>
	`${rosterKey}:${queueId.toLowerCase()}`;
