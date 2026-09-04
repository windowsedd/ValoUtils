import type { ChatFriend } from "@/types/chat";
import { LoginRequiredPanel } from "@/components/login-required-panel";
import { LuMessageSquare } from "react-icons/lu";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
	const threadTitle = selectedConversationTitle || t("chat.scopeFriends");
	const threadSubtitle = controller.selectedFriendConversation
		? friendStatusLabels[controller.selectedFriendConversation.statusKey]
		: t("chat.scopeFriends");
	const emptyLabel = t("chat.emptyFriends");
	const disabledReason = controller.loginRequired ? t("chat.loginRequiredDesc") : t("chat.noRoom");
	const placeholder = t("chat.placeholder");
	// markReadError included so a rejected mark-read is visible rather than
	// leaving the badge silently hidden.
	const pageError =
		controller.summaryError || controller.friendActionError || controller.markReadError;

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
		<div className="flex h-full min-h-0 overflow-hidden bg-(--ground) text-(--ink-dim) animate-fade-in">
			<ChatConversationList
				conversations={controller.conversations}
				selectedCid={controller.selectedCid}
				statusLabels={friendStatusLabels}
				search={controller.conversationSearch}
				searchLabel={t("chat.searchConversations")}
				emptyLabel={t("chat.noConversations")}
				markAsReadLabel={t("chat.markAsRead")}
				onSearchChange={controller.setConversationSearch}
				onSelect={controller.selectConversation}
				onMarkRead={controller.markConversationRead}
			/>

			<main className="flex min-w-0 flex-1 flex-col bg-(--background) px-2 pb-2 pt-4">
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[8px] border border-(--border) bg-(--surface)">
				{pageError && !controller.loginRequired && (
					<div role="alert" className="shrink-0 border-b border-(--signal-neg)/25 bg-(--signal-neg)/8 px-3 py-2 text-[11px] text-(--signal-neg)">
						{pageError}
					</div>
				)}

				{controller.loading ? (
					<div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-(--text-muted)">
						{t("chat.loading")}
					</div>
				) : controller.loginRequired ? (
					<LoginRequiredPanel
						onRetry={controller.refreshSummary}
						icon={<LuMessageSquare />}
						title={t("chat.loginRequired")}
						description={t("chat.loginRequiredDesc")}
					>
						<button
							type="button"
							className="h-8 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[12px] font-medium text-(--text-primary) hover:bg-(--surface-hover)"
							onClick={controller.refreshSummary}
						>
							{t("chat.refresh")}
						</button>
					</LoginRequiredPanel>
				) : (
					<>
						<ChatThread
							conversationId={controller.selectedCid}
							title={threadTitle}
							subtitle={threadSubtitle}
							messages={controller.visibleMessages}
							systemLines={controller.systemLines}
							historyLoading={controller.historyLoading}
							historyError={controller.historyError}
							translatedByMessageId={controller.translatedByMessageId}
							translationErrorByMessageId={controller.translationErrorByMessageId}
							translatingMessageId={controller.translatingMessageId}
							labels={{
								openFriends: t("chat.openFriends"),
								historyLoading: t("chat.historyLoading"),
								historyFailed: t("chat.historyFailed"),
								retryHistory: t("chat.retryHistory"),
								translate: t("chat.translate"),
								translating: t("chat.translating"),
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
				</div>
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
