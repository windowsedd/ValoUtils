import { invoke } from "@tauri-apps/api/core";
import { LoginRequiredPanel } from "@/components/login-required-panel";
import type { Friend, FriendRequest, FriendsResponse } from "@/types/friends";
import type { FriendProfileData } from "@/types/friend-profile";
import { getMaps, getPlayerCard, getTiers, type CardAsset, type MapAsset, type TierAsset } from "@/util/valorant-assets";
import { tierName } from "@/util/valorant-ranks";
import { mapName } from "@/util/valorant-maps";
import { queueLabel } from "@/util/valorant-queues";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import { FriendProfile } from "@/components/friends/friend-profile";
import {
	FriendIdentity,
	matchesFriendRequestSearch,
	matchesFriendSearch,
} from "@/components/friends/friend-identity";
import { useTranslation } from "react-i18next";
import { FaMagnifyingGlass } from "react-icons/fa6";
import { LuCopy, LuIdCard, LuLogIn, LuMessageSquare, LuStar, LuUserPlus, LuUsers } from "react-icons/lu";
import { gooeyToast as toast } from "goey-toast";
import { reportIpcError } from "@/util/ipc";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { navigateTo, shareWhisper } from "@/util/deep-links";
import { playerCardSmallArt } from "./chat/player-card-avatar";
import { PLAYER_CARD_CACHE_KEY } from "./chat/use-chat-controller";

/**
 * Each friend's last seen player card by bare lowercase PUUID, on this device,
 * shared with Chat (which also finds cards for offline friends). Presence only
 * carries the card while a friend is in VALORANT.
 */
const readCardMemory = (): Record<string, string> => {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(PLAYER_CARD_CACHE_KEY) ?? "{}");
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
};

const POLL_MS = 10000;

export const isVisibleFriend = (
	friend: Pick<Friend, "gameName" | "tagLine">,
) =>
	friend.gameName.trim().toLowerCase() !== "valoutils bot" ||
	friend.tagLine.trim().toLowerCase() !== "bot";

/** Riot product ids -> the game names shown as section headings and details. */
const PRODUCT_LABELS: Record<string, string> = {
	league_of_legends: "League of Legends",
	valorant: "VALORANT",
	bacon: "Legends of Runeterra",
	wildrift: "Wild Rift",
	riot_client: "Riot Client",
	keystone: "Riot Client",
};

type Presence = { key: string; label: string; className: string };

/**
 * One word for the profile view. `state` comes from the chat presence ("dnd" is
 * what VALORANT sets while in a match) and `sessionLoopState` from the decoded
 * VALORANT blob, which is the more specific of the two.
 */
const presenceOf = (friend: Friend, t: (k: string) => string): Presence => {
	if (!friend.isOnline) return { key: "offline", label: t("friends.offline"), className: "text-gray-600" };
	const loop = friend.valorant?.sessionLoopState;
	if (loop === "INGAME") return { key: "inMatch", label: t("friends.inMatch"), className: "text-gray-400" };
	if (friend.state === "away") return { key: "away", label: t("friends.away"), className: "text-yellow-500/80" };
	if (loop === "PREGAME") return { key: "agentSelect", label: t("friends.agentSelect"), className: "text-gray-400" };
	if (loop === "MENUS") return { key: "inLobby", label: t("friends.inLobby"), className: "text-gray-400" };
	return { key: "online", label: t("friends.online"), className: "text-green-500/80" };
};

/** Where a friend is, which is also the section they are listed in. */
type Activity = "match" | "lobby" | "otherGame" | "online" | "away" | "offline";

const activityOf = (friend: Friend): Activity => {
	if (!friend.isOnline) return "offline";
	if (friend.product === "valorant" && friend.playing) {
		const loop = friend.valorant?.sessionLoopState;
		// Agent select counts as the match: the lobby is behind them.
		return loop === "INGAME" || loop === "PREGAME" ? "match" : "lobby";
	}
	if (friend.playing) return "otherGame";
	return friend.state === "away" ? "away" : "online";
};

/** A party you can still join: Riot says it has room. */
const hasRoom = (friend: Friend) => {
	const v = friend.valorant;
	return !!v?.partyId && (v.partySize ?? 1) < (v.maxPartySize ?? 5);
};

