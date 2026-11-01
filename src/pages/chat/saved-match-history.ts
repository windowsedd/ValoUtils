import type { ChatChannel, ChatMessage, SavedChatMatch } from "@/types/chat";
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
  /** Last captured message time, falling back to the save time. */
  at: number;
  team: number;
  all: number;
  speakers: number;
  /** Latest line in the channel being viewed, or in either room if it has none. */
  last: ChatMessage | null;
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
    at: latest > 0 ? latest : match.updatedAt,
    team: team.length,
    all: all.length,
    speakers: new Set(both.map(message => message.sender).filter(Boolean)).size,
    last,
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
