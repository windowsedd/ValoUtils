import type {
  ChatChannel,
  ChatConversation,
  ChatFriend,
  ChatMessage,
  ChatPresenceSnapshot,
  ChatRoomKey,
  ChatRooms,
  ChatRound,
} from "@/types/chat";

export type FriendConversation = {
  cid: string;
  title: string;
  participantPuuid: string;
  playerCardId?: string;
  statusKey: FriendGameStatus;
  unreadCount: number;
  latestTime: number;
  messages: ChatMessage[];
};

/** Riot still reports the old unread count until the client ACK lands. */
export const visibleUnreadCount = (riotUnread: number, markedAtUnread?: number) => {
  if (!Number.isFinite(riotUnread) || riotUnread <= 0) return 0;
  if (markedAtUnread == null) return riotUnread;
  return riotUnread > markedAtUnread ? riotUnread : 0;
};

export const lastConversationMessageId = (messages: ChatMessage[], cid: string, fallback = "") =>
  [...messages]
    .reverse()
    .find((message) => message.conversationId === cid && message.id && message.id !== cid)?.id ||
  fallback;

/**
 * Survives Chat remounts in this session. Opening a DM hid the badge, then
 * clicking Chat again restored it because React state reset while Riot still
 * reported the old unread_count.
 */
export const sessionMarkedUnread: Record<string, number> = {};

export const rememberMarkedUnread = (cid: string, riotUnread: number) => {
  const next = Math.max(riotUnread, sessionMarkedUnread[cid] ?? 0);
  if (next > 0) sessionMarkedUnread[cid] = next;
  return next;
};

/**
 * Undo an optimistic mark-read.
 *
 * The badge is hidden the moment it is clicked, before Riot has accepted
 * anything. When the request comes back a failure the count has to return, or
 * the app quietly claims to have read a conversation the game still shows as
 * unread.
 */
export const forgetMarkedUnread = (
  cid: string,
  marked: Record<string, number>,
): Record<string, number> => {
  delete sessionMarkedUnread[cid];
  if (marked[cid] == null) return marked;
  const next = { ...marked };
  delete next[cid];
  return next;
};

export const forgetMarkedUnreadIfCleared = (
  conversations: Array<{ cid: string; unreadCount: number }>,
  marked: Record<string, number>,
) => {
  const next = { ...marked };
  let changed = false;
  for (const conversation of conversations) {
    if (conversation.unreadCount > 0 || next[conversation.cid] == null) continue;
    delete next[conversation.cid];
    delete sessionMarkedUnread[conversation.cid];
    changed = true;
  }
  return changed ? next : marked;
};

export type FriendGameStatus =
  | "offline"
  | "checking"
  | "reconnecting"
  | "inMatch"
  | "agentSelect"
  | "inLobby"
  | "away"
  | "online";

export const resolveFriendGameStatus = (friend: ChatFriend | undefined): FriendGameStatus => {
  if (friend?.presenceState === "syncing") return "checking";
  if (friend?.presenceState === "reconnecting") return "reconnecting";
  if (!friend?.isOnline) return "offline";
  if (friend.sessionLoopState === "INGAME") return "inMatch";
  if (friend.sessionLoopState === "PREGAME") return "agentSelect";
  if (friend.sessionLoopState === "MENUS") return "inLobby";
  if (friend.status.toLocaleLowerCase() === "away") return "away";
  return "online";
};

const presenceProductPriority = (product: string) => {
  switch (product.toLocaleLowerCase()) {
    case "valorant":
      return 3;
    case "league_of_legends":
      return 2;
    case "riot_client":
    case "keystone":
      return 1;
    default:
      return 0;
  }
};

const presenceCardId = (value: unknown): string => {
  if (!value || typeof value !== "object") return "";
  const blob = value as { playerCardId?: unknown; playerPresenceData?: { playerCardId?: unknown } };
  const id = blob.playerPresenceData?.playerCardId ?? blob.playerCardId;
  return typeof id === "string" ? id : "";
};

