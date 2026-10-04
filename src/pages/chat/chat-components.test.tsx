import { describe, expect, test } from "bun:test";
import type { ChatChannel, ChatFriend, ChatMessage } from "@/types/chat";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatChannelRail, visibleChatChannels } from "./chat-channel-rail";
import { ChatChannelContext } from "./chat-channel-context";
import { ChatComposer, shouldRestoreComposerFocus } from "./chat-composer";
import { ChatConversationList } from "./chat-conversation-list";
import { ChatFriendsPanel, focusFriendsDrawer } from "./chat-friends-panel";
import { ChatThread, isBlockArt } from "./chat-thread";

const channelLabels: Record<ChatChannel, string> = {
	friends: "Friends",
	party: "Party",
	team: "Team",
	all: "All",
};

const statusLabels = {
	offline: "Offline",
	checking: "Checking...",
	reconnecting: "Reconnecting...",
	inMatch: "In Match",
	agentSelect: "Agent Select",
	inLobby: "In Lobby",
	away: "Away",
	online: "Online",
};

const threadLabels = {
	openFriends: "Open friends",
	historyLoading: "Loading history",
	historyFailed: "History failed",
	retryHistory: "Retry history",
	translate: "Translate",
	translating: "Translating",
	empty: "No messages",
	running: "Running",
	formatDay: () => "Today",
};

const roomLabels = {
	available: "Available",
	unavailable: "No team room",
	members: "In this room",
	membersEmpty: "Nobody yet",
	allies: "Allies",
	enemies: "Enemies",
	you: "You",
	noAgent: "No agent",
	commands: "Commands",
};

const message = (id: string, body: string, timestamp: string): ChatMessage => ({
	id,
	conversationId: "friend-cid",
	sender: "friend",
	senderName: "Friend",
	body,
	timestamp,
	type: "chat",
	scope: "friends",
	isSelf: false,
});

const friend: ChatFriend = {
	puuid: "friend",
	gameName: "ALEKSANDAR",
	tagLine: "4830",
	displayName: "ALEKSANDAR#4830",
	note: "Rank duo",
	status: "available",
	statusMessage: "In Lobby",
	sessionLoopState: "",
	product: "valorant",
	queueId: "",
	partyId: "party-id",
	partySize: 1,
	maxPartySize: 5,
	isOnline: true,
	presenceState: "ready",
};

