import { describe, expect, test } from "bun:test";
import type { ChatConversation, ChatFriend, ChatMessage } from "@/types/chat";
import * as chatModel from "./chat-model";
import {
  buildFriendConversations,
  channelForCid,
  chatMessageKey,
  filterChatFriends,
  filterFriendConversations,
  findFriendConversationCid,
  forgetMarkedUnread,
  forgetMarkedUnreadIfCleared,
  formatClock,
  isComposerCommand,
  lastConversationMessageId,
  mergeChatMessages,
  rememberMarkedUnread,
  resolveChannelCid,
  resolveFriendGameStatus,
  sessionMarkedUnread,
  shouldResetThreadPosition,
  shouldStickToBottom,
  startsMessageGroup,
  supportsConversationHistory,
  visibleUnreadCount,
} from "./chat-model";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: "m-1",
  conversationId: "friend-cid",
  sender: "friend-puuid",
  senderName: "ALEKSANDAR",
  body: "hello",
  timestamp: "1000",
  type: "chat",
  scope: "friends",
  isSelf: false,
  ...overrides,
});

const friend: ChatFriend = {
  puuid: "friend-puuid",
  gameName: "ALEKSANDAR",
  tagLine: "4830",
  displayName: "ALEKSANDAR#4830",
  note: "我能架住",
  status: "chat",
  statusMessage: "",
  sessionLoopState: "",
  product: "valorant",
  queueId: "competitive",
  partyId: "party-1",
  partySize: 2,
  maxPartySize: 5,
  isOnline: true,
  presenceState: "ready",
};