/** Riot reports last_online_ts in milliseconds; older payloads used seconds. */
const lastOnlineMs = (value: number | null) => (value && value < 1e12 ? value * 1000 : value);

const relativeTime = (ms: number, locale: string) => {
	const seconds = Math.round((ms - Date.now()) / 1000);
	const steps: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 31_536_000],
		["month", 2_592_000],
		["week", 604_800],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	for (const [unit, size] of steps) {
		if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
	}
	return format.format(0, "minute");
};

/** Player card with the competitive tier badge tucked into the corner. */
const Avatar = ({
	friend,
	cardId,
	cards,
	tiers,
	dim = false,
}: {
	friend: Friend;
	/** From presence, or the card this friend last showed. */
	cardId?: string;
	cards: Map<string, CardAsset>;
	tiers: Map<number, TierAsset>;
	/** Offline: the card stays recognisable but steps back. */
	dim?: boolean;
}) => {
	const id = cardId?.toLowerCase();
	// The resolved asset when loaded, otherwise the card's fixed CDN art.
	const src = id ? (cards.get(id)?.icon ?? playerCardSmallArt(id)) : null;
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const icon = src && failedSrc !== src ? src : undefined;
	const tier = friend.valorant?.competitiveTier ?? 0;
	const tierIcon = tier > 0 ? tiers.get(tier)?.icon : undefined;

	return (
		<div className={`relative size-10 shrink-0 ${dim ? "opacity-55 grayscale-[0.6]" : ""}`}>
			{icon ? (
				<img
					src={icon}
					alt=""
					loading="lazy"
					onError={() => setFailedSrc(icon)}
					className="size-10 rounded-[8px] bg-(--control) object-cover"
				/>
			) : (
				<div className="grid size-10 place-items-center rounded-[8px] bg-(--control) text-[12px] font-semibold text-(--text-muted)">
					{friend.gameName.slice(0, 2).toUpperCase() || "?"}
				</div>
			)}
			{tierIcon && (
				<img
					src={tierIcon}
					alt={tierName(tier)}
					title={tierName(tier)}
					className="absolute -bottom-1 -right-1 size-4 object-contain drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]"
				/>
			)}
		</div>
	);
};

/** One labelled icon action on a friend row. */
const RowAction = ({
	label,
	onClick,
	disabled = false,
	pressed,
	visible = false,
	tone = "default",
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	pressed?: boolean;
	/** Always shown, not only on row hover or focus (an active star). */
	visible?: boolean;
	tone?: "default" | "warn";
	children: ReactNode;
}) => (
	<Tooltip>
		<TooltipTrigger asChild>
			<Button
				variant="ghost"
				size="icon"
				aria-label={label}
				aria-pressed={pressed}
				disabled={disabled}
				onClick={onClick}
				className={`press-flat transition-[opacity,color,background-color] duration-150 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none ${
					tone === "warn" ? "text-(--signal-warn) hover:text-(--signal-warn)" : "text-(--text-muted) hover:text-(--text-primary)"
				} ${visible ? "opacity-100" : "opacity-0"}`}
			>
				{children}
			</Button>
		</TooltipTrigger>
		<TooltipContent side="top">{label}</TooltipContent>
	</Tooltip>
);

