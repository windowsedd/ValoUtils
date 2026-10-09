import type { ChatFriend, ChatMessage, ChatRound } from "@/types/chat";
import { LoginRequiredPanel } from "@/components/login-required-panel";
import { useLiveGameSession } from "@/components/live-game/live-game-session";
import { getAgents, localize, type AgentAsset } from "@/util/valorant-assets";
import { LuMessageSquare } from "react-icons/lu";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatComposer } from "./chat/chat-composer";
import { ChatChannelRail } from "./chat/chat-channel-rail";
import { ChatChannelContext, type ChatRoomMemberView } from "./chat/chat-channel-context";
import {
	ChatConversationList,
	type FriendStatusLabels,
} from "./chat/chat-conversation-list";
import { ChatFriendsPanel } from "./chat/chat-friends-panel";
import {
	chatRoomMembers,
	chatRosterIdentities,
	chatSenderIdentity,
	type ComposerCommandHint,
} from "./chat/chat-model";
import { ChatThread, type ChatThreadSender } from "./chat/chat-thread";
import { useChatController } from "./chat/use-chat-controller";
import { DUMMY_BOT_CID, useDummyBotChat } from "./chat/use-dummy-bot-chat";
import valoUtilsIcon from "../../src-tauri/icons/icon.png";
import { PlayerCardAvatar } from "./chat/player-card-avatar";
import { savedMatchMessages } from "./chat/saved-match-history";