describe("chat model", () => {
  test("resolves a party PUUID sender to the friend's Riot id", () => {
    const named = chatModel.resolveSenderName(
      message({
        sender: "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1",
        senderName: "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1",
      }),
      [
        {
          ...friend,
          puuid: "869d5298-db1d-54cc-bcaf-6c2a8bb1b6a1",
          displayName: "習慣被依賴づ#JP1",
        },
      ],
    );
    expect(named).toBe("習慣被依賴づ#JP1");
  });

  test("keeps a real game name instead of looking it up", () => {
    expect(chatModel.resolveSenderName(message({ senderName: "Friend" }), [])).toBe("Friend");
  });

  test("merges REST and XMPP messages by cid and id in chronological order", () => {
    const result = mergeChatMessages(
      [message({ id: "older", timestamp: "1000" })],
      [message({ id: "older", timestamp: "1000" }), message({ id: "newer", timestamp: "2000" })],
    );
    expect(result.map((item) => item.id)).toEqual(["older", "newer"]);
  });

  test("uses sender, timestamp, and body when Riot omits a message id", () => {
    const result = mergeChatMessages(
      [message({ id: "", timestamp: "1000" })],
      [message({ id: "", timestamp: "1000" })],
    );
    expect(result).toHaveLength(1);
  });

  test("scopes Riot message ids to their conversation", () => {
    const first = message({ id: "same", conversationId: "cid-a" });
    const second = message({ id: "same", conversationId: "cid-b" });
    expect(chatMessageKey(first)).not.toBe(chatMessageKey(second));
  });

  test("hides unread until Riot reports a higher count than when it was marked read", () => {
    expect(visibleUnreadCount(3)).toBe(3);
    expect(visibleUnreadCount(3, 3)).toBe(0);
    expect(visibleUnreadCount(3, 5)).toBe(0);
    expect(visibleUnreadCount(4, 3)).toBe(4);
    expect(visibleUnreadCount(0, 3)).toBe(0);
  });

  test("uses the latest message id in a conversation as the read receipt mid", () => {
    expect(
      lastConversationMessageId(
        [
          message({ id: "first", conversationId: "cid-a" }),
          message({ id: "second", conversationId: "cid-a" }),
          message({ id: "other", conversationId: "cid-b" }),
        ],
        "cid-a",
        "fallback",
      ),
    ).toBe("second");
    expect(lastConversationMessageId([], "cid-a", "conv-mid")).toBe("conv-mid");
  });

  test("keeps a session mark so remounting Chat does not restore the badge", () => {
    delete sessionMarkedUnread["cid-a"];
    expect(rememberMarkedUnread("cid-a", 2)).toBe(2);
    expect(sessionMarkedUnread["cid-a"]).toBe(2);
    expect(rememberMarkedUnread("cid-a", 0)).toBe(2);
    const stillMarked = forgetMarkedUnreadIfCleared([{ cid: "cid-a", unreadCount: 2 }], {
      "cid-a": 2,
    });
    expect(stillMarked["cid-a"]).toBe(2);
    const cleared = forgetMarkedUnreadIfCleared([{ cid: "cid-a", unreadCount: 0 }], { "cid-a": 2 });
    expect(cleared["cid-a"]).toBeUndefined();
    expect(sessionMarkedUnread["cid-a"]).toBeUndefined();
  });

  test("sorts friend conversations by newest message", () => {
    const groups = buildFriendConversations([
      message({ id: "one", conversationId: "one", timestamp: "1000" }),
      message({ id: "two", conversationId: "two", timestamp: "3000", senderName: "SULAGE" }),
    ]);
    expect(groups.map((group) => group.cid)).toEqual(["two", "one"]);
  });

  test("keeps Riot-provided direct conversations before history has messages", () => {
    const conversations = buildFriendConversations(
      [],
      [
        {
          cid: "direct-cid",
          channel: "friends",
          type: "chat",
          title: "ALEKSANDAR#4830",
          participantPuuid: "friend-puuid",
          unreadCount: 0,
          messageHistory: true,
          muted: false,
          supportsHistory: true,
        },
      ],
    );
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.cid).toBe("direct-cid");
    expect(conversations[0]?.messages).toEqual([]);
  });

  test("labels a self-only direct conversation from the matched friend", () => {
    const conversations = buildFriendConversations(
      [
        message({
          conversationId: "friend-puuid@jp1.pvp.net",
          sender: "self-puuid",
          senderName: "Me",
          isSelf: true,
        }),
      ],
      [
        {
          cid: "friend-puuid@jp1.pvp.net",
          channel: "friends",
          type: "chat",
          title: "",
          participantPuuid: "friend-puuid",
          unreadCount: 0,
          messageHistory: true,
          muted: false,
          supportsHistory: true,
        },
      ],
      [friend],
    );
    expect(conversations[0]?.title).toBe("ALEKSANDAR#4830");
  });

  test("resolves localized friend game status keys in priority order", () => {
    expect(resolveFriendGameStatus({ ...friend, isOnline: false })).toBe("offline");
    expect(resolveFriendGameStatus({ ...friend, sessionLoopState: "INGAME", status: "away" })).toBe(
      "inMatch",
    );
    expect(
      resolveFriendGameStatus({ ...friend, sessionLoopState: "PREGAME", status: "away" }),
    ).toBe("agentSelect");
    expect(resolveFriendGameStatus({ ...friend, sessionLoopState: "MENUS", status: "away" })).toBe(
      "inLobby",
    );
    expect(resolveFriendGameStatus({ ...friend, status: "away" })).toBe("away");
    expect(resolveFriendGameStatus({ ...friend, status: "chat" })).toBe("online");
  });

  test("sync state has priority over stale online data", () => {
    expect(resolveFriendGameStatus({ ...friend, presenceState: "syncing", isOnline: true })).toBe(
      "checking",
    );
    expect(
      resolveFriendGameStatus({ ...friend, presenceState: "reconnecting", isOnline: true }),
    ).toBe("reconnecting");
  });

  test("applies a ready snapshot and offlines absent friends", () => {
    expect(typeof chatModel.applyPresenceSnapshot).toBe("function");
    const result = chatModel.applyPresenceSnapshot([friend, { ...friend, puuid: "offline" }], {
      state: "ready",
      generation: 2,
      friends: {
        [friend.puuid]: [
          {
            puuid: friend.puuid,
            resource: "RC-1",
            product: "valorant",
            status: "chat",
            statusMessage: "",
            sessionLoopState: "INGAME",
            private: {},
          },
        ],
      },
    });

    expect(result[0]).toMatchObject({
      presenceState: "ready",
      isOnline: true,
      sessionLoopState: "INGAME",
    });
    expect(result[1]).toMatchObject({ presenceState: "ready", isOnline: false });
  });

  test("attaches the matched friend's status to a direct conversation", () => {
    const result = buildFriendConversations(
      [],
      [
        {
          cid: "friend-puuid@jp1.pvp.net",
          channel: "friends",
          type: "chat",
          title: "",
          participantPuuid: "friend-puuid",
          unreadCount: 0,
          messageHistory: true,
          muted: false,
          supportsHistory: true,
        },
      ],
      [{ ...friend, sessionLoopState: "INGAME" }],
    );

    expect(result[0]?.statusKey).toBe("inMatch");
  });

  test("searches friends by Riot ID and note", () => {
    expect(filterChatFriends([friend], "4830")).toHaveLength(1);
    expect(filterChatFriends([friend], "架住")).toHaveLength(1);
    expect(filterChatFriends([friend], "missing")).toHaveLength(0);
  });

  test("matches a friend only to a Riot-provided direct conversation", () => {
    const conversations = [
      {
        cid: "friend-puuid@chat.ap",
        channel: "friends" as const,
        type: "chat" as const,
        title: "ALEKSANDAR#4830",
        participantPuuid: "friend-puuid",
        unreadCount: 0,
        messageHistory: true,
        muted: false,
        supportsHistory: true,
      },
    ];
    expect(findFriendConversationCid(friend, conversations)).toBe("friend-puuid@chat.ap");
    expect(findFriendConversationCid({ ...friend, puuid: "other" }, conversations)).toBeNull();
  });

  test("searches direct conversations by the matched friend note", () => {
    const conversations = buildFriendConversations(
      [message({ conversationId: "friend-puuid@chat.ap" })],
      [
        {
          cid: "friend-puuid@chat.ap",
          channel: "friends",
          type: "chat",
          title: "ALEKSANDAR#4830",
          participantPuuid: "friend-puuid",
          unreadCount: 0,
          messageHistory: true,
          muted: false,
          supportsHistory: true,
        },
      ],
    );
    expect(filterFriendConversations(conversations, [friend], "架住")).toHaveLength(1);
    expect(filterFriendConversations(conversations, [friend], "missing")).toHaveLength(0);
  });

  test("classifies only exact Riot room families", () => {
    expect(channelForCid("party@ares-parties.ap")).toBe("party");
    expect(channelForCid("match-blue@ares-coregame.ap")).toBe("team");
    expect(channelForCid("match-red@ares-pregame.ap")).toBe("team");
    expect(channelForCid("match-all@ares-coregame.ap")).toBe("all");
    expect(channelForCid("friend-cid")).toBe("friends");
  });

  test("requests REST history only for supported direct conversations", () => {
    expect(
      supportsConversationHistory({
        cid: "friend@jp1.pvp.net",
        channel: "friends",
        type: "chat",
        title: "",
        participantPuuid: "friend",
        unreadCount: 0,
        messageHistory: true,
        muted: false,
        supportsHistory: true,
      }),
    ).toBe(true);
    expect(
      supportsConversationHistory({
        cid: "game-blue@ares-coregame.jp1.pvp.net",
        channel: "team",
        type: "groupchat",
        title: "",
        participantPuuid: "",
        unreadCount: 0,
        messageHistory: null,
        muted: false,
        supportsHistory: false,
      }),
    ).toBe(false);
    // Live party rooms 404 `/chat/v6/messages?cid=`. Even if a stale backend
    // still flags them as back-fillable, the UI must not ask.
    expect(
      supportsConversationHistory({
        cid: "27ccdf36-57e7-4eee-b111-96a9b0deb638@ares-parties.jp1.pvp.net",
        channel: "party",
        type: "groupchat",
        title: "",
        participantPuuid: "",
        unreadCount: 0,
        messageHistory: null,
        muted: false,
        supportsHistory: true,
      }),
    ).toBe(false);
  });

  test("hides the party MUC REST 404 instead of showing the RPC string", () => {
    expect(
      chatModel.isIgnorableHistoryError(
        'Riot Client request failed (404 Not Found) for /chat/v6/messages?cid=27ccdf36-57e7-4eee-b111-96a9b0deb638%40ares-parties.jp1.pvp.net: {"errorCode":"RPC_ERROR","httpStatus":404,"implementationDetails":{},"message":"not_found"}',
      ),
    ).toBe(true);
    expect(chatModel.isIgnorableHistoryError("message history payload was malformed")).toBe(false);
  });

  test("sticks only near the bottom or after own send", () => {
    expect(
      shouldStickToBottom({ scrollHeight: 1000, scrollTop: 650, clientHeight: 300 }, false),
    ).toBe(true);
    expect(
      shouldStickToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 }, false),
    ).toBe(false);
    expect(
      shouldStickToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 }, true),
    ).toBe(true);
  });

  test("resets thread position only when the selected cid changes", () => {
    expect(shouldResetThreadPosition("friend-a", "friend-b")).toBe(true);
    expect(shouldResetThreadPosition("friend-a", "friend-a")).toBe(false);
  });

  test("clock readings stay one fixed width so the transcript gutter can't wrap", () => {
    const morning = formatClock(Date.UTC(2026, 7, 15, 4, 5));
    const evening = formatClock(Date.UTC(2026, 7, 15, 21, 24));

    expect(morning).toMatch(/^\d{2}:\d{2}$/);
    expect(evening).toMatch(/^\d{2}:\d{2}$/);
    expect(evening.length).toBe(morning.length);
    expect(evening).not.toContain("M");
  });

  test("clock reading is empty for missing or unparseable timestamps", () => {
    expect(formatClock(null)).toBe("");
    expect(formatClock(undefined)).toBe("");
    expect(formatClock("")).toBe("");
    expect(formatClock(0)).toBe("");
    expect(formatClock("not a date")).toBe("");
  });

  test("groups consecutive messages from one sender inside the burst window", () => {
    const first = message({ id: "m-1", timestamp: "1000000" });
    const soon = message({ id: "m-2", timestamp: "1060000" });
    const late = message({ id: "m-3", timestamp: "1400000" });
    const other = message({ id: "m-4", sender: "other-puuid", timestamp: "1060000" });

    expect(startsMessageGroup(undefined, first)).toBe(true);
    expect(startsMessageGroup(first, soon)).toBe(false);
    expect(startsMessageGroup(first, late)).toBe(true);
    expect(startsMessageGroup(first, other)).toBe(true);
  });

  test("starts a new group when timestamps are missing or run backwards", () => {
    const first = message({ id: "m-1", timestamp: "1000000" });
    const backwards = message({ id: "m-2", timestamp: "900000" });
    const undated = message({ id: "m-3", timestamp: "" });

    expect(startsMessageGroup(first, backwards)).toBe(true);
    expect(startsMessageGroup(first, undated)).toBe(true);
  });
});

