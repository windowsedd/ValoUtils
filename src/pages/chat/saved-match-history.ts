import type { ChatChannel, ChatMessage, SavedChatMatch, SavedMatchDetails, SavedSpeaker } from "@/types/chat";
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
  /** Who wrote the saved lines, from [`savedMatchSpeakers`]. */
  roster: SavedSpeaker[];
};

/**
 * Speakers of a saved match: those captured from the Live Game roster, with
 * match-details values taking over wherever they are filled in.
 */
export const savedMatchSpeakers = (match: SavedChatMatch | null | undefined): SavedSpeaker[] => {
  const byPuuid = new Map<string, SavedSpeaker>();
  for (const speaker of [...(match?.speakers ?? []), ...(match?.details?.speakers ?? [])]) {
    const puuid = speaker.puuid.toLowerCase();
    const known = byPuuid.get(puuid);
    byPuuid.set(puuid, {
      puuid,
      name: speaker.name || known?.name || "",
      agentId: speaker.agentId || known?.agentId || "",
    });
  }
  return [...byPuuid.values()];
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
    roster: savedMatchSpeakers(match),
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
    // Details saved before speakers were kept are replaced by a fresh lookup.
    const details = match.details?.speakers ? match.details : (fetched.get(match.matchUuid) ?? match.details);
    return details && details !== match.details ? { ...match, details } : match;
  });

/** Saved matches still missing details, newest saves first. */
export const matchesNeedingDetails = (matches: readonly SavedChatMatch[]): string[] =>
  matches
    .filter(match => !match.details?.speakers)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.matchUuid.localeCompare(b.matchUuid))
    .map(match => match.matchUuid);

/**
 * Saved speakers keyed by PUUID, in the shape the chat thread resolves senders
 * from. Saved speakers (with agents) win over the history name list.
 */
export const savedSpeakerRoster = (
  speakers: readonly SavedSpeaker[] | undefined,
  names: Readonly<Record<string, string>> = {},
) => {
  const roster = new Map<string, { name: string; agentId: string | null; cardId: string | null }>(
    Object.entries(names).map(([puuid, name]) => [puuid.toLowerCase(), { name, agentId: null, cardId: null }]),
  );
  for (const speaker of speakers ?? []) {
    roster.set(speaker.puuid.toLowerCase(), {
      name: speaker.name || roster.get(speaker.puuid.toLowerCase())?.name || "",
      agentId: speaker.agentId || null,
      cardId: null,
    });
  }
  return roster;
};

const PUUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A saved line's speaker: their saved Riot ID (from the saved speakers, then
 * the history's name list), else a readable sender name, else "".
 */
export const savedSenderName = (
  message: ChatMessage,
  speakers: readonly SavedSpeaker[] | undefined,
  names: Readonly<Record<string, string>> = {},
) => {
  const id = message.sender.split("@")[0]!.toLowerCase();
  const speaker = speakers?.find(entry => entry.puuid.toLowerCase() === id);
  if (speaker?.name) return speaker.name;
  if (names[id]) return names[id];
  const labeled = message.senderName.trim();
  return labeled && !PUUID_LIKE.test(labeled.split("@")[0]!) ? labeled : "";
};
