import type { ChatChannel, ChatMessage, SavedChatMatch, SavedMatchDetails } from "@/types/chat";
import { channelForCid, mergeChatMessages, messageTime } from "./chat-model";

export const savedMatchMessages = (match: SavedChatMatch | undefined, channel: ChatChannel) => {
  if (!match || (channel !== "team" && channel !== "all")) return [];
  return mergeChatMessages(match.messages.filter(message =>
    channelForCid(message.conversationId) === channel &&
    message.conversationId.toLowerCase().startsWith(`${match.matchUuid.toLowerCase()}-`),
  ));
};

export type SavedMatchSummary = {
  matchUuid: string;
  /** Match start when details are saved, else the last captured line, else the save time. */
  at: number;
  team: number;
  all: number;
  speakers: number;
  /** Latest line in the channel being viewed, or in either room if it has none. */
  last: ChatMessage | null;
  details: SavedMatchDetails | null;
};

export const summarizeSavedMatch = (
  match: SavedChatMatch,
  channel: "team" | "all",
): SavedMatchSummary => {
  const team = savedMatchMessages(match, "team");
  const all = savedMatchMessages(match, "all");
  const both = mergeChatMessages([...team, ...all]);
  const own = channel === "team" ? team : all;
  const last = own[own.length - 1] ?? both[both.length - 1] ?? null;
  const latest = both.reduce((max, message) => Math.max(max, messageTime(message)), 0);
  return {
    matchUuid: match.matchUuid,
    at: match.details?.startMillis || (latest > 0 ? latest : match.updatedAt),
    team: team.length,
    all: all.length,
    speakers: new Set(both.map(message => message.sender).filter(Boolean)).size,
    last,
    details: match.details ?? null,
  };
};

/** Newest first; a query keeps matches whose lines or speaker names contain it. */
export const savedMatchList = (
  matches: readonly SavedChatMatch[],
  channel: "team" | "all",
  query = "",
): SavedMatchSummary[] => {
  const needle = query.trim().toLowerCase();
  return matches
    .filter(match => !needle || savedMatchMessages(match, "team").concat(savedMatchMessages(match, "all"))
      .some(message => message.body.toLowerCase().includes(needle) || message.senderName.toLowerCase().includes(needle)))
    .map(match => summarizeSavedMatch(match, channel))
    .sort((a, b) => b.at - a.at || a.matchUuid.localeCompare(b.matchUuid));
};

const DAY = 86_400_000;

/** "today" / "yesterday" relative to `now` in local time, else null. */
export const relativeDay = (at: number, now: number): "today" | "yesterday" | null => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return "today";
  if (at >= start.getTime() - DAY) return "yesterday";
  return null;
};

export type MatchOutcome = "win" | "loss" | "draw";

export const matchOutcome = (details: SavedMatchDetails | null | undefined): MatchOutcome | null => {
  if (!details || details.won === null) return null;
  if (details.won) return "win";
  return details.roundsWon === details.roundsLost ? "draw" : "loss";
};

/** Saved matches with details fetched this session filled in, until the JSON copy arrives. */
export const withFetchedDetails = (
  matches: readonly SavedChatMatch[],
  fetched: ReadonlyMap<string, SavedMatchDetails>,
): SavedChatMatch[] =>
  matches.map(match => {
    const details = match.details ?? fetched.get(match.matchUuid);
    return details && details !== match.details ? { ...match, details } : match;
  });

/** Saved matches still missing details, newest saves first. */
export const matchesNeedingDetails = (matches: readonly SavedChatMatch[]): string[] =>
  matches
    .filter(match => !match.details)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.matchUuid.localeCompare(b.matchUuid))
    .map(match => match.matchUuid);