describe("resolveChannelCid", () => {
  const conversation = (cid: string, channel: ChatConversation["channel"]): ChatConversation => ({
    cid,
    channel,
    type: "groupchat",
    title: channel,
    participantPuuid: "",
    unreadCount: 0,
    messageHistory: true,
    muted: false,
    supportsHistory: true,
  });

  const PARTY = "party-1@ares-parties.ap1.pvp.net";

  test("adopts a room that appears after the channel was already selected", () => {
    // The ordering that actually happens: open Chat, click Party, *then*
    // party up. The room shows as available but nothing was ever selected,
    // which left the composer dead with "No party chat room detected".
    expect(resolveChannelCid("party", null, [])).toBe(null);
    expect(resolveChannelCid("party", null, [conversation(PARTY, "party")])).toBe(PARTY);
  });

  test("keeps the current room while it is still listed", () => {
    const conversations = [
      conversation(PARTY, "party"),
      conversation("other@ares-parties.ap1.pvp.net", "party"),
    ];
    expect(resolveChannelCid("party", PARTY, conversations)).toBe(PARTY);
  });

  test("drops a room that has gone away and takes the replacement", () => {
    const next = "party-2@ares-parties.ap1.pvp.net";
    expect(resolveChannelCid("party", PARTY, [conversation(next, "party")])).toBe(next);
    expect(resolveChannelCid("party", PARTY, [])).toBe(null);
  });

  test("never crosses channels", () => {
    const team = conversation("m-1-blue@ares-coregame.ap1.pvp.net", "team");
    expect(resolveChannelCid("party", null, [team])).toBe(null);
    expect(resolveChannelCid("team", null, [team])).toBe(team.cid);
  });

  test("leaves the friends channel alone, since the user picks the conversation", () => {
    const friend = conversation("friend-cid", "friends");
    expect(resolveChannelCid("friends", "friend-cid", [friend])).toBe("friend-cid");
    // A direct conversation not yet in the summary must not be cleared.
    expect(resolveChannelCid("friends", "friend-cid", [])).toBe("friend-cid");
    expect(resolveChannelCid("friends", null, [friend])).toBe(null);
  });
});

