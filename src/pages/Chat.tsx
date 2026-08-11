import type { ChatChannel, ChatFriend } from "@/types/chat";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatChannelRail } from "./chat/chat-channel-rail";
import { ChatChannelContext } from "./chat/chat-channel-context";
import { ChatComposer } from "./chat/chat-composer";
import {
	ChatConversationList,
	type FriendStatusLabels,
} from "./chat/chat-conversation-list";
import { ChatFriendsPanel } from "./chat/chat-friends-panel";
import { ChatThread } from "./chat/chat-thread";
import { useChatController } from "./chat/use-chat-controller";

const Chat = () => {
	const { t } = useTranslation();
	const controller = useChatController();
	const [friendsDrawerOpen, setFriendsDrawerOpen] = useState(false);
	const [selectedFriendPuuid, setSelectedFriendPuuid] = useState<string | null>(null);
	const friendsDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);

	const channelLabels: Record<ChatChannel, string> = {
		friends: t("chat.scopeFriends"),
		party: t("chat.scopeParty"),
		team: t("chat.matchTeam"),
		all: t("chat.matchAll"),
	};
	const friendStatusLabels: FriendStatusLabels = {
		offline: t("friends.offline"),
		checking: t("friends.checking"),
		reconnecting: t("friends.reconnecting"),
		inMatch: t("friends.inMatch"),
		agentSelect: t("friends.agentSelect"),
		inLobby: t("friends.inLobby"),
		away: t("friends.away"),
		online: t("friends.online"),
	};
	const selectedConversationTitle =
		controller.selectedFriendConversation?.title || controller.selectedConversation?.title;
	const threadTitle = selectedConversationTitle || channelLabels[controller.selectedChannel];
	const threadSubtitle =
		controller.selectedChannel === "friends" && controller.selectedFriendConversation
			? friendStatusLabels[controller.selectedFriendConversation.statusKey]
			: channelLabels[controller.selectedChannel];
	const emptyLabel =
		controller.selectedChannel === "friends"
			? t("chat.emptyFriends")
			: controller.selectedChannel === "party"
				? t("chat.emptyParty")
				: controller.selectedChannel === "team"
					? t("chat.emptyTeam")
					: t("chat.emptyAll");
	const disabledReason = controller.loginRequired
		? t("chat.loginRequiredDesc")
		: controller.selectedChannel === "friends"
			? t("chat.noRoom")
			: controller.selectedChannel === "party"
				? t("chat.noPartyRoom")
				: controller.selectedChannel === "team"
					? t("chat.noTeamRoom")
					: t("chat.noAllRoom");
	const placeholder =
		controller.selectedChannel === "friends"
			? t("chat.placeholder")
			: controller.selectedChannel === "party"
				? t("chat.partyPlaceholder")
				: controller.selectedChannel === "team"
					? t("chat.matchTeamPlaceholder")
					: t("chat.matchAllPlaceholder");
	const pageError = controller.summaryError || controller.friendActionError;

	const closeFriendsDrawer = () => {
		setFriendsDrawerOpen(false);
		requestAnimationFrame(() => friendsDrawerTriggerRef.current?.focus());
	};
	const openFriendChat = (friend: ChatFriend) => {
		if (!controller.openFriendChat(friend)) return;
		setSelectedFriendPuuid(null);
		closeFriendsDrawer();
	};

	return (
		<div className="flex h-full min-h-0 overflow-hidden bg-[#07090d] text-gray-200 animate-fade-in">
			<ChatChannelRail
				selected={controller.selectedChannel}
				available={controller.availableChannels}
				labels={channelLabels}
				onSelect={controller.selectChannel}
			/>

			{controller.selectedChannel === "friends" && (
				<ChatConversationList
					conversations={controller.conversations}
					selectedCid={controller.selectedCid}
					statusLabels={friendStatusLabels}
					search={controller.conversationSearch}
					searchLabel={t("chat.searchConversations")}
					emptyLabel={t("chat.noConversations")}
					onSearchChange={controller.setConversationSearch}
					onSelect={controller.selectConversation}
				/>
			)}
			{controller.selectedChannel !== "friends" && (
				<ChatChannelContext
					channel={controller.selectedChannel}
					title={channelLabels[controller.selectedChannel]}
					available={controller.availableChannels[controller.selectedChannel]}
					availableLabel={t("chat.available")}
					unavailableLabel={disabledReason}
				/>
			)}

			<main className="flex min-w-0 flex-1 flex-col">
				{pageError && !controller.loginRequired && (
					<div role="alert" className="shrink-0 border-b border-red-400/20 bg-red-950/25 px-4 py-2 text-xs text-red-200">
						{pageError}
					</div>
				)}

				{controller.loading ? (
					<div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-500">
						{t("chat.loading")}
					</div>
				) : controller.loginRequired ? (
					<div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
						<div className="max-w-md rounded-2xl border border-white/10 bg-white/5 p-6">
							<p className="font-semibold text-white">{t("chat.loginRequired")}</p>
							<p className="mt-1 text-sm text-gray-500">{t("chat.loginRequiredDesc")}</p>
							<button
								type="button"
								className="mt-4 min-h-10 rounded-xl bg-white/8 px-4 text-sm font-semibold text-gray-200 hover:bg-white/12"
								onClick={controller.refreshSummary}
							>
								{t("chat.refresh")}
							</button>
						</div>
					</div>
				) : (
					<>
						<ChatThread
							conversationId={controller.selectedCid}
							title={threadTitle}
							subtitle={threadSubtitle}
							messages={controller.visibleMessages}
							historyLoading={controller.historyLoading}
							historyError={controller.historyError}
							translatedByMessageId={controller.translatedByMessageId}
							translationErrorByMessageId={controller.translationErrorByMessageId}
							translatingMessageId={controller.translatingMessageId}
							debugData={{
								selectedCid: controller.selectedCid,
								selectedChannel: controller.selectedChannel,
								conversation: controller.selectedConversation,
								summary: controller.summary,
							}}
							labels={{
								openFriends: t("chat.openFriends"),
								historyLoading: t("chat.historyLoading"),
								historyFailed: t("chat.historyFailed"),
								retryHistory: t("chat.retryHistory"),
								translate: t("chat.translate"),
								translating: t("chat.translating"),
								developerPanel: t("chat.developerPanel"),
								empty: emptyLabel,
							}}
							onRetryHistory={controller.retryHistory}
							onTranslate={controller.translateMessage}
							onOpenFriends={(trigger) => {
								friendsDrawerTriggerRef.current = trigger;
								setFriendsDrawerOpen(true);
							}}
						/>
						<ChatComposer
							draft={controller.draft}
							disabled={!controller.selectedCid}
							disabledReason={disabledReason}
							sending={controller.sending}
							sendError={controller.sendError}
							placeholder={placeholder}
							sendLabel={t("chat.send")}
							sendingLabel={t("chat.sending")}
							onDraftChange={controller.setDraft}
							onSend={controller.sendMessage}
						/>
					</>
				)}
			</main>

			<ChatFriendsPanel
				friends={controller.friends}
				search={controller.friendSearch}
				drawerOpen={friendsDrawerOpen}
				selectedFriendPuuid={selectedFriendPuuid}
				pendingFriendPuuid={controller.pendingFriendAction}
				labels={{
					title: t("chat.scopeFriends"),
					search: t("chat.searchFriends"),
					empty: t("chat.noFriends"),
					chat: t("chat.friendChat"),
					invite: t("chat.invite"),
					join: t("chat.join"),
					close: t("chat.closeFriends"),
					online: t("chat.online"),
					offline: t("chat.offline"),
					checking: t("friends.checking"),
					reconnecting: t("friends.reconnecting"),
				}}
				canChat={controller.canOpenFriendChat}
				canInvite={(friend) => friend.isOnline}
				canJoin={(friend) =>
					friend.isOnline &&
					Boolean(friend.partyId) &&
					(friend.partySize === null ||
						friend.maxPartySize === null ||
						friend.partySize < friend.maxPartySize)
				}
				onSearchChange={controller.setFriendSearch}
				onFriendSelect={setSelectedFriendPuuid}
				onClose={closeFriendsDrawer}
				onChat={openFriendChat}
				onInvite={(friend) => controller.runFriendAction("invite", friend)}
				onJoin={(friend) => controller.runFriendAction("join", friend)}
			/>
		</div>
	);
};

export default Chat;