const Friends = () => {
	const { t, i18n } = useTranslation();
	const [friends, setFriends] = useState<Friend[]>([]);
	const [requests, setRequests] = useState<FriendRequest[]>([]);
	const [cards, setCards] = useState<Map<string, CardAsset>>(new Map());
	const [cardMemory, setCardMemory] = useState<Record<string, string>>(readCardMemory);
	const [tiers, setTiers] = useState<Map<number, TierAsset>>(new Map());
	const [maps, setMaps] = useState<Map<string, MapAsset>>(new Map());
	const [search, setSearch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const [live, setLive] = useState(false);
	const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
	// `${puuid}:${action}` while an invite or join request is in flight.
	const [busy, setBusy] = useState<string | null>(null);
	// Starred friends get a notification when a match starts and ends.
	const [watched, setWatched] = useState<Set<string>>(new Set());
	useEffect(() => {
		let active = true;
		invoke<{ watchedFriends?: string[] }>("config_get_all")
			.then((config) => {
				if (active) setWatched(new Set((config.watchedFriends ?? []).map((id) => id.toLowerCase())));
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, []);
	const toggleWatch = (friend: Friend) => {
		const puuid = friend.puuid.toLowerCase();
		const watch = !watched.has(puuid);
		invoke<{ success: boolean; watched?: string[]; error?: string }>("friends_watch_set", { args: [puuid, watch] })
			.then((reply) => {
				if (reply.success) setWatched(new Set(reply.watched ?? []));
			})
			.catch(reportIpcError);
		invoke("analytics_track", { args: ["friends:watch", JSON.stringify({ watch })] }).catch(reportIpcError);
	};

	/** Invite them to your party, or ask to join theirs (same backend as Chat). */
	const partyAction = (friend: Friend, action: "invite" | "join") => {
		const key = `${friend.puuid}:${action}`;
		setBusy(key);
		invoke("analytics_track", { args: ["friends:party", JSON.stringify({ action })] }).catch(reportIpcError);
		invoke<{ success: boolean; error?: string }>("chat_friend_action", {
			args: [action, { gameName: friend.gameName, tagLine: friend.tagLine, partyId: friend.valorant?.partyId ?? "" }],
		})
			.then((reply) => {
				if (reply.success) {
					toast.success(t(action === "invite" ? "friends.inviteSent" : "friends.joinRequested", { name: friend.gameName }));
				} else {
					toast.error(reply.error || t("friends.partyActionFailed"));
				}
			})
			.catch((error) => toast.error(String(error)))
			.finally(() => setBusy((current) => (current === key ? null : current)));
	};

	const copyRiotId = (friend: Friend) => {
		const riotId = friend.tagLine ? `${friend.gameName}#${friend.tagLine}` : friend.gameName;
		invoke("clipboard_set", { args: [riotId] })
			.then(() => toast.success(t("friends.copiedRiotId", { riotId })))
			.catch(reportIpcError);
		invoke("analytics_track", { args: ["friends:copy-riot-id"] }).catch(reportIpcError);
	};

	/** Opens their conversation on the Chat page. */
	const whisper = (friend: Friend) => {
		invoke("analytics_track", { args: ["friends:whisper"] }).catch(reportIpcError);
		shareWhisper(friend.puuid.split("@")[0].toLowerCase());
		navigateTo("chat");
	};

	const [profileCache, setProfileCache] = useState<Record<string, FriendProfileData>>({});
	const listScrollRef = useRef<HTMLDivElement>(null);
	const savedScrollTopRef = useRef(0);
	const visibleFriends = useMemo(() => friends.filter(isVisibleFriend), [friends]);
	const cardFor = (friend: Friend) =>
		friend.valorant?.playerCardId || cardMemory[friend.puuid.split("@")[0].toLowerCase()] || undefined;

	// Remember cards seen in presence, so they stay once the friend leaves VALORANT.
	useEffect(() => {
		const seen = friends
			.map((friend) => [friend.puuid.split("@")[0].toLowerCase(), friend.valorant?.playerCardId?.toLowerCase()] as const)
			.filter((entry): entry is readonly [string, string] => !!entry[0] && !!entry[1]);
		if (seen.every(([puuid, card]) => cardMemory[puuid] === card)) return;
		const next = { ...readCardMemory(), ...cardMemory, ...Object.fromEntries(seen) };
		setCardMemory(next);
		try {
			localStorage.setItem(PLAYER_CARD_CACHE_KEY, JSON.stringify(next));
		} catch {
			// Storage may be unavailable; the cards still show for this session.
		}
	}, [friends, cardMemory]);

	const openFriend = (friend: Friend) => {
		savedScrollTopRef.current = listScrollRef.current?.scrollTop ?? 0;
		setSelectedFriend(friend);
	};
	const closeProfile = () => {
		setSelectedFriend(null);
		window.requestAnimationFrame(() => {
			if (listScrollRef.current) listScrollRef.current.scrollTop = savedScrollTopRef.current;
		});
	};
	const cacheProfile = useCallback((puuid: string, profile: FriendProfileData) => {
		setProfileCache((current) => ({ ...current, [puuid.toLowerCase()]: profile }));
	}, []);

	useEffect(() => {
		let cancelled = false;
		getTiers().then((m) => !cancelled && setTiers(m));
		getMaps().then((m) => !cancelled && setMaps(m));
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const applyFriends = (message: unknown) => {
			const res = message as FriendsResponse;
			setLoading(false);
			if (!res.success) {
				setLive(false);
				setLoginRequired(res.code === "loginRequired");
				// Signed out (or switching accounts): the last list belongs to a
				// session that is gone, so don't leave it under the sign-in panel.
				if (res.code === "loginRequired") {
					setFriends([]);
					setRequests([]);
				}
				setError(res.error ?? t("friends.failedToLoad"));
				return;
			}
			setLive(true);
			setLoginRequired(false);
			setError(null);
			setFriends(res.friends);
			setRequests(res.requests);
		};

		let active = true;
		const refresh = () =>
			invoke<unknown>("friends_get")
				.then((reply) => {
					if (active) applyFriends(reply);
				})
				.catch((error) => {
					if (active) applyFriends({ success: false, error: String(error) });
				});
		refresh();
		const interval = setInterval(refresh, POLL_MS);
		return () => {
			active = false;
			clearInterval(interval);
		};
	}, [t]);

	// Player cards are per-friend lookups, so resolve only the ids we haven't
	// seen yet — the poll re-runs this effect every 10s.
	useEffect(() => {
		const ids = new Set(
			visibleFriends
				.map((f) => f.valorant?.playerCardId?.toLowerCase())
				.filter((id): id is string => Boolean(id) && !cards.has(id!)),
		);
		if (ids.size === 0) return;
		let cancelled = false;
		Promise.all([...ids].map((id) => getPlayerCard(id).then((card) => [id, card] as const))).then((entries) => {
			if (cancelled) return;
			setCards((prev) => {
				const next = new Map(prev);
				for (const [id, card] of entries) if (card) next.set(id, card);
				return next;
			});
		});
		return () => {
			cancelled = true;
		};
	}, [visibleFriends, cards]);

	/** Friends by what they are doing; starred friends lead each group. */
	const sections = useMemo(() => {
		const visible = visibleFriends.filter((friend) => matchesFriendSearch(friend, search));
		const isStarred = (friend: Friend) => watched.has(friend.puuid.toLowerCase());
		const sorted = [...visible].sort((a, b) => Number(isStarred(b)) - Number(isStarred(a)));
		const by: Record<Activity, Friend[]> = { match: [], lobby: [], otherGame: [], online: [], away: [], offline: [] };
		for (const friend of sorted) by[activityOf(friend)].push(friend);
		const offline = [...by.offline].sort(
			(a, b) => Number(isStarred(b)) - Number(isStarred(a)) || (lastOnlineMs(b.lastOnline) ?? 0) - (lastOnlineMs(a.lastOnline) ?? 0),
		);
		return {
			...by,
			offline,
			// Any other Riot game a friend is actually in, keyed off the product id.
			otherGames: Object.entries(
				by.otherGame.reduce<Record<string, Friend[]>>((acc, friend) => {
					(acc[friend.product] ??= []).push(friend);
					return acc;
				}, {}),
			),
		};
	}, [visibleFriends, search, watched]);

	const incoming = requests.filter(
		(request) => request.direction === "incoming" && matchesFriendRequestSearch(request, search),
	);
	const outgoing = requests.filter(
		(request) => request.direction === "outgoing" && matchesFriendRequestSearch(request, search),
	);

	/** The line under a friend's name: what they are doing right now. */
	const detailOf = (friend: Friend, activity: Activity): ReactNode => {
		const v = friend.valorant;
		const parts: ReactNode[] = [];
		if (activity === "match" && v) {
			if (v.sessionLoopState === "PREGAME") parts.push(t("friends.agentSelect"));
			parts.push(queueLabel(v.queueId));
			const map = mapName(v.matchMap, maps);
			if (map) parts.push(map);
			if (v.sessionLoopState === "INGAME" && typeof v.allyScore === "number" && typeof v.enemyScore === "number") {
				const tone =
					v.allyScore > v.enemyScore
						? "text-(--signal-pos)"
						: v.allyScore < v.enemyScore
							? "text-(--signal-neg)"
							: "text-(--text-secondary)";
				parts.push(
					<span key="score" className={`font-semibold tabular-nums ${tone}`}>
						{v.allyScore}–{v.enemyScore}
					</span>,
				);
			}
		} else if (activity === "lobby" && v) {
			parts.push(queueLabel(v.queueId));
			if (friend.state === "away") parts.push(t("friends.away"));
		} else if (activity === "online" || activity === "away") {
			const where = friend.state === "mobile" ? t("friends.mobile") : PRODUCT_LABELS[friend.product];
			if (where) parts.push(where);
		} else if (activity === "offline") {
			const ms = lastOnlineMs(friend.lastOnline);
			if (ms) parts.push(t("friends.lastOnline", { when: relativeTime(ms, i18n.language) }));
		}
		if (parts.length === 0) return null;
		return parts.map((part, index) => (
			<span key={index} className="flex shrink-0 items-center gap-1.5">
				{index > 0 && <span aria-hidden="true" className="text-(--text-faint,var(--text-muted)) opacity-60">·</span>}
				{part}
			</span>
		));
	};

	const friendRow = (friend: Friend, activity: Activity) => {
		const detail = detailOf(friend, activity);
		const isWatched = !!friend.puuid && watched.has(friend.puuid.toLowerCase());
		const watchLabel = isWatched ? t("friends.unwatch") : t("friends.watch");
		const canInvite = activity !== "offline" && activity !== "match";
		const canJoin = activity === "lobby" && hasRoom(friend);

		return (
			// Right click (or the context-menu key) offers every action by name.
			<ContextMenu key={friend.puuid || friend.displayName}>
			<ContextMenuTrigger asChild>
			<div
				className="group flex items-center gap-1 rounded-[8px] transition-colors duration-150 hover:bg-(--surface-hover) focus-within:bg-(--surface-hover) data-[state=open]:bg-(--surface-hover) motion-reduce:transition-none"
			>
				<button
					type="button"
					onClick={() => openFriend(friend)}
					className="flex min-w-0 flex-1 items-center gap-3 rounded-[8px] px-2.5 py-2 text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
				>
					<Avatar friend={friend} cardId={cardFor(friend)} cards={cards} tiers={tiers} dim={activity === "offline"} />
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className={`min-w-0 truncate text-[13px] font-semibold ${activity === "offline" ? "text-(--text-secondary)" : "text-(--text-primary)"}`}>
							<FriendIdentity person={friend} showNote />
						</span>
						{detail && (
							<span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-(--text-muted)">{detail}</span>
						)}
					</span>
				</button>
				{friend.puuid && (
					<span className="flex shrink-0 items-center gap-0.5 pr-1.5">
						{canJoin && (
							<RowAction
								label={t("friends.join")}
								disabled={busy !== null}
								onClick={() => partyAction(friend, "join")}
							>
								<LuLogIn aria-hidden="true" />
							</RowAction>
						)}
						{canInvite && (
							<RowAction
								label={t("friends.invite")}
								disabled={busy !== null}
								onClick={() => partyAction(friend, "invite")}
							>
								<LuUserPlus aria-hidden="true" />
							</RowAction>
						)}
						<RowAction label={t("friends.whisper")} onClick={() => whisper(friend)}>
							<LuMessageSquare aria-hidden="true" />
						</RowAction>
						<RowAction
							label={watchLabel}
							pressed={isWatched}
							visible={isWatched}
							tone={isWatched ? "warn" : "default"}
							onClick={() => toggleWatch(friend)}
						>
							<LuStar className={isWatched ? "fill-current" : ""} aria-hidden="true" />
						</RowAction>
					</span>
				)}
			</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuLabel>{friend.tagLine ? `${friend.gameName}#${friend.tagLine}` : friend.gameName}</ContextMenuLabel>
				<ContextMenuItem onSelect={() => openFriend(friend)}>
					<LuIdCard aria-hidden="true" />
					{t("friends.viewProfile")}
				</ContextMenuItem>
				{friend.puuid && (
					<ContextMenuItem onSelect={() => whisper(friend)}>
						<LuMessageSquare aria-hidden="true" />
						{t("friends.whisper")}
					</ContextMenuItem>
				)}
				{canInvite && (
					<ContextMenuItem disabled={busy !== null} onSelect={() => partyAction(friend, "invite")}>
						<LuUserPlus aria-hidden="true" />
						{t("friends.invite")}
					</ContextMenuItem>
				)}
				{canJoin && (
					<ContextMenuItem disabled={busy !== null} onSelect={() => partyAction(friend, "join")}>
						<LuLogIn aria-hidden="true" />
						{t("friends.join")}
					</ContextMenuItem>
				)}
				<ContextMenuSeparator />
				{friend.puuid && (
					<ContextMenuItem onSelect={() => toggleWatch(friend)}>
						<LuStar className={isWatched ? "fill-current text-(--signal-warn)" : ""} aria-hidden="true" />
						{isWatched ? t("friends.unwatchShort") : t("friends.watchShort")}
					</ContextMenuItem>
				)}
				<ContextMenuItem onSelect={() => copyRiotId(friend)}>
					<LuCopy aria-hidden="true" />
					{t("friends.copyRiotId")}
				</ContextMenuItem>
			</ContextMenuContent>
			</ContextMenu>
		);
	};

	/**
	 * Friends in one VALORANT party sit together under the party's size, with
	 * "+N Others" for members who aren't on your list.
	 */
	const withParties = (list: Friend[], activity: Activity) => {
		const byParty = new Map<string, Friend[]>();
		const rows: ReactNode[] = [];
		for (const friend of list) {
			const partyId = friend.valorant?.partyId ?? "";
			if (!partyId || (friend.valorant?.partySize ?? 1) <= 1) {
				rows.push(friendRow(friend, activity));
				continue;
			}
			if (!byParty.has(partyId)) {
				byParty.set(partyId, []);
				rows.push(partyId);
			}
			byParty.get(partyId)!.push(friend);
		}
		return rows.map((row) => {
			if (typeof row !== "string") return row;
			const members = byParty.get(row)!;
			const size = members[0].valorant?.partySize ?? members.length;
			const max = members[0].valorant?.maxPartySize ?? 5;
			const others = Math.max(0, size - members.length);
			return (
				<div key={`party-${row}`} className="my-1 rounded-[10px] border border-(--line) py-1">
					<p className="flex items-center gap-1.5 px-3 pb-0.5 pt-1 text-[11px] text-(--text-muted)">
						<LuUsers aria-hidden="true" className="size-3" />
						<span className="tabular-nums">{t("friends.partySize", { size, max })}</span>
					</p>
					{members.map((member) => friendRow(member, activity))}
					{others > 0 && <p className="px-3 pb-1 text-[11px] text-(--text-muted)">{t("friends.others", { count: others })}</p>}
				</div>
			);
		});
	};

	const requestRow = (request: FriendRequest, label: string) => (
		<div key={request.puuid || request.displayName} className="flex items-center gap-3 rounded-[8px] px-2.5 py-2">
			<span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-(--signal-warn)" />
			<p className="min-w-0 flex-1 text-[13px]">
				<FriendIdentity person={request} showNote={false} />
			</p>
			<span className="shrink-0 text-[11px] text-(--text-muted)">{label}</span>
		</div>
	);

	const total = visibleFriends.length;
	const onlineCount = visibleFriends.filter((friend) => friend.isOnline).length;
	const listed =
		sections.match.length +
		sections.lobby.length +
		sections.otherGame.length +
		sections.online.length +
		sections.away.length +
		sections.offline.length;
	const nothingToShow = listed === 0 && incoming.length === 0 && outgoing.length === 0;

	if (selectedFriend) {
		const profileFriend = visibleFriends.find((friend) => friend.puuid === selectedFriend.puuid) ?? selectedFriend;
		const cardId = cardFor(profileFriend)?.toLowerCase();
		return (
			<FriendProfile
				friend={profileFriend}
				card={cardId ? cards.get(cardId) : null}
				tiers={tiers}
				presenceLabel={presenceOf(profileFriend, t).label}
				cachedProfile={profileCache[profileFriend.puuid.toLowerCase()]}
				onProfileLoaded={cacheProfile}
				onBack={closeProfile}
			/>
		);
	}

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<LuUsers className="text-lg" />}
				title={t("nav.friends")}
				subtitle={t("friends.onlineOfTotal", { online: onlineCount, count: total })}
			>
				<label className="flex h-8 w-56 min-w-0 items-center gap-2 rounded-[8px] border border-(--border) bg-(--control) px-2.5 focus-within:border-(--accent) focus-within:shadow-[0_0_0_2px_var(--accent-soft)]">
					<FaMagnifyingGlass className="shrink-0 text-[11px] text-(--text-muted)" />
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("friends.search")}
						aria-label={t("friends.search")}
						className="min-w-0 flex-1 bg-transparent text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-muted)"
					/>
				</label>
				<span className="flex shrink-0 items-center gap-1.5 rounded-full border border-(--border) px-2.5 py-1 text-[11px]">
					<span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-(--signal-pos) motion-safe:animate-pulse" : "bg-(--text-muted)"}`} />
					<span className={live ? "text-(--text-secondary)" : "text-(--text-muted)"}>{t("friends.live")}</span>
				</span>
			</PageHeader>

			<div ref={listScrollRef} className={pageBodyClass}>
				{loading && <div className="flex-1 flex items-center justify-center text-[13px] text-(--text-muted)">{t("friends.loading")}</div>}

				{!loading && loginRequired && (
					<LoginRequiredPanel
						icon={<LuUsers />}
						title={t("friends.loginRequired")}
						description={t("friends.loginRequiredDesc")}
					/>
				)}

				{!loading && error && !loginRequired && (
					<div role="alert" className="rounded-[10px] border border-(--signal-neg)/30 px-4 py-3 text-[13px] text-(--signal-neg)">
						{error}
					</div>
				)}

				{!loading && !loginRequired && nothingToShow && (
					<div className="flex-1 flex flex-col items-center justify-center gap-2 text-(--text-muted)">
						<LuUsers className="text-4xl opacity-30" />
						<p className="text-[13px]">{search ? t("friends.noMatches") : t("friends.noFriends")}</p>
					</div>
				)}

				{sections.match.length > 0 && (
					<SectionCard title={t("friends.sectionMatch")} count={sections.match.length} accent="#ff4655">
						{withParties(sections.match, "match")}
					</SectionCard>
				)}

				{sections.lobby.length > 0 && (
					<SectionCard title={t("friends.sectionLobby")} count={sections.lobby.length} accent="#8064e9">
						{withParties(sections.lobby, "lobby")}
					</SectionCard>
				)}

				{sections.otherGames.map(([product, players]) => (
					<SectionCard key={product} title={PRODUCT_LABELS[product] ?? product} count={players.length} accent="#c8aa6e">
						{players.map((friend) => friendRow(friend, "otherGame"))}
					</SectionCard>
				))}

				{incoming.length > 0 && (
					<SectionCard title={t("friends.pendingIncoming")} count={incoming.length} accent="#e8a33d">
						{incoming.map((request) => requestRow(request, t("friends.received")))}
					</SectionCard>
				)}

				{outgoing.length > 0 && (
					<SectionCard title={t("friends.pendingOutgoing")} count={outgoing.length} accent="#e8a33d">
						{outgoing.map((request) => requestRow(request, t("friends.sent")))}
					</SectionCard>
				)}

				{sections.online.length > 0 && (
					<SectionCard title={t("friends.onlineElsewhere")} count={sections.online.length} accent="#22c55e">
						{sections.online.map((friend) => friendRow(friend, "online"))}
					</SectionCard>
				)}

				{sections.away.length > 0 && (
					<SectionCard title={t("friends.away")} count={sections.away.length} accent="#e8a33d">
						{sections.away.map((friend) => friendRow(friend, "away"))}
					</SectionCard>
				)}

				{sections.offline.length > 0 && (
					<SectionCard
						// Collapsed by default; opened while searching so results show.
						key={search ? "offline-search" : "offline"}
						title={t("friends.offlineSection")}
						count={sections.offline.length}
						accent="#6b7280"
						collapsible
						defaultOpen={search.trim().length > 0}
					>
						{sections.offline.map((friend) => friendRow(friend, "offline"))}
					</SectionCard>
				)}
			</div>
		</div>
	);
};

export default Friends;