describe("resolveChannelCid prefers the backend's resolved room", () => {
  const conversation = (cid: string, channel: ChatConversation["channel"]): ChatConversation => ({
    cid,
    channel,
    type: "groupchat",
    title: channel,
    participantPuuid: "",
    unreadCount: 0,
    messageHistory: true,
    muted: false,
    supportsHistory: true,
  });

  const BLUE = "m-1-blue@ares-coregame.ap1.pvp.net";
  const RED = "m-1-red@ares-coregame.ap1.pvp.net";

  test("picks our own side when both team rooms are listed", () => {
    // The backend maps blue and red alike to `team`, so both can arrive in
    // one summary. Taking the first would put us in the enemy's room.
    const both = [conversation(RED, "team"), conversation(BLUE, "team")];
    expect(resolveChannelCid("team", null, both, { matchTeam: BLUE })).toBe(BLUE);
    expect(resolveChannelCid("team", null, both, { matchTeam: RED })).toBe(RED);
  });

  test("the resolved room wins over a stale selection", () => {
    // Pregame ends and the coregame room opens: follow the backend rather
    // than sitting in the room that is about to disappear.
    const pregame = "m-1-blue@ares-pregame.ap1.pvp.net";
    const conversations = [conversation(pregame, "team"), conversation(BLUE, "team")];
    expect(resolveChannelCid("team", pregame, conversations, { matchTeam: BLUE })).toBe(BLUE);
  });

  test("ignores a resolved room that the summary does not list", () => {
    // Never hand back a cid the conversation list has no entry for, or the
    // channel renders "unavailable" while something is selected.
    expect(resolveChannelCid("team", null, [], { matchTeam: BLUE })).toBe(null);
    expect(resolveChannelCid("party", null, [conversation(BLUE, "team")], { party: "ghost" })).toBe(
      null,
    );
  });

  test("falls back to the listed room when no room was resolved", () => {
    const party = "p-1@ares-parties.ap1.pvp.net";
    expect(resolveChannelCid("party", null, [conversation(party, "party")], {})).toBe(party);
  });

  test("uses the listed party cid when rooms.party is only an XMPP alias", () => {
    // Party API MUCName is often `id@ares-parties.ap`. The Riot Client
    // conversation that actually carries the lines is `id@ares-parties.ap1.pvp.net`.
    // Selecting the short name left the thread empty while Valorant showed `sb`.
    const rest = "p-1@ares-parties.ap1.pvp.net";
    const xmpp = "p-1@ares-parties.ap";
    expect(resolveChannelCid("party", null, [conversation(rest, "party")], { party: xmpp })).toBe(
      rest,
    );
  });
});