export const applyPresenceSnapshot = (
  friends: ChatFriend[],
  snapshot: ChatPresenceSnapshot,
): ChatFriend[] =>
  friends.map((friend) => {
    const friendId = friend.puuid.toLocaleLowerCase();
    const resources =
      Object.entries(snapshot.friends).find(
        ([puuid]) => puuid.toLocaleLowerCase() === friendId,
      )?.[1] ?? [];
    const selected = [...resources].sort(
      (left, right) =>
        presenceProductPriority(right.product) - presenceProductPriority(left.product),
    )[0];
    const ready = snapshot.state === "ready";
    return {
      ...friend,
      presenceState: snapshot.state,
      isOnline: ready && resources.length > 0,
      product: ready ? (selected?.product ?? "") : "",
      status: ready ? (selected?.status ?? "offline") : "offline",
      statusMessage: ready ? (selected?.statusMessage ?? "") : "",
      sessionLoopState: ready ? (selected?.sessionLoopState ?? "") : "",
      playerCardId: presenceCardId(selected?.private) || friend.playerCardId,
    };
  });

type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

const messageTime = (message: ChatMessage) => {
  const numeric = Number(message.timestamp);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = message.timestamp ? Date.parse(message.timestamp) : 0;
  return Number.isNaN(parsed) ? 0 : parsed;
};

const fallbackKey = (message: ChatMessage) =>
  `${message.conversationId}:${message.timestamp ?? ""}:${message.sender}:${message.body}`;

export const chatMessageKey = (message: ChatMessage) =>
  message.id ? `${message.conversationId}:${message.id}` : fallbackKey(message);

/**
 * Clock reading for the transcript gutter and the conversation list.
 *
 * Always 24-hour. A log column has to be one fixed width or the whole ruler
 * bends, and localised 12-hour time is 8 characters ("09:24 PM") against 5
 * ("21:24") — it wrapped the gutter onto two lines and doubled every row.
 */
export const formatClock = (value: string | number | null | undefined) => {
  // A conversation with no messages carries latestTime 0. Epoch zero is never a
  // real chat timestamp, so it reads as "no time" rather than "00:00".
  if (value === null || value === undefined || value === "" || value === 0) return "";
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

/** Messages closer together than this read as one burst from the same speaker. */
const groupWindowMs = 5 * 60 * 1000;

/**
 * Whether a message opens a new group in the transcript — i.e. whether it needs
 * its own sender header. Consecutive messages from one person inside the group
 * window hang under the first, so a burst reads as a burst.
 */
export const startsMessageGroup = (previous: ChatMessage | undefined, current: ChatMessage) => {
  if (!previous) return true;
  if (previous.sender !== current.sender) return true;
  const gap = messageTime(current) - messageTime(previous);
  return !(gap >= 0 && gap < groupWindowMs);
};

export const mergeChatMessages = (...sets: ChatMessage[][]) => {
  const byKey = new Map<string, ChatMessage>();
  for (const item of sets.flat()) {
    const key = chatMessageKey(item);
    byKey.set(key, { ...byKey.get(key), ...item });
  }
  return [...byKey.values()].sort(
    (a, b) => messageTime(a) - messageTime(b) || a.id.localeCompare(b.id),
  );
};

export const buildFriendConversations = (
  messages: ChatMessage[],
  metadata: ChatConversation[] = [],
  friends: ChatFriend[] = [],
): FriendConversation[] => {
  const grouped = new Map<string, ChatMessage[]>();
  for (const item of messages.filter(
    (entry) => entry.scope === "friends" && entry.conversationId,
  )) {
    grouped.set(item.conversationId, [...(grouped.get(item.conversationId) ?? []), item]);
  }
  for (const conversation of metadata) {
    if (conversation.channel === "friends" && conversation.cid && !grouped.has(conversation.cid)) {
      grouped.set(conversation.cid, []);
    }
  }
  return [...grouped.entries()]
    .map(([cid, values]) => {
      const ordered = mergeChatMessages(values);
      const other = [...ordered].reverse().find((entry) => !entry.isSelf);
      const conversation = metadata.find((item) => item.cid === cid);
      const participant = idRoot(conversation?.participantPuuid || cid);
      const friend = friends.find((item) => idRoot(item.puuid) === participant);
      return {
        cid,
        title:
          conversation?.title || friend?.displayName || other?.senderName || other?.sender || cid,
        participantPuuid: conversation?.participantPuuid || "",
        playerCardId: friend?.playerCardId,
        statusKey: resolveFriendGameStatus(friend),
        unreadCount: conversation?.unreadCount ?? 0,
        latestTime: Math.max(0, ...ordered.map(messageTime)),
        messages: ordered,
      };
    })
    .sort((a, b) => b.latestTime - a.latestTime || a.title.localeCompare(b.title));
};

export const filterChatFriends = (friends: ChatFriend[], search: string) => {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return friends;
  return friends.filter((friend) =>
    `${friend.displayName} ${friend.gameName} ${friend.tagLine} ${friend.note}`
      .toLocaleLowerCase()
      .includes(query),
  );
};

const idRoot = (value: string) => value.split("@")[0].toLocaleLowerCase();

const looksLikePuuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idRoot(value));

