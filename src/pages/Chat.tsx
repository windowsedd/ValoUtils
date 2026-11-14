import type { ChatFriend, ChatMessage, ChatRound, SavedChatMatch } from "@/types/chat";
import { LoginRequiredPanel } from "@/components/login-required-panel";
import { invoke } from "@tauri-apps/api/core";
import { reportIpcError } from "@/util/ipc";
import { useLiveGameSession } from "@/components/live-game/live-game-session";
import { getMaps, localize, type MapAsset } from "@/util/valorant-assets";
import { queueLabel } from "@/util/valorant-queues";
import { useAgentAssets } from "@/util/use-agent-assets";
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
import { matchOutcome, savedMatchList, savedMatchMessages, savedSpeakerRoster } from "./chat/saved-match-history";
import { ChatHistoryPanel } from "./chat/chat-history-panel";
import { SavedMatchScoreboard } from "./chat/saved-match-scoreboard";
import { useSavedHistoryAccounts } from "./chat/use-saved-history-accounts";
import { SavedMatchPicker } from "./chat/saved-match-picker";
import { useSavedMatchDetails } from "./chat/use-saved-match-details";

/** Stable empty list, so the details hook doesn't see a new array on every render. */
const EMPTY_SAVED: SavedChatMatch[] = [];

const Chat = () => {
	const { t } = useTranslation();
	const controller = useChatController();
	const [friendsDrawerOpen, setFriendsDrawerOpen] = useState(false);
	const [selectedFriendPuuid, setSelectedFriendPuuid] = useState<string | null>(null);
	const friendsDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const [botOpen, setBotOpen] = useState(false);
	const { snapshot } = useLiveGameSession();
	const agents = useAgentAssets(
		snapshot?.state === "idle" ? [] : (snapshot?.players ?? []).map((player) => player.characterId),
	);
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
	// History tab: saved match chat, read one room (Team or All) at a time.
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyRoom, setHistoryRoom] = useState<"team" | "all">("team");
	const [savedSelection, setSavedSelection] = useState<{ owner: string; matchUuid: string } | null>(null);
	const savedMatches = useSavedMatchDetails(
		controller.summary.savedMatches ?? EMPTY_SAVED,
		controller.summary.ownerPuuid,
		historyOpen && !controller.loginRequired,
	);
	// Every account with saved chat; the signed-in one stays live. Works signed out.
	const history = useSavedHistoryAccounts(
		historyOpen,
		controller.loginRequired ? "" : (controller.summary.ownerPuuid ?? ""),
		savedMatches,
	);
	const historyMatches = history.matches;
	// Opening History shows the newest match until another one is picked.
	const newestSaved = useMemo(() => savedMatchList(historyMatches, historyRoom)[0]?.matchUuid, [historyMatches, historyRoom]);
	const selectedSaved =
		savedSelection && savedSelection.owner === history.owner ? savedSelection.matchUuid : newestSaved;
	const savedMatch = historyOpen
		? historyMatches.find(match => match.matchUuid === selectedSaved)
		: undefined;
	const viewingSaved = !!savedMatch;
	// Riot ID of the account whose saved history is shown. Read once from the
	// local Riot Client and kept only if it is the same account as the history.
	const ownerPuuid = controller.summary.ownerPuuid ?? "";
	const [historyOwner, setHistoryOwner] = useState<{ puuid: string; name: string } | null>(null);
	useEffect(() => {
		if (!historyOpen || !ownerPuuid || historyOwner?.puuid === ownerPuuid) return;
		let active = true;
		invoke<{ sub?: string; acct?: { game_name?: string; tag_line?: string } }>("userinfo_get")
			.then((info) => {
				const name = info?.acct?.game_name ? `${info.acct.game_name}#${info.acct.tag_line ?? ""}` : "";
				const sub = String(info?.sub ?? "").toLowerCase();
				if (active && name && (!sub || sub === ownerPuuid.toLowerCase())) {
					setHistoryOwner({ puuid: ownerPuuid, name });
				}
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [historyOpen, ownerPuuid, historyOwner]);
	const historyOwnerName =
		history.names[history.owner.toLowerCase()] ||
		(historyOwner?.puuid === ownerPuuid && history.owner === ownerPuuid ? historyOwner.name : "");
	const historyMessages = savedMatchMessages(savedMatch, historyRoom);
	const savedRoster = useMemo(
		() => savedSpeakerRoster(savedMatch?.details, history.names),
		[savedMatch?.details, history.names],
	);
	const [maps, setMaps] = useState<Map<string, MapAsset> | null>(null);
	useEffect(() => {
		if (!viewingSaved || maps) return;
		let cancelled = false;
		getMaps()
			.then((loaded) => {
				if (!cancelled) setMaps(loaded);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [viewingSaved, maps]);
	const channelLabels = {
		friends: t("chat.scopeFriends"),
		party: t("chat.scopeParty"),
		team: t("chat.matchTeam"),
		all: t("chat.matchAll"),
	};
	const isFriends = channel === "friends" && !historyOpen;
	// The room whose labels the thread uses: the saved room while History is open.
	const viewChannel = historyOpen ? historyRoom : channel;
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
		: channelLabels[viewChannel];
	const livePlayers = snapshot && snapshot.state !== "idle" ? snapshot.players : [];
	const roomMembers: ChatRoomMemberView[] = channel === "friends" || historyOpen
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
		{ insert: ".party join ", syntax: t("dummyBot.partyJoinSyntax"), description: t("dummyBot.partyJoinDesc") },
		{ insert: ".party leave", syntax: t("dummyBot.partyLeaveSyntax"), description: t("dummyBot.partyLeaveDesc") },
		{ insert: ".code create", syntax: t("dummyBot.codeCreateSyntax"), description: t("dummyBot.codeCreateDesc") },
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
	/** Map · mode · result · start time, in place of the raw match ID. */
	const savedSubtitle = (() => {
		const details = savedMatch?.details;
		if (!details) return t("chat.savedReadOnly");
		const mapKey = details.mapId.toLowerCase();
		const map = maps?.get(mapKey) ?? maps?.get(mapKey.split("/").filter(Boolean).pop() ?? "");
		const outcome = matchOutcome(details);
		const result = outcome
			? `${t({ win: "chat.outcomeWin", loss: "chat.outcomeLoss", draw: "chat.outcomeDraw" }[outcome])} ${details.roundsWon}–${details.roundsLost}`
			: "";
		const started = details.startMillis
			? new Date(details.startMillis).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
			: "";
		return [historyOwnerName, map ? localize(map.name) : "", queueLabel(details.queueId), result, started]
			.filter(Boolean)
			.join(" · ");
	})();
	const describeSender = (message: ChatMessage): ChatThreadSender => {
		const identity = chatSenderIdentity(message, viewingSaved ? savedRoster : roster);
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
	const emptyLabel = historyOpen && !viewingSaved ? t("chat.noSavedMatches") : t(
		{
			friends: "chat.emptyFriends",
			party: "chat.emptyParty",
			team: "chat.emptyTeam",
			all: "chat.emptyAll",
		}[viewChannel],
	);
	const noRoomLabel = t(
		{
			friends: "chat.noRoom",
			party: "chat.noPartyRoom",
			team: "chat.noTeamRoom",
			all: "chat.noAllRoom",
		}[viewChannel],
	);
	const matchEnded = historyOpen || (!isFriends && controller.selectedConversation?.ended === true);
	const disabledReason = controller.loginRequired
		? t("chat.loginRequiredDesc")
		: historyOpen
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
		}[viewChannel],
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
				onSelect={(next) => {
					setHistoryOpen(false);
					controller.selectChannel(next);
				}}
				history={{
					active: historyOpen,
					label: t("chat.history"),
					count: savedMatches.length,
					onOpen: () => {
						setHistoryOpen(true);
						invoke("analytics_track", { args: ["chat:history-open"] }).catch(reportIpcError);
					},
				}}
			/>
			{historyOpen ? (
				<ChatHistoryPanel
					title={t("chat.savedMatchHistory")}
					owner={historyOwnerName}
					accounts={history.accounts}
					selectedAccount={history.owner}
					onAccountChange={(puuid) => {
						history.setOwner(puuid);
						setSavedSelection(null);
						invoke("analytics_track", { args: ["chat:history-account"] }).catch(reportIpcError);
					}}
					room={historyRoom}
					onRoomChange={setHistoryRoom}
					labels={{
						team: channelLabels.team,
						all: channelLabels.all,
						room: t("chat.historyRoom"),
						owner: t("chat.historyOwner"),
						account: t("chat.historyAccount"),
						matchCount: (count) => t("chat.historyMatchCount", { count }),
					}}
				>
					<SavedMatchPicker
						matches={historyMatches}
						names={history.names}
						channel={historyRoom}
						selected={savedMatch?.matchUuid ?? null}
						onSelect={(matchUuid) => setSavedSelection(matchUuid ? { owner: history.owner, matchUuid } : null)}
						showCurrent={false}
						fill
						labels={{
							title: t("chat.savedMatchHistory"),
							current: t("chat.currentChat"),
							currentHint: t("chat.currentChatHint"),
							empty: t("chat.noSavedMatches"),
							search: t("chat.searchSavedMatches"),
							noResults: t("chat.noSavedMatchResults"),
							today: t("chat.historyToday"),
							yesterday: t("chat.historyYesterday"),
							counts: (team, all) => t("chat.savedMatchCounts", { team, all }),
							speakers: (count) => t("chat.savedMatchSpeakers", { count }),
							noMessages: t("chat.savedMatchNoMessages"),
							outcome: { win: t("chat.outcomeWin"), loss: t("chat.outcomeLoss"), draw: t("chat.outcomeDraw") },
						}}
					/>
				</ChatHistoryPanel>
			) : channel === "friends" ? (
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

				{controller.loading && !historyOpen ? (
					<div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-(--text-muted)">
						{t("chat.loading")}
					</div>
				) : controller.loginRequired && !showBot && !historyOpen ? (
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
						{/* Saved chat is local, so it can be read without signing in. */}
						<button
							type="button"
							className="h-8 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[12px] font-medium text-(--text-primary) hover:bg-(--surface-hover)"
							onClick={() => setHistoryOpen(true)}
						>
							{t("chat.viewSavedChat")}
						</button>
					</LoginRequiredPanel>
				) : (
					<>
						{viewingSaved && (
							<SavedMatchScoreboard
								key={savedMatch.matchUuid}
								matchUuid={savedMatch.matchUuid}
								ownerPuuid={history.owner}
							/>
						)}
						<ChatThread
							conversationId={showBot ? DUMMY_BOT_CID : viewingSaved ? `${savedMatch.matchUuid}:${historyRoom}` : historyOpen ? null : controller.selectedCid}
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
							subtitle={showBot ? t("chat.dummyBotSubtitle") : viewingSaved ? savedSubtitle : historyOpen ? t("chat.savedReadOnly") : threadSubtitle}
							messages={showBot ? bot.messages : historyOpen ? historyMessages : controller.visibleMessages}
							systemLines={showBot || historyOpen ? [] : controller.systemLines}
							historyLoading={showBot || historyOpen ? false : controller.historyLoading}
							historyError={showBot || historyOpen ? null : controller.historyError}
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
								!isFriends && controller.selectedCid && !historyOpen
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
							draft={showBot ? bot.draft : historyOpen ? "" : controller.draft}
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