describe("sameRoomCid", () => {
  test("treats a party MUC alias as the same room", () => {
    expect(chatModel.sameRoomCid("p-1@ares-parties.ap", "p-1@ares-parties.ap1.pvp.net")).toBe(true);
    expect(
      chatModel.sameRoomCid("p-1@ares-parties.ap1.pvp.net", "p-1@ares-parties.ap1.pvp.net"),
    ).toBe(true);
    expect(chatModel.sameRoomCid("p-1@ares-parties.ap", "p-2@ares-parties.ap")).toBe(false);
  });

  test("does not collapse opposite team rooms", () => {
    expect(
      chatModel.sameRoomCid(
        "m-1-blue@ares-coregame.ap1.pvp.net",
        "m-1-red@ares-coregame.ap1.pvp.net",
      ),
    ).toBe(false);
  });
});

describe("messagesForConversation", () => {
  test("deduplicates an event and summary carrying the same message under room aliases", () => {
    const cid = "game-all@ares-coregame.ap1.pvp.net";
    const alias = "game-all@ares-coregame.ap";
    const line = message({ id: "same-id", conversationId: cid });
    expect(
      chatModel.messagesForConversation(cid, { [alias]: [{ ...line, conversationId: alias }] }, [
        line,
      ]),
    ).toHaveLength(1);
  });
  test("includes a party line whose cid is an alias of the selected room", () => {
    const selected = "p-1@ares-parties.ap";
    const rest = "p-1@ares-parties.ap1.pvp.net";
    const visible = chatModel.messagesForConversation(selected, {}, [
      message({ id: "sb", conversationId: rest, body: "sb" }),
    ]);
    expect(visible.map((item) => item.body)).toEqual(["sb"]);
  });
});