/** Party/team/all MUC nicks are PUUIDs. Prefer a friend's Riot id when we have one. */
export const resolveSenderName = (message: ChatMessage, friends: ChatFriend[]) => {
  const labeled = message.senderName.trim();
  if (labeled && !looksLikePuuid(labeled)) return labeled;
  const root = idRoot(message.sender || labeled);
  const friend = friends.find((item) => idRoot(item.puuid) === root);
  return friend?.displayName || labeled || message.sender;
};

export const withResolvedSenderNames = (messages: ChatMessage[], friends: ChatFriend[]) =>
  messages.map((message) => ({
    ...message,
    senderName: resolveSenderName(message, friends),
  }));

export const filterFriendConversations = (
  conversations: FriendConversation[],
  friends: ChatFriend[],
  search: string,
) => {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return conversations;
  return conversations.filter((conversation) => {
    const participant = idRoot(conversation.participantPuuid);
    const friend = friends.find((item) => idRoot(item.puuid) === participant);
    const searchable = [
      conversation.title,
      conversation.participantPuuid,
      friend?.displayName,
      friend?.gameName,
      friend?.tagLine,
      friend?.note,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(query);
  });
};

export const findFriendConversationCid = (friend: ChatFriend, conversations: ChatConversation[]) =>
  conversations.find(
    (conversation) =>
      conversation.channel === "friends" &&
      idRoot(conversation.participantPuuid) === idRoot(friend.puuid),
  )?.cid ?? null;

export const channelForCid = (cid: string): ChatChannel => {
  const value = cid.toLocaleLowerCase();
  if (value.includes("@ares-parties.")) return "party";
  if (/-(blue|red)@ares-(coregame|pregame)\./.test(value)) return "team";
  if (/-all@ares-coregame\./.test(value)) return "all";
  return "friends";
};

/**
 * Party/team/all rooms are the same conversation when the local part matches,
 * even if one side is the short MUCName (`id@ares-parties.ap`) and the other
 * is the Riot Client cid (`id@ares-parties.ap1.pvp.net`). Exact string compare
 * left the thread empty while Valorant still showed the line.
 */
export const sameRoomCid = (left: string, right: string) => {
  if (!left || !right) return false;
  if (left.toLocaleLowerCase() === right.toLocaleLowerCase()) return true;
  const channel = channelForCid(left);
  return (
    channel !== "friends" && channel === channelForCid(right) && idRoot(left) === idRoot(right)
  );
};

/** Transcript for a room, including lines stored under an alias of the same MUC. */
export const messagesForConversation = (
  cid: string | null,
  historyByCid: Record<string, ChatMessage[]>,
  summaryMessages: ChatMessage[],
) => {
  if (!cid) return [];
  const fromHistory = Object.entries(historyByCid)
    .filter(([key]) => sameRoomCid(key, cid))
    .flatMap(([, messages]) => messages);
  return mergeChatMessages(
    fromHistory.map((message) => ({ ...message, conversationId: cid })),
    summaryMessages
      .filter((message) => sameRoomCid(message.conversationId, cid))
      .map((message) => ({ ...message, conversationId: cid })),
  );
};

/**
 * Whether a composed line is a command rather than a message.
 *
 * Deliberately the whole of the frontend's command knowledge: which command it
 * is, whether a custom trigger matches, and how to parse it all stay in Rust,
 * where the trigger list actually lives. This only decides who to hand it to.
 *
 * The leading dot is required. In-game a bare trigger fires, but the composer
 * is where ordinary messages get written, and matching bare words there would
 * make it impossible to ever send "gg".
 */
export const isComposerCommand = (text: string) => text.trim().startsWith(".");

/** The `rooms` key holding the backend's resolved CID for each room channel. */
const ROOM_KEY: Record<Exclude<ChatChannel, "friends">, ChatRoomKey> = {
  party: "party",
  team: "matchTeam",
  all: "matchAll",
};

/**
 * Which conversation a room channel should be showing, given what the summary
 * currently lists.
 *
 * Room channels (party/team/all) hold exactly one conversation at a time and
 * the player never picks it — it appears when they party up or a match starts,
 * and vanishes when it ends. So the selection has to be re-derived every time
 * the summary changes, in both directions: resolving it only at click time
 * left the channel reporting "available" with nothing selected whenever the
 * room showed up *after* the channel did, which is the normal ordering.
 *
 * `rooms` decides which one, because the conversation list cannot. The backend
 * labels both `-blue@` and `-red@` as `team`, so a summary can carry the enemy
 * team's room alongside our own, and a pregame room alongside the coregame one
 * that replaces it. Picking the first match would eventually put the player in
 * the wrong room; `rooms.matchTeam` is the side-aware answer the backend
 * already computed. A resolved room the summary does not list is ignored
 * rather than returned, so the channel can never read "unavailable" while
 * something is selected.
 *
 * `friends` is the exception and passes through untouched: those conversations
 * are chosen explicitly, and a direct conversation that has not yet appeared
 * in the summary must not be cleared out from under the player.
 */
export const resolveChannelCid = (
  channel: ChatChannel,
  selectedCid: string | null,
  conversations: ChatConversation[],
  rooms: ChatRooms = {},
): string | null => {
  if (channel === "friends") return selectedCid;
  const forChannel = conversations.filter((conversation) => conversation.channel === channel);
  const listed = (cid: string | null | undefined): cid is string =>
    Boolean(cid) && forChannel.some((conversation) => conversation.cid === cid);
  const listedAlias = (cid: string | null | undefined) =>
    cid
      ? (forChannel.find((conversation) => sameRoomCid(conversation.cid, cid))?.cid ?? null)
      : null;

  // The backend's pick wins even over a live selection: when pregame gives way
  // to coregame, following it beats sitting in the room about to disappear.
  const resolved = rooms[ROOM_KEY[channel]];
  if (listed(resolved)) return resolved;
  const aliased = listedAlias(resolved);
  if (aliased) return aliased;
  if (listed(selectedCid)) return selectedCid;
  return forChannel[0]?.cid ?? null;
};

export const supportsConversationHistory = (conversation: ChatConversation | null | undefined) =>
  conversation?.channel === "friends" && conversation.supportsHistory === true;

/**
 * Party/match MUCs 404 `/chat/v6/messages?cid=`. That is "no REST store",
 * not a failed history load. A stale backend still returns the RPC string;
 * the thread must not paint it.
 */
export const isIgnorableHistoryError = (error: string | null | undefined) => {
  if (!error) return false;
  const lower = error.toLocaleLowerCase();
  if (lower.includes("resource_not_found") || lower.includes("invalid uri")) return false;
  return (
    (lower.includes("404") || lower.includes("not found")) &&
    lower.includes("not_found") &&
    lower.includes("/chat/v6/messages")
  );
};

export const shouldStickToBottom = (metrics: ScrollMetrics, sentBySelf: boolean) =>
  sentBySelf || metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 64;

export const shouldResetThreadPosition = (previousCid: string | null, nextCid: string | null) =>
  previousCid !== nextCid;

export type ChatRosterPlayer = {
  puuid: string;
  gameName: string;
  tagLine: string;
  characterId: string | null;
  /** Player card from the Live Game roster (party lobby and matches). */
  cardId?: string | null;
  incognito: boolean;
  isSelf: boolean;
  inMyParty?: boolean;
};

export type ChatSenderIdentity = {
  /** Riot ID, or "" when unknown or hidden by incognito. */
  name: string;
  /** Agent UUID (lowercase), or null before agent select. */
  agentId: string | null;
  cardId: string | null;
};

/** Live Game roster keyed by PUUID, so party/team/all senders gain their agent. */
export const chatRosterIdentities = (players: ChatRosterPlayer[]) => {
  const roster = new Map<string, ChatSenderIdentity>();
  for (const player of players) {
    const visible = !player.incognito || player.isSelf || player.inMyParty;
    roster.set(idRoot(player.puuid), {
      name: visible && player.gameName ? `${player.gameName}#${player.tagLine}` : "",
      agentId: player.characterId ? player.characterId.toLowerCase() : null,
      cardId: player.cardId ? player.cardId.toLowerCase() : null,
    });
  }
  return roster;
};

/** Display name and agent for a group-chat sender. `onRoster` is false outside the live roster. */
export const chatSenderIdentity = (
  message: ChatMessage,
  roster: Map<string, ChatSenderIdentity>,
) => {
  const entry = roster.get(idRoot(message.sender));
  const labeled = message.senderName.trim();
  return {
    name: labeled && !looksLikePuuid(labeled) ? labeled : (entry?.name ?? ""),
    agentId: entry?.agentId ?? null,
    cardId: entry?.cardId ?? null,
    onRoster: Boolean(entry),
  };
};

/**
 * Presence only carries a card while a friend is online. Fill offline friends
 * from the last card seen and return the updated puuid → card cache.
 */
export const withRememberedPlayerCards = (
  friends: ChatFriend[],
  remembered: Record<string, string>,
) => {
  const cache = { ...remembered };
  const withCards = friends.map((friend) => {
    const key = idRoot(friend.puuid);
    if (friend.playerCardId) {
      cache[key] = friend.playerCardId.toLowerCase();
      return friend;
    }
    return cache[key] ? { ...friend, playerCardId: cache[key] } : friend;
  });
  return { friends: withCards, cache };
};

const chatRoundKey = (round: ChatRound) =>
  round.phase === "pregame" ? "pregame" : `ingame:${round.round ?? ""}`;

/**
 * The round each message opens, or null when it continues the previous one.
 * Messages without a stamp (friends, optimistic echoes) never open a round.
 */
export const chatRoundDividers = (messages: ChatMessage[]) => {
  let current = "";
  return messages.map((message) => {
    if (!message.round) return null;
    const key = chatRoundKey(message.round);
    if (key === current) return null;
    current = key;
    return message.round;
  });
};

export type ChatRoomPlayer = ChatRosterPlayer & { teamId: string | null };

export type ChatRoomMember = {
  puuid: string;
  name: string;
  agentId: string | null;
  cardId: string | null;
  isSelf: boolean;
  side: "ally" | "enemy";
};

/**
 * Who is in a group room, from the Live Game roster. Party is your Riot party
 * (the whole roster while in the lobby); Team is your side; All is everyone.
 */
export const chatRoomMembers = (
  players: ChatRoomPlayer[],
  channel: Exclude<ChatChannel, "friends">,
  inLobby: boolean,
): ChatRoomMember[] => {
  const ownTeam = players.find((player) => player.isSelf)?.teamId ?? null;
  const side = (player: ChatRoomPlayer): ChatRoomMember["side"] =>
    !ownTeam || !player.teamId || player.teamId === ownTeam ? "ally" : "enemy";
  const members = players.filter((player) =>
    channel === "party"
      ? inLobby || player.isSelf || player.inMyParty
      : channel === "team"
        ? side(player) === "ally"
        : true,
  );
  const identities = chatRosterIdentities(members);
  return members
    .map((player) => ({
      puuid: player.puuid,
      name: identities.get(idRoot(player.puuid))?.name ?? "",
      agentId: identities.get(idRoot(player.puuid))?.agentId ?? null,
      cardId: identities.get(idRoot(player.puuid))?.cardId ?? null,
      isSelf: player.isSelf,
      side: side(player),
    }))
    .sort(
      (a, b) =>
        Number(a.side === "enemy") - Number(b.side === "enemy") ||
        Number(b.isSelf) - Number(a.isSelf),
    );
};

const dayKey = (message: ChatMessage) => {
  const time = messageTime(message);
  if (!time) return "";
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** Timestamp of the first message of each calendar day, else null. */
export const chatDayDividers = (messages: ChatMessage[]) => {
  let current = "";
  return messages.map((message) => {
    const key = dayKey(message);
    if (!key || key === current) return null;
    current = key;
    return messageTime(message);
  });
};

export type ComposerCommandHint = {
  /** Text placed in the composer when picked, e.g. ".ai ". */
  insert: string;
  syntax: string;
  description: string;
};

/** Commands matching a draft that is still just a `.word` with no arguments. */
export const matchComposerCommands = (draft: string, commands: ComposerCommandHint[]) => {
  const head = draft.trimStart();
  if (!head.startsWith(".") || /\s/.test(head)) return [];
  const query = head.toLocaleLowerCase();
  return commands.filter(
    (command) => command.insert.trim().startsWith(query) && command.insert.trim() !== query,
  );
};