describe("Chat components", () => {
	test("channel rail exposes friends and all three game channels", () => {
		const markup = renderToStaticMarkup(
			<ChatChannelRail
				selected="friends"
				available={{ friends: true, party: true, team: true, all: true }}
				labels={channelLabels}
				onSelect={() => {}}
			/>,
		);
		expect(visibleChatChannels).toEqual(["friends", "party", "team", "all"]);
		expect(markup).toContain("Friends");
		expect(markup).toContain('aria-pressed="true"');
		expect(markup).toContain("Party");
		expect(markup).toContain("Team");
		expect(markup).toContain(">All<");
	});

	test("conversation list renders a pinned entry above an empty list", () => {
		const markup = renderToStaticMarkup(
			<ChatConversationList
				conversations={[]}
				selectedCid={null}
				statusLabels={statusLabels}
				search=""
				searchLabel="Search conversations"
				emptyLabel="No conversations"
				markAsReadLabel="Mark as read"
				onSearchChange={() => {}}
				onSelect={() => {}}
				onMarkRead={() => {}}
				pinned={<button type="button">ValoUtils Bot</button>}
			/>,
		);
		expect(markup.indexOf("ValoUtils Bot")).toBeLessThan(markup.indexOf("No conversations"));
	});

	test("conversation list shows real unread metadata and selected state", () => {
		const markup = renderToStaticMarkup(
			<ChatConversationList
				conversations={[
					{
						cid: "friend-cid",
						title: "ALEKSANDAR#4830",
						participantPuuid: "friend",
						statusKey: "inMatch",
						unreadCount: 2,
						latestTime: 2000,
						messages: [message("m-1", "hello", "2000")],
					},
				]}
				selectedCid="friend-cid"
				statusLabels={statusLabels}
				search=""
				searchLabel="Search conversations"
				emptyLabel="No conversations"
				markAsReadLabel="Mark as read"
				onSearchChange={() => {}}
				onSelect={() => {}}
				onMarkRead={() => {}}
			/>,
		);
		expect(markup).toContain("ALEKSANDAR#4830");
		expect(markup).toContain("In Match");
		expect(markup).not.toContain("hello");
		expect(markup).toContain('data-unread-count="2"');
		expect(markup).toContain('aria-label="Mark as read"');
		expect(markup).toContain('aria-current="true"');
	});

	test("thread renders messages chronologically without developer data", () => {
		const markup = renderToStaticMarkup(
			<ChatThread
				conversationId="party-cid"
				title="Party"
				subtitle="In Match"
				messages={[message("old", "first", "1000"), message("new", "second", "2000")]}
				systemLines={[]}
				historyLoading={false}
				historyError={null}
				translatedByMessageId={{}}
				translationErrorByMessageId={{ "friend-cid:old": "Translation unavailable" }}
				translatingMessageId={null}
				labels={threadLabels}
				onRetryHistory={() => {}}
				onTranslate={() => {}}
				onOpenFriends={() => {}}
			/>,
		);
		expect(markup.indexOf(">first<")).toBeLessThan(markup.indexOf(">second<"));
		expect(markup).toContain("In Match");
		expect(markup).toContain('role="log"');
		expect(markup).not.toContain("<details");
		expect(markup).not.toContain("Developer data");
		expect(markup).toContain("Translation unavailable");
	});

	test("group thread shows the sender portrait, name and agent above the bubble", () => {
		const markup = renderToStaticMarkup(
			<ChatThread
				conversationId="party-cid"
				title="Party"
				subtitle="Party"
				messages={[message("one", "hello", "1000")]}
				systemLines={[]}
				historyLoading={false}
				historyError={null}
				translatedByMessageId={{ "friend-cid:one": "translated hello" }}
				translationErrorByMessageId={{}}
				translatingMessageId={null}
				labels={threadLabels}
				onRetryHistory={() => {}}
				onTranslate={() => {}}
				onOpenFriends={() => {}}
				describeSender={() => ({ name: "Skyline#TW1", agentLabel: "Jett", agentIcon: "jett.png" })}
			/>,
		);
		expect(markup).toContain('src="jett.png"');
		expect(markup.indexOf("Skyline#TW1")).toBeLessThan(markup.indexOf(">hello<"));
		expect(markup).toContain(">Jett<");
		expect(markup).toContain('aria-pressed="true"');
		expect(markup.indexOf(">hello<")).toBeLessThan(markup.indexOf("translated hello"));
	});

	test("composer is multiline and reports unavailable state", () => {
		const markup = renderToStaticMarkup(
			<ChatComposer
				draft=""
				disabled
				disabledReason="No team room"
				sending={false}
				sendError={null}
				placeholder="Message team"
				sendLabel="Send"
				sendingLabel="Sending"
				onDraftChange={() => {}}
				onSend={() => {}}
			/>,
		);
		expect(markup).toContain("<textarea");
		expect(markup).toContain("No team room");
		expect(markup).toContain("disabled");
		expect(shouldRestoreComposerFocus(true, false)).toBe(true);
		expect(shouldRestoreComposerFocus(false, false)).toBe(false);
	});

	test("group channel context reports real availability without inventing conversations", () => {
		const markup = renderToStaticMarkup(
			<ChatChannelContext
				channel="team"
				title="Team"
				available={false}
				members={[]}
				commands={[]}
				labels={roomLabels}
				onPickCommand={() => {}}
			/>,
		);
		expect(markup).toContain('data-channel-context="team"');
		expect(markup).toContain('data-channel-available="false"');
		expect(markup).toContain("No team room");
		expect(markup).toContain("Nobody yet");
	});

	test("all chat context splits allies and enemies and marks yourself", () => {
		const member = (puuid: string, side: "ally" | "enemy", isSelf = false) => ({
			puuid,
			name: puuid,
			displayName: `${puuid}#TAG`,
			agentId: null,
			agentName: side === "ally" ? "Jett" : "",
			agentIcon: null,
			isSelf,
			side,
		});
		const markup = renderToStaticMarkup(
			<ChatChannelContext
				channel="all"
				title="All"
				available
				members={[member("me", "ally", true), member("foe", "enemy")]}
				commands={[{ insert: ".ai ", syntax: ".ai <prompt>", description: "AI line" }]}
				labels={roomLabels}
				onPickCommand={() => {}}
			/>,
		);
		expect(markup.indexOf("Allies")).toBeLessThan(markup.indexOf("Enemies"));
		expect(markup).toContain(">You<");
		expect(markup).toContain(">Jett<");
		expect(markup).toContain(">No agent<");
		expect(markup).toContain(">.ai<");
	});

	test("composer suggests commands for a bare dot word", () => {
		const markup = renderToStaticMarkup(
			<ChatComposer
				draft=".a"
				disabled={false}
				disabledReason=""
				sending={false}
				sendError={null}
				placeholder="Type"
				sendLabel="Send"
				sendingLabel="Sending"
				hint="Enter to send"
				commands={[
					{ insert: ".ai ", syntax: ".ai <prompt>", description: "AI line" },
					{ insert: ".dodge", syntax: ".dodge", description: "Leave" },
				]}
				onDraftChange={() => {}}
				onSend={() => {}}
			/>,
		);
		expect(markup).toContain('role="listbox"');
		expect(markup).toContain(".ai &lt;prompt&gt;");
		expect(markup).not.toContain(".dodge");
		expect(markup).toContain("Enter to send");
	});

	test("friends panel keeps notes visible and exposes the selected friend's actions", () => {
		const markup = renderToStaticMarkup(
			<ChatFriendsPanel
				friends={[friend]}
				search=""
				drawerOpen
				selectedFriendPuuid="friend"
				pendingFriendPuuid={null}
				labels={{
					title: "Friends",
					search: "Search friends",
					empty: "No friends",
					chat: "Chat",
					invite: "Invite",
					join: "Join",
					close: "Close friends",
					online: "Online",
					offline: "Offline",
					checking: "Checking...",
					reconnecting: "Reconnecting...",
				}}
				canChat={() => false}
				canInvite={() => true}
				canJoin={() => true}
				onSearchChange={() => {}}
				onFriendSelect={() => {}}
				onClose={() => {}}
				onChat={() => {}}
				onInvite={() => {}}
				onJoin={() => {}}
			/>,
		);
		expect(markup).toContain("Rank duo");
		expect(markup).toContain('role="menu"');
		expect(markup).toContain("Chat");
		expect(markup).toContain("Invite");
		expect(markup).toContain("Join");
		expect(markup).toContain('data-chat-available="false"');
		expect(markup).toContain('data-friends-drawer="true"');
		expect(markup).toContain('role="dialog"');
		expect(markup).toContain('aria-modal="true"');
		let focused = false;
		focusFriendsDrawer({
			querySelector: () => ({ focus: () => (focused = true) }),
		} as unknown as HTMLElement);
		expect(focused).toBe(true);
	});

	test("friends panel shows reconnecting without stale online detail", () => {
		const markup = renderToStaticMarkup(
			<ChatFriendsPanel
				friends={[
					{
						...friend,
						presenceState: "reconnecting",
						isOnline: false,
						statusMessage: "In Lobby",
					},
				]}
				search=""
				drawerOpen
				selectedFriendPuuid={null}
				pendingFriendPuuid={null}
				labels={{
					title: "Friends",
					search: "Search friends",
					empty: "No friends",
					chat: "Chat",
					invite: "Invite",
					join: "Join",
					close: "Close friends",
					online: "Online",
					offline: "Offline",
					checking: "Checking...",
					reconnecting: "Reconnecting...",
				}}
				canChat={() => true}
				canInvite={() => false}
				canJoin={() => false}
				onSearchChange={() => {}}
				onFriendSelect={() => {}}
				onClose={() => {}}
				onChat={() => {}}
				onInvite={() => {}}
				onJoin={() => {}}
			/>,
		);

		expect(markup).toContain("Reconnecting...");
		expect(markup).not.toContain("In Lobby");
		expect(markup).not.toContain('aria-label="Online"');
	});
});

describe("block art", () => {
	test("detects .ascii panels but not ordinary text", () => {
		expect(isBlockArt("░░░░░░███░░░██░░████░░░░░░")).toBe(true);
		expect(isBlockArt("gg █ wp")).toBe(false);
		expect(isBlockArt("要一起打競技嗎？")).toBe(false);
	});
});