describe("isComposerCommand", () => {
  test("treats a dotted line as a command", () => {
    expect(isComposerCommand(".send team fr gl hf")).toBe(true);
    expect(isComposerCommand("  .tran 2")).toBe(true);
    expect(isComposerCommand(".dodge")).toBe(true);
    expect(isComposerCommand(".gg")).toBe(true);
  });

  test("leaves ordinary messages alone, bare trigger words included", () => {
    // In-game a bare `gg` fires the trigger. In the composer it has to stay
    // a message, or the word could never be said.
    expect(isComposerCommand("gg")).toBe(false);
    expect(isComposerCommand("nice one")).toBe(false);
    expect(isComposerCommand("...")).toBe(true);
    expect(isComposerCommand("")).toBe(false);
  });
});

describe("forgetMarkedUnread", () => {
  test("restores the badge after a rejected mark-read", () => {
    // The badge is hidden optimistically on click; if Riot refuses, the count
    // has to come back or the app lies about what the game shows.
    sessionMarkedUnread["cid-1"] = 3;
    const next = forgetMarkedUnread("cid-1", { "cid-1": 3, "cid-2": 1 });

    expect(next["cid-1"]).toBeUndefined();
    expect(sessionMarkedUnread["cid-1"]).toBeUndefined();
    // Suppression survives Chat remounts, so the session record must clear too.
    expect(visibleUnreadCount(3, next["cid-1"])).toBe(3);
    // Other conversations are untouched.
    expect(next["cid-2"]).toBe(1);
  });

  test("is a no-op for a conversation that was never marked", () => {
    const marked = { "cid-2": 1 };
    expect(forgetMarkedUnread("cid-absent", marked)).toBe(marked);
  });
});

describe("chat sender identities", () => {
  const mate = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const hidden = "11111111-2222-3333-4444-555555555555";
  const roster = chatModel.chatRosterIdentities([
    { puuid: mate, gameName: "Skyline", tagLine: "TW1", characterId: "ADD6443A-41BD", incognito: false, isSelf: false },
    { puuid: hidden, gameName: "Secret", tagLine: "X", characterId: null, incognito: true, isSelf: false },
  ]);
  const groupMessage = (sender: string, senderName = sender): ChatMessage => ({
    id: sender,
    conversationId: "party-cid",
    sender: `${sender}@ares-parties.jp1.pvp.net`,
    senderName,
    body: "hi",
    timestamp: "1000",
    type: "groupchat",
    scope: "party",
    isSelf: false,
  });

  test("resolves a PUUID sender to the roster Riot ID and agent", () => {
    expect(chatModel.chatSenderIdentity(groupMessage(mate), roster)).toEqual({
      name: "Skyline#TW1",
      agentId: "add6443a-41bd",
      cardId: null,
      onRoster: true,
    });
  });

  test("keeps incognito names hidden and reports a missing agent", () => {
    expect(chatModel.chatSenderIdentity(groupMessage(hidden), roster)).toEqual({
      name: "",
      agentId: null,
      cardId: null,
      onRoster: true,
    });
  });

  test("prefers an existing readable name and marks off-roster senders", () => {
    expect(chatModel.chatSenderIdentity(groupMessage("stranger", "Friend#1"), roster)).toEqual({
      name: "Friend#1",
      agentId: null,
      cardId: null,
      onRoster: false,
    });
  });
});

describe("remembered player cards", () => {
  const base = (puuid: string, playerCardId?: string) =>
    ({ puuid, displayName: puuid, playerCardId }) as ChatFriend;

  test("fills offline friends from the last card seen and records new ones", () => {
    const { friends, cache } = chatModel.withRememberedPlayerCards(
      [base("online", "CARD-A"), base("offline")],
      { offline: "card-b" },
    );
    expect(friends.map((friend) => friend.playerCardId)).toEqual(["CARD-A", "card-b"]);
    expect(cache).toEqual({ offline: "card-b", online: "card-a" });
  });
});

