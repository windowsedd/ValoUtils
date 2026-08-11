import { describe, expect, test } from "bun:test";
import type { ChatFriend, ChatMessage } from "@/types/chat";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatChannelRail } from "./chat-channel-rail";
import { ChatChannelContext } from "./chat-channel-context";
import { ChatComposer, shouldRestoreComposerFocus } from "./chat-composer";
import { ChatConversationList } from "./chat-conversation-list";
import { ChatFriendsPanel } from "./chat-friends-panel";
import { ChatThread } from "./chat-thread";

const channelLabels = {
	friends: "Friends",
	party: "Party",
	team: "Team",
	all: "All",
};

const threadLabels = {
	openFriends: "Open friends",
	historyLoading: "Loading history",
	historyFailed: "History failed",
	retryHistory: "Retry history",
	translate: "Translate",
	translating: "Translating",
	developerPanel: "Developer data",
	empty: "No messages",
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
	product: "valorant",
	queueId: "",
	partyId: "party-id",
	partySize: 1,
	maxPartySize: 5,
	isOnline: true,
};

describe("Chat components", () => {
	test("channel rail exposes all real channels and selected state", () => {
		const markup = renderToStaticMarkup(
			<ChatChannelRail
				selected="team"
				available={{ friends: true, party: true, team: true, all: false }}
				labels={channelLabels}
				onSelect={() => {}}
			/>,
		);
		expect(markup).toContain("Friends");
		expect(markup).toContain("Party");
		expect(markup).toContain("Team");
		expect(markup).toContain("All");
		expect(markup).toContain('aria-pressed="true"');
		expect(markup).toContain('data-channel-available="false"');
	});

	test("conversation list shows real unread metadata and selected state", () => {
		const markup = renderToStaticMarkup(
			<ChatConversationList
				conversations={[
					{
						cid: "friend-cid",
						title: "ALEKSANDAR#4830",
						participantPuuid: "friend",
						unreadCount: 2,
						latestTime: 2000,
						messages: [message("m-1", "hello", "2000")],
					},
				]}
				selectedCid="friend-cid"
				search=""
				searchLabel="Search conversations"
				emptyLabel="No conversations"
				onSearchChange={() => {}}
				onSelect={() => {}}
			/>,
		);
		expect(markup).toContain("ALEKSANDAR#4830");
		expect(markup).toContain("hello");
		expect(markup).toContain('data-unread-count="2"');
		expect(markup).toContain('aria-current="true"');
	});

	test("thread renders messages chronologically and keeps developer data collapsed", () => {
		const markup = renderToStaticMarkup(
			<ChatThread
				conversationId="party-cid"
				title="Party"
				channel="party"
				messages={[message("old", "first", "1000"), message("new", "second", "2000")]}
				historyLoading={false}
				historyError={null}
				translatedByMessageId={{}}
				translationErrorByMessageId={{ "friend-cid:old": "Translation unavailable" }}
				translatingMessageId={null}
				debugData={{ cid: "party" }}
				labels={threadLabels}
				onRetryHistory={() => {}}
				onTranslate={() => {}}
				onOpenFriends={() => {}}
			/>,
		);
		expect(markup.indexOf("first")).toBeLessThan(markup.indexOf("second"));
		expect(markup).toContain('role="log"');
		expect(markup).toContain("<details");
		expect(markup).not.toContain("<details open");
		expect(markup).toContain("Translation unavailable");
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
				availableLabel="Available"
				unavailableLabel="No team room"
			/>,
		);
		expect(markup).toContain('data-channel-context="team"');
		expect(markup).toContain('data-channel-available="false"');
		expect(markup).toContain("No team room");
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
	});
});
