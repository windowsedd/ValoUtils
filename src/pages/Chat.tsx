import type { ChatFriend, ChatMessage, ChatResponse, ChatRooms, ChatScope, ChatSendResponse, TranslateResponse } from "@/types/chat";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaArrowLeft, FaBug, FaComments, FaLanguage, FaMagnifyingGlass, FaPaperPlane, FaRightToBracket, FaRotate, FaUserGroup, FaUserPlus } from "react-icons/fa6";

const POLL_MS = 5000;

const formatTime = (value: string | null) => {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

type MatchChannel = "team" | "all";

const getMatchChannel = (conversationId: string): MatchChannel | null => {
	if (/-all@ares-coregame/i.test(conversationId)) return "all";
	if (/-(blue|red)@ares-coregame/i.test(conversationId)) return "team";
	return null;
};

type ChatGroup = {
	id: string;
	title: string;
	messages: ChatMessage[];
	latestTime: number;
};

const getMessageTime = (message: ChatMessage) => {
	const time = message.timestamp ? new Date(message.timestamp).getTime() : 0;
	return Number.isNaN(time) ? 0 : time;
};

const getGroupTitle = (messages: ChatMessage[]) => {
	const named = messages.find((message) => !message.isSelf && message.senderName && message.senderName !== message.sender);
	if (named) return named.senderName;
	const sender = messages.find((message) => !message.isSelf && message.senderName)?.senderName;
	return sender || "Unknown";
};

const friendPresenceText = (friend: ChatFriend) => {
	if (!friend.isOnline) return "Offline";
	if (friend.statusMessage && friend.statusMessage !== "chat") return friend.statusMessage;
	if (friend.queueId) return friend.queueId;
	if (friend.product) return friend.product;
	return friend.status === "away" ? "Away" : "Online";
};

const Chat = () => {
	const { t } = useTranslation();
	const [scope, setScope] = useState<ChatScope>("friends");
	const [matchChannel, setMatchChannel] = useState<MatchChannel>("team");
	const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [friends, setFriends] = useState<ChatFriend[]>([]);
	const [friendSearch, setFriendSearch] = useState("");
	const [actionFriendId, setActionFriendId] = useState<string | null>(null);
	const [rooms, setRooms] = useState<ChatRooms>({});
	const [rawDebug, setRawDebug] = useState<ChatResponse | null>(null);
	const [debugOpen, setDebugOpen] = useState(false);
	const [translated, setTranslated] = useState<Record<string, string>>({});
	const [translatingId, setTranslatingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
	const [inspectMessageId, setInspectMessageId] = useState<string | null>(null);

	const refresh = () => {
		if (!window.Main) return;
		window.Main.send("chat:get");
	};

	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("chat:get", (message: string) => {
			const res = JSON.parse(message) as ChatResponse;
			setRawDebug(res);
			setLoading(false);
			if (!res.success) {
				setLoginRequired("code" in res && res.code === "loginRequired");
				setError(("error" in res && res.error) || t("chat.failedToLoad"));
				return;
			}
			setLoginRequired(false);
			setError(null);
			setMessages(res.messages);
			setFriends(res.friends ?? []);
			setRooms(res.rooms ?? {});
			setLastFetchedAt(res.fetchedAt);
		});
		refresh();
		const interval = setInterval(refresh, POLL_MS);
		return () => {
			clearInterval(interval);
			window.Main.removeAllListeners("chat:get");
			window.Main.removeAllListeners("chat:translate");
			window.Main.send("chat:disconnect");
		};
	}, []);

	useEffect(() => {
		if (matchChannel === "all" && !rooms.matchAll && rooms.matchTeam) {
			setMatchChannel("team");
		}
		if (matchChannel === "team" && !rooms.matchTeam && rooms.matchAll) {
			setMatchChannel("all");
		}
	}, [matchChannel, rooms.matchAll, rooms.matchTeam]);

	const orderedMessages = useMemo(() => {
		const filtered = messages.filter((message) => message.scope === scope);
		return [...filtered].sort((a, b) => {
			return getMessageTime(b) - getMessageTime(a);
		});
	}, [messages, scope]);

	const groupedMessages = useMemo(() => {
		if (scope !== "friends") return [];
		const groups = new Map<string, ChatMessage[]>();
		for (const message of orderedMessages) {
			const key = message.conversationId || message.sender || message.id;
			(groups.get(key) ?? groups.set(key, []).get(key)!).push(message);
		}
		return [...groups.entries()]
			.map(
				([id, groupMessages]): ChatGroup => ({
					id,
					title: getGroupTitle(groupMessages),
					messages: groupMessages,
					latestTime: Math.max(...groupMessages.map(getMessageTime)),
				}),
			)
			.sort((a, b) => b.latestTime - a.latestTime);
	}, [orderedMessages, scope]);

	const selectedFriendGroup = useMemo(() => {
		if (!selectedFriendId) return null;
		return groupedMessages.find((group) => group.id === selectedFriendId) ?? null;
	}, [groupedMessages, selectedFriendId]);

	const selectedMatchRoom = matchChannel === "all" ? (rooms.matchAll ?? "") : (rooms.matchTeam ?? "");

	const matchChannelMessages = useMemo(() => {
		if (scope !== "match") return [];
		return orderedMessages.filter((message) => {
			if (selectedMatchRoom && message.conversationId === selectedMatchRoom) return true;
			const channel = getMatchChannel(message.conversationId);
			return channel ? channel === matchChannel : !selectedMatchRoom;
		});
	}, [matchChannel, orderedMessages, scope, selectedMatchRoom]);

	const visibleMessages = scope === "friends" ? (selectedFriendGroup?.messages ?? []) : scope === "match" ? matchChannelMessages : orderedMessages;

	const targetConversationId = scope === "friends" ? (selectedFriendGroup?.id ?? "") : scope === "match" ? selectedMatchRoom || rooms.match || orderedMessages.find((message) => getMatchChannel(message.conversationId) === matchChannel)?.conversationId || orderedMessages.find((message) => message.conversationId)?.conversationId || "" : (rooms[scope] ?? orderedMessages.find((message) => message.conversationId)?.conversationId ?? "");

	const filteredFriends = useMemo(() => {
		const query = friendSearch.trim().toLowerCase();
		return friends.filter((friend) => {
			if (!query) return true;
			return `${friend.displayName} ${friend.statusMessage} ${friend.queueId}`.toLowerCase().includes(query);
		});
	}, [friendSearch, friends]);

	const translate = (message: ChatMessage) => {
		if (!window.Main || translatingId) return;
		setTranslatingId(message.id);
		window.Main.removeAllListeners("chat:translate");
		window.Main.on("chat:translate", (payload: string) => {
			window.Main.removeAllListeners("chat:translate");
			setTranslatingId(null);
			const res = JSON.parse(payload) as TranslateResponse;
			if (!res.success) {
				setError(res.error);
				return;
			}
			setTranslated((prev) => ({ ...prev, [message.id]: res.translatedText }));
		});
		window.Main.send("chat:translate", message.body);
	};

	const sendMessage = () => {
		if (!window.Main || sending) return;
		const text = draft.trim();
		if (!text) return;
		if (!targetConversationId) {
			setError(t(scope === "match" ? "chat.noMatchRoom" : scope === "party" ? "chat.noPartyRoom" : "chat.noRoom"));
			return;
		}

		setSending(true);
		window.Main.removeAllListeners("chat:send");
		window.Main.on("chat:send", (payload: string) => {
			window.Main.removeAllListeners("chat:send");
			setSending(false);
			const res = JSON.parse(payload) as ChatSendResponse;
			if (!res.success) {
				setError(res.error);
				return;
			}
			setError(null);
			setDraft("");
			refresh();
		});
		window.Main.send("chat:send", targetConversationId, text);
	};

	const runFriendAction = (action: "invite" | "join", friend: ChatFriend) => {
		if (!window.Main) return;
		setActionFriendId(null);
		window.Main.removeAllListeners("chat:friend-action");
		window.Main.on("chat:friend-action", (payload: string) => {
			window.Main.removeAllListeners("chat:friend-action");
			const res = JSON.parse(payload) as ChatSendResponse;
			if (!res.success) {
				setError(res.error);
				return;
			}
			setError(null);
			refresh();
		});
		window.Main.send("chat:friend-action", action, friend);
	};

	const lastRefresh = lastFetchedAt ? formatTime(lastFetchedAt) : "";

	return (
		<div className="h-full min-h-0 bg-[#25211f] text-gray-200 flex animate-fade-in overflow-hidden">
			<main className="min-w-0 flex-1 flex flex-col">
				<header className="h-14 px-5 flex items-center justify-between border-b border-black/30 bg-[#1f1b1a] shrink-0">
					<div className="flex items-center gap-3">
						<h1 className="text-lg font-bold tracking-wide text-gray-200"></h1>
						<div className="flex bg-[#3b3734] rounded-sm overflow-hidden">
							{(["friends", "party", "match"] as const).map((item) => (
								<button
									key={item}
									type="button"
									onClick={() => {
										setScope(item);
										setSelectedFriendId(null);
									}}
									className={`px-3 py-1 text-xs font-semibold transition-colors ${scope === item ? "bg-[#5a5550] text-white" : "text-gray-400 hover:text-white"}`}
								>
									{t(item === "match" ? "chat.scopeMatch" : item === "party" ? "chat.scopeParty" : "chat.scopeFriends")}
								</button>
							))}
						</div>
						{scope === "match" && (
							<div className="flex bg-[#3b3734] rounded-sm overflow-hidden">
								{(["team", "all"] as const).map((channel) => {
									const room = channel === "team" ? rooms.matchTeam : rooms.matchAll;
									return (
										<button key={channel} type="button" onClick={() => setMatchChannel(channel)} disabled={!room} className={`px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${matchChannel === channel ? "bg-[#d9d1c7] text-[#201c1a]" : "text-gray-400 hover:text-white"}`}>
											{t(channel === "team" ? "chat.matchTeam" : "chat.matchAll")}
										</button>
									);
								})}
							</div>
						)}
					</div>
					<div className="flex items-center gap-2">
						{lastRefresh && <span className="text-xs text-gray-500">{t("chat.lastRefresh", { time: lastRefresh })}</span>}
						<button type="button" onClick={() => setDebugOpen((open) => !open)} className={`w-8 h-8 flex items-center justify-center rounded-sm ${debugOpen ? "bg-[#5a5550] text-white" : "text-gray-400 hover:bg-[#3b3734]"}`}>
							<FaBug />
						</button>
						<button type="button" onClick={refresh} className="w-8 h-8 flex items-center justify-center rounded-sm text-gray-400 hover:bg-[#3b3734]">
							<FaRotate />
						</button>
					</div>
				</header>

				{debugOpen && (
					<div className="mx-5 mt-4 p-3 bg-[#171514] border border-white/10 max-h-52 overflow-auto shrink-0">
						<pre className="text-xs text-gray-300 whitespace-pre-wrap break-all font-mono">{JSON.stringify({ scope, matchChannel, targetConversationId, rooms, friends: filteredFriends, visibleMessages, rawResponseAllScopes: rawDebug }, null, 2)}</pre>
					</div>
				)}

				<section className="min-h-0 flex-1 px-5 py-4 overflow-y-auto">
					{loading && <div className="h-full flex items-center justify-center text-gray-500 text-sm">{t("chat.loading")}</div>}
					{!loading && loginRequired && (
						<div className="h-full flex items-center justify-center text-center">
							<div className="bg-[#312d2a] border border-white/10 p-6 max-w-md">
								<p className="text-white font-semibold">{t("chat.loginRequired")}</p>
								<p className="text-gray-500 text-sm mt-1">{t("chat.loginRequiredDesc")}</p>
							</div>
						</div>
					)}
					{!loading && error && !loginRequired && (
						<div className="mb-4 bg-red-950/30 border border-red-400/20 px-3 py-2 text-sm text-red-200 flex items-center gap-2">
							<FaLanguage />
							<span>{error}</span>
						</div>
					)}
					{!loading && !loginRequired && scope === "friends" && !selectedFriendGroup && groupedMessages.length > 0 && (
						<div className="max-w-xl space-y-2">
							{groupedMessages.map((group) => (
								<button key={group.id} type="button" onClick={() => setSelectedFriendId(group.id)} className="block max-w-sm bg-[#171514] hover:bg-[#3d3834] text-left px-4 py-3 rounded-sm transition-colors">
									<p className="text-sm font-semibold text-white truncate">{group.title}</p>
									<p className="text-sm text-gray-400 truncate mt-1">{group.messages[0]?.body}</p>
								</button>
							))}
						</div>
					)}
					{!loading && !loginRequired && visibleMessages.length === 0 && (scope !== "friends" || !groupedMessages.length || selectedFriendGroup) && (
						<div className="h-full flex items-center justify-center text-center">
							<div className="text-gray-500">
								<FaComments className="mx-auto text-3xl mb-3 opacity-50" />
								<p className="text-white font-semibold">{t(scope === "match" ? "chat.emptyMatch" : scope === "party" ? "chat.emptyParty" : "chat.emptyFriends")}</p>
								<p className="text-sm mt-1">{t(scope === "match" ? "chat.emptyMatchDesc" : scope === "party" ? "chat.emptyPartyDesc" : "chat.emptyFriendsDesc")}</p>
							</div>
						</div>
					)}
					{!loading && !loginRequired && (scope !== "friends" || selectedFriendGroup) && visibleMessages.length > 0 && (
						<div className="space-y-3">
							{scope === "friends" && selectedFriendGroup && (
								<button type="button" onClick={() => setSelectedFriendId(null)} className="mb-2 text-xs text-gray-400 hover:text-white flex items-center gap-2">
									<FaArrowLeft />
									{selectedFriendGroup.title}
								</button>
							)}
							{[...visibleMessages].reverse().map((message) => {
								const channelLabel = scope === "match" ? t(getMatchChannel(message.conversationId) === "all" ? "chat.matchAll" : "chat.matchTeam") : undefined;
								const isInspecting = inspectMessageId === message.id;
								return (
									<div key={message.id} className={`flex flex-col ${message.isSelf ? "items-end" : "items-start"}`}>
										<div className={`max-w-[68%] px-4 py-2 rounded-sm cursor-pointer ${message.isSelf ? "bg-[#514c47] text-right" : "bg-[#171514]"} ${isInspecting ? "ring-1 ring-white/20" : ""}`} onClick={() => setInspectMessageId(isInspecting ? null : message.id)}>
											<div className="flex items-center gap-2 mb-1">
												<p className="text-xs font-semibold text-[#d9d1c7] truncate">{message.senderName || t("chat.unknownSender")}</p>
												{channelLabel && <span className="text-[10px] text-blue-300">{channelLabel}</span>}
												<span className="text-[10px] text-gray-500">{formatTime(message.timestamp)}</span>
											</div>
											<p className="text-sm break-words">{message.body}</p>
											{translated[message.id] && <p className="text-sm text-blue-200 mt-2 break-words">{translated[message.id]}</p>}
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													translate(message);
												}}
												disabled={translatingId === message.id}
												className="text-[10px] text-gray-500 hover:text-white mt-2"
											>
												{translatingId === message.id ? t("chat.translating") : t("chat.translate")}
											</button>
										</div>
										{isInspecting && (
											<div className="mt-1 max-w-[80%] space-y-1">
												<div className="px-2 py-1 bg-[#1a2a1a] border border-green-900/40 text-[10px] text-green-300 font-mono font-semibold">RESPONSE (processed)</div>
												<pre className="p-2 bg-[#0d0c0b] border border-white/10 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-all overflow-auto max-h-48">{JSON.stringify({ ...message, _raw: undefined }, null, 2)}</pre>
												{message._raw !== undefined && (
													<>
														<div className="px-2 py-1 bg-[#1a1a2a] border border-blue-900/40 text-[10px] text-blue-300 font-mono font-semibold">RAW (from API)</div>
														<pre className="p-2 bg-[#0d0c0b] border border-white/10 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-all overflow-auto max-h-48">{JSON.stringify(message._raw, null, 2)}</pre>
													</>
												)}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</section>

				<footer className="h-16 px-5 py-3 bg-[#25211f] shrink-0 flex items-center gap-0">
					<div className="h-10 px-4 min-w-36 bg-[#4f4a45] text-sm text-gray-200 flex items-center">{scope === "match" ? t(matchChannel === "all" ? "chat.matchAll" : "chat.matchTeam") : scope === "party" ? t("chat.scopeParty") : (selectedFriendGroup?.title ?? t("chat.scopeFriends"))}</div>
					<input
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								sendMessage();
							}
						}}
						disabled={!targetConversationId || sending || loginRequired}
						className="h-10 min-w-0 flex-1 px-4 bg-[#5a554f] text-gray-100 placeholder:text-gray-400 outline-none disabled:opacity-50"
						placeholder={targetConversationId ? t(scope === "match" ? (matchChannel === "all" ? "chat.matchAllPlaceholder" : "chat.matchTeamPlaceholder") : scope === "party" ? "chat.partyPlaceholder" : "chat.placeholder") : t(scope === "match" ? "chat.noMatchRoom" : scope === "party" ? "chat.noPartyRoom" : "chat.noRoom")}
					/>
					<button type="button" onClick={sendMessage} disabled={!draft.trim() || !targetConversationId || sending} className="h-10 px-4 bg-[#756f67] text-white hover:bg-[#8a8379] disabled:opacity-40 flex items-center gap-2">
						<FaPaperPlane />
					</button>
				</footer>
			</main>

			<aside className="w-[360px] max-w-[38vw] bg-[#2b2724] border-l border-black/40 flex flex-col shrink-0">
				<div className="p-4 shrink-0">
					<div className="h-11 bg-[#47423d] flex items-center gap-3 px-4 text-gray-200">
						<FaMagnifyingGlass className="text-xl" />
						<input value={friendSearch} onChange={(event) => setFriendSearch(event.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-gray-400" />
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
					{filteredFriends.map((friend) => {
						const isOpen = actionFriendId === friend.puuid;
						return (
							<div key={friend.puuid || friend.displayName} className="relative">
								<button type="button" onClick={() => setActionFriendId(isOpen ? null : friend.puuid)} className={`w-full px-3 py-3 mb-2 flex items-center gap-3 text-left transition-colors border-b border-gray-300/30 rounded-b-2xl ${isOpen ? "bg-[#171514]" : "hover:bg-[#403b36]"}`}>
									<div className="w-12 h-12 bg-[#171514] text-[#d9d1c7] flex items-center justify-center font-bold shrink-0">{friend.gameName?.slice(0, 2).toUpperCase() || "V"}</div>
									<div className="min-w-0 flex-1">
										<p className="text-sm text-gray-100 truncate">{friend.displayName}</p>
										<p className={`text-sm truncate ${friend.status === "away" ? "text-yellow-300" : friend.isOnline ? "text-blue-400" : "text-gray-500"}`}>{friendPresenceText(friend)}</p>
										{friend.partySize !== null && (
											<p className="text-sm text-white mt-1 flex items-center justify-center gap-2">
												<FaUserGroup />
												{friend.partySize > 1 ? friend.partySize : "SOLO"}
											</p>
										)}
									</div>
								</button>
								{isOpen && (
									<div className="absolute right-4 top-12 z-20 w-48 bg-[#8a837b] shadow-xl text-white">
										<button type="button" onClick={() => runFriendAction("invite", friend)} className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[#9b948b] text-left">
											<FaUserPlus />
											Invite
										</button>
										<button type="button" onClick={() => runFriendAction("join", friend)} className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[#9b948b] text-left">
											<FaRightToBracket />
											Join Party
										</button>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</aside>
		</div>
	);
};

export default Chat;