describe("chat round dividers", () => {
  const at = (id: string, round?: ChatMessage["round"]) =>
    ({ id, conversationId: "team", sender: "x", senderName: "x", body: id, timestamp: id, type: "groupchat", scope: "match", isSelf: false, round }) as ChatMessage;

  test("opens a divider only when the phase or round changes", () => {
    const dividers = chatModel.chatRoundDividers([
      at("1", { phase: "pregame" }),
      at("2", { phase: "pregame" }),
      at("3", { phase: "ingame", round: 1, allyScore: 0, enemyScore: 0 }),
      at("4"),
      at("5", { phase: "ingame", round: 1, allyScore: 0, enemyScore: 0 }),
      at("6", { phase: "ingame", round: 2, allyScore: 1, enemyScore: 0 }),
    ]);
    expect(dividers.map((round) => round?.round ?? round?.phase ?? null)).toEqual([
      "pregame", null, 1, null, null, 2,
    ]);
  });
});

describe("chat room members", () => {
  const player = (puuid: string, teamId: string | null, extra: Partial<chatModel.ChatRoomPlayer> = {}) => ({
    puuid,
    gameName: puuid,
    tagLine: "T",
    characterId: null,
    incognito: false,
    isSelf: false,
    teamId,
    ...extra,
  });
  const players = [
    player("enemy", "Red"),
    player("mate", "Blue", { inMyParty: true }),
    player("me", "Blue", { isSelf: true }),
    player("solo", "Blue"),
  ];

  test("party is your Riot party, team is your side, all lists allies first", () => {
    expect(chatModel.chatRoomMembers(players, "party", false).map((m) => m.puuid)).toEqual(["me", "mate"]);
    expect(chatModel.chatRoomMembers(players, "team", false).map((m) => m.puuid)).toEqual(["me", "mate", "solo"]);
    expect(
      chatModel.chatRoomMembers(players, "all", false).map((m) => `${m.puuid}:${m.side}`),
    ).toEqual(["me:ally", "mate:ally", "solo:ally", "enemy:enemy"]);
  });

  test("the whole lobby roster is the party", () => {
    expect(chatModel.chatRoomMembers(players, "party", true)).toHaveLength(4);
  });

  test("lobby members carry their player card for the portrait", () => {
    const lobby = [player("me", null, { isSelf: true, cardId: "CARD-1" })];
    expect(chatModel.chatRoomMembers(lobby, "party", true)[0].cardId).toBe("card-1");
  });
});

describe("chat day dividers", () => {
  test("marks the first message of each day", () => {
    const at = (timestamp: string) => ({ id: timestamp, conversationId: "c", sender: "s", senderName: "s", body: "b", timestamp, type: "chat", scope: "friends", isSelf: false }) as ChatMessage;
    const first = new Date(2026, 9, 3, 23, 0).getTime();
    const second = new Date(2026, 9, 3, 23, 30).getTime();
    const third = new Date(2026, 9, 4, 0, 10).getTime();
    expect(chatModel.chatDayDividers([at(String(first)), at(String(second)), at(String(third))])).toEqual([first, null, third]);
  });
});

describe("composer command matching", () => {
  const commands = [
    { insert: ".ai ", syntax: ".ai", description: "" },
    { insert: ".ask ", syntax: ".ask", description: "" },
    { insert: ".dodge", syntax: ".dodge", description: "" },
  ];
  test("suggests by prefix and stops once arguments start", () => {
    expect(chatModel.matchComposerCommands(".a", commands).map((c) => c.insert)).toEqual([".ai ", ".ask "]);
    expect(chatModel.matchComposerCommands(".", commands)).toHaveLength(3);
    expect(chatModel.matchComposerCommands(".ai", commands).map((c) => c.insert)).toEqual([]);
    expect(chatModel.matchComposerCommands(".ai team", commands)).toEqual([]);
    expect(chatModel.matchComposerCommands("hello", commands)).toEqual([]);
  });
});