const Chat = () => {
	const { t } = useTranslation();
	const controller = useChatController();
	const [friendsDrawerOpen, setFriendsDrawerOpen] = useState(false);
	const [selectedFriendPuuid, setSelectedFriendPuuid] = useState<string | null>(null);
	const friendsDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const [botOpen, setBotOpen] = useState(false);
	const { snapshot } = useLiveGameSession();
	const [agents, setAgents] = useState<Map<string, AgentAsset>>(new Map());
	useEffect(() => {
		let cancelled = false;
		getAgents().then((map) => {
			if (!cancelled) setAgents(map);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const roster = useMemo(
		() => chatRosterIdentities(snapshot?.state === "idle" ? [] : (snapshot?.players ?? [])),
		[snapshot],
	);

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
	const channel = controller.selectedChannel;
	const [savedSelection, setSavedSelection] = useState<{ owner: string; matchUuid: string } | null>(null);
	const savedMatches = controller.summary.savedMatches ?? [];
	const savedMatch = !controller.loginRequired && savedSelection?.owner === controller.summary.ownerPuuid
		? savedMatches.find(match => match.matchUuid === savedSelection?.matchUuid)
		: undefined;
	const viewingSaved = !!savedMatch && (channel === "team" || channel === "all");
	const historyMessages = savedMatchMessages(savedMatch, channel);
	useEffect(() => {
		if (channel !== "team" && channel !== "all") setSavedSelection(null);
	}, [channel]);
	const channelLabels = {
		friends: t("chat.scopeFriends"),
		party: t("chat.scopeParty"),
		team: t("chat.matchTeam"),
		all: t("chat.matchAll"),
	};
	const isFriends = channel === "friends";
	const botName = "ValoUtils Bot";
	const bot = useDummyBotChat(isFriends && botOpen, botName);
	const showBot = isFriends && botOpen;
	// The in-game whisper thread with the bot is the same transcript as the
	// pinned test chat, so it is listed once.
	const friendConversations = bot.puuid
		? controller.conversations.filter(
				(conversation) =>
					!`${conversation.participantPuuid} ${conversation.cid}`
						.toLowerCase()
						.includes(bot.puuid.toLowerCase()),
			)
		: controller.conversations;
	const threadTitle = isFriends
		? selectedConversationTitle || channelLabels.friends
		: channelLabels[channel];
	const livePlayers = snapshot && snapshot.state !== "idle" ? snapshot.players : [];
	const roomMembers: ChatRoomMemberView[] = isFriends || viewingSaved
		? []
		: chatRoomMembers(livePlayers, channel, snapshot?.state === "party").map((member) => {
				const agent = member.agentId ? agents.get(member.agentId) : undefined;
				const agentName = localize(agent?.name);
				return {
					...member,
					displayName: member.name || agentName || t("chat.unknownPlayer"),
					agentName,
					agentIcon: agent?.icon ?? null,
				};
			});
	const threadSubtitle = controller.selectedFriendConversation
		? friendStatusLabels[controller.selectedFriendConversation.statusKey]
		: roomMembers.length > 0
			? `${channelLabels[channel]} · ${t("chat.playerCount", { count: roomMembers.length })}`
			: channelLabels[channel];
	const commandHints: ComposerCommandHint[] = [
		{ insert: ".ai ", syntax: t("dummyBot.aiSyntax"), description: t("chat.cmdAi") },
		{ insert: ".ask ", syntax: t("dummyBot.askSyntax"), description: t("chat.cmdAsk") },
		{ insert: ".send ", syntax: t("dummyBot.translateSyntax"), description: t("chat.cmdSend") },
		{ insert: ".tran ", syntax: ".tran [n]", description: t("chat.cmdTran") },
		{ insert: ".ascii ", syntax: t("dummyBot.asciiSyntax"), description: t("chat.cmdAscii") },
		{ insert: ".dodge", syntax: t("dummyBot.dodgeSyntax"), description: t("chat.cmdDodge") },
	];
	const formatDay = (time: number) => {
		const date = new Date(time);
		const today = new Date();
		const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
		if (date.toDateString() === today.toDateString()) return t("chat.today");
		if (date.toDateString() === yesterday.toDateString()) return t("chat.yesterday");
		return date.toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "short" });
	};
	const pickCommand = (command: ComposerCommandHint) => {
		controller.setDraft(command.insert);
		requestAnimationFrame(() => composerRef.current?.focus());
	};
	const describeSender = (message: ChatMessage): ChatThreadSender => {
		const identity = chatSenderIdentity(message, viewingSaved ? new Map() : roster);
		const agent = identity.agentId ? agents.get(identity.agentId) : undefined;
		const agentName = localize(agent?.name);
		return {
			name: identity.name || agentName || t("chat.unknownPlayer"),
			agentLabel: !identity.onRoster ? "" : agentName || t("chat.noAgent"),
			agentIcon: agent?.icon ?? null,
			cardId: identity.cardId,
		};
	};
	const formatRound = (round: ChatRound) => {
		if (round.phase === "pregame") return t("chat.roundAgentSelect");
		if (!round.round) return t("chat.roundInMatch");
		const score =
			round.allyScore == null || round.enemyScore == null
				? ""
				: ` · ${round.allyScore} : ${round.enemyScore}`;
		return `${t("chat.roundNumber", { round: round.round })}${score}`;
	};
	const emptyLabel = t(
		{
			friends: "chat.emptyFriends",
			party: "chat.emptyParty",
			team: "chat.emptyTeam",
			all: "chat.emptyAll",
		}[channel],
	);
	const noRoomLabel = t(
		{
			friends: "chat.noRoom",
			party: "chat.noPartyRoom",
			team: "chat.noTeamRoom",
			all: "chat.noAllRoom",
		}[channel],
	);
	const matchEnded = viewingSaved || (!isFriends && controller.selectedConversation?.ended === true);
	const disabledReason = controller.loginRequired
		? t("chat.loginRequiredDesc")
		: viewingSaved
			? t("chat.savedReadOnly")
		: matchEnded
			? t("chat.matchEnded")
			: noRoomLabel;
	const placeholder = t(
		{
			friends: "chat.placeholder",
			party: "chat.partyPlaceholder",
			team: "chat.matchTeamPlaceholder",
			all: "chat.matchAllPlaceholder",
		}[channel],
	);
	// markReadError included so a rejected mark-read is visible rather than
	// leaving the badge silently hidden.
	const pageError =
		controller.summaryError || controller.summary.savedHistoryError || controller.friendActionError || controller.markReadError;

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
			<ChatChannelRail
				selected={channel}
				available={controller.availableChannels}
				labels={channelLabels}
				onSelect={controller.selectChannel}
			/>
			{isFriends ? (
				<ChatConversationList
					conversations={friendConversations}
					selectedCid={showBot ? null : controller.selectedCid}
					pinned={
						<button
							type="button"
							aria-current={showBot || undefined}
							onClick={() => setBotOpen(true)}
							className={`relative mb-1 flex w-full items-center gap-2.5 rounded-[8px] border border-dashed px-2 py-2 text-left outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] ${
								showBot
									? "border-(--accent-border) bg-[rgba(128,100,233,0.15)]"
									: "border-(--border) hover:bg-(--surface-hover)"
							}`}
						>
							<img src={valoUtilsIcon} alt="" className="size-8 shrink-0 rounded-[6px] bg-(--control) object-contain p-1" />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[12px] font-medium text-(--text-primary)">{botName}</span>
								<span className="block truncate text-[11px] text-(--text-muted)">{t("chat.dummyBotHint")}</span>
							</span>
						</button>
					}
					statusLabels={friendStatusLabels}
					search={controller.conversationSearch}
					searchLabel={t("chat.searchConversations")}
					emptyLabel={t("chat.noConversations")}
					markAsReadLabel={t("chat.markAsRead")}
					onSearchChange={controller.setConversationSearch}
					onSelect={(cid) => {
						setBotOpen(false);
						controller.selectConversation(cid);
					}}
					onMarkRead={controller.markConversationRead}
				/>
			) : (
				<ChatChannelContext
					channel={channel}
					title={channelLabels[channel]}
					available={!!controller.selectedCid && !matchEnded}
					history={(channel === "team" || channel === "all") ? (
						<div className="px-4 py-2">
							<label className="block text-[11px] text-(--text-muted)">
								{t("chat.savedMatchHistory")}
								<select className="mt-2 w-full rounded-[6px] border border-(--border) bg-(--control) p-2 text-[12px] text-(--text-primary)"
									value={viewingSaved ? savedMatch.matchUuid : ""}
									onChange={event => setSavedSelection(event.target.value ? { owner: controller.summary.ownerPuuid ?? "", matchUuid: event.target.value } : null)}>
									<option value="">{t("chat.currentChat")}</option>
									{savedMatches.map(match => <option key={match.matchUuid} value={match.matchUuid}>
										{new Date(match.updatedAt).toLocaleString()} · {match.matchUuid.slice(0, 8)}
									</option>)}
								</select>
							</label>
							{savedMatches.length === 0 && <p className="mt-2 text-[11px] text-(--text-muted)">{t("chat.noSavedMatches")}</p>}
						</div>
					) : undefined}
					members={roomMembers}
					commands={commandHints}
					labels={{
						available: t("chat.available"),
						unavailable: viewingSaved ? t("chat.savedReadOnly") : matchEnded ? t("chat.matchEnded") : noRoomLabel,
						members: t("chat.roomMembers"),
						membersEmpty: t("chat.roomMembersEmpty"),
						allies: t("chat.allies"),
						enemies: t("chat.enemies"),
						you: t("chat.you"),
						noAgent: t("chat.noAgent"),
						commands: t("chat.commands"),
					}}
					onPickCommand={pickCommand}
				/>
			)}

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
				) : controller.loginRequired && !showBot ? (
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
							conversationId={showBot ? DUMMY_BOT_CID : viewingSaved ? `${savedMatch.matchUuid}:${channel}` : controller.selectedCid}
							title={showBot ? botName : threadTitle}
							icon={
								showBot ? (
									<img src={valoUtilsIcon} alt="" className="size-7.5 shrink-0 rounded-[6px] bg-(--control) object-contain p-1" />
								) : controller.selectedFriendConversation ? (
									<PlayerCardAvatar
										cardId={controller.selectedFriendConversation.playerCardId}
										name={controller.selectedFriendConversation.title}
										className="size-7.5"
									/>
								) : undefined
							}
							subtitle={showBot ? t("chat.dummyBotSubtitle") : viewingSaved ? savedMatch.matchUuid : threadSubtitle}
							messages={showBot ? bot.messages : viewingSaved ? historyMessages : controller.visibleMessages}
							systemLines={showBot || viewingSaved ? [] : controller.systemLines}
							historyLoading={showBot || viewingSaved ? false : controller.historyLoading}
							historyError={showBot || viewingSaved ? null : controller.historyError}
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
								running: t("chat.commandRunning"),
								formatDay,
								sent: t("chat.sent"),
							}}
							onRetryHistory={controller.retryHistory}
							onTranslate={controller.translateMessage}
							describeSender={
								showBot
									? () => ({ name: botName, agentLabel: "BOT", agentIcon: valoUtilsIcon, iconContain: true })
									: isFriends
										? (message) => ({
												name: message.senderName || controller.selectedFriendConversation?.title || "",
												agentLabel: "",
												agentIcon: null,
												cardId: controller.selectedFriendConversation?.playerCardId,
											})
										: describeSender
							}
							notice={
								!isFriends && controller.selectedCid && !viewingSaved
									? t("chat.joinedRoom", { room: channelLabels[channel] })
									: undefined
							}
							formatRound={isFriends ? undefined : formatRound}
							onOpenFriends={(trigger) => {
								friendsDrawerTriggerRef.current = trigger;
								setFriendsDrawerOpen(true);
							}}
						/>
						<ChatComposer
							draft={showBot ? bot.draft : viewingSaved ? "" : controller.draft}
							disabled={showBot ? false : !controller.selectedCid || matchEnded}
							disabledReason={disabledReason}
							sending={showBot ? bot.sending : controller.sending}
							sendError={showBot ? bot.error : controller.sendError}
							placeholder={showBot ? t("chat.dummyBotPlaceholder") : placeholder}
							sendLabel={t("chat.send")}
							sendingLabel={t("chat.sending")}
							commands={commandHints}
							inputRef={composerRef}
							onDraftChange={showBot ? bot.setDraft : controller.setDraft}
							onSend={showBot ? bot.send : controller.sendMessage}
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
