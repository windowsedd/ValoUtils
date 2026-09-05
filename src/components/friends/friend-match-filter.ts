import type { FriendMatch } from "@/types/friend-profile";

export const availableFriendQueues = (matches: FriendMatch[]): string[] => [
  ...new Set(matches.map((match) => match.queueId.toLowerCase())),
];

export const filterFriendMatches = (
  matches: FriendMatch[],
  queueId: string,
  limit = 15,
): FriendMatch[] =>
  (queueId === "all"
    ? matches
    : matches.filter((match) => match.queueId.toLowerCase() === queueId.toLowerCase())
  ).slice(0, limit);
