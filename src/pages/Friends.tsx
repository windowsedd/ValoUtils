import type { Friend, FriendRequest, FriendsResponse } from "@/types/friends";
import { getMaps, getPlayerCard, getTiers, type CardAsset, type MapAsset, type TierAsset } from "@/util/valorant-assets";
import { tierName } from "@/util/valorant-ranks";
import { mapName } from "@/util/valorant-maps";
import { queueLabel } from "@/util/valorant-queues";
import { useEffect, useMemo, useState } from "react";
import { SectionCard } from "@/components/section-card";
import { useTranslation } from "react-i18next";
import { FaMagnifyingGlass, FaUserGroup } from "react-icons/fa6";

const POLL_MS = 10000;


/** Riot product ids -> the game names shown as section headings. */
const PRODUCT_LABELS: Record<string, string> = {
	league_of_legends: "League of Legends",
	valorant: "VALORANT",
	bacon: "Legends of Runeterra",
	wildrift: "Wild Rift",
};

type Presence = { key: string; label: string; className: string };

/**
 * What to show on the right of a row. `state` comes from the chat presence
 * ("dnd" is what VALORANT sets while in a match) and `sessionLoopState` from
 * the decoded VALORANT blob, which is the more specific of the two.
 */
const presenceOf = (friend: Friend, t: (k: string) => string): Presence => {
	if (!friend.isOnline) return { key: "offline", label: t("friends.offline"), className: "text-gray-600" };

	// Being in a match is more informative than "away", so it wins — a player
	// can be flagged idle by the client while a game is still running.
	const loop = friend.valorant?.sessionLoopState;
	if (loop === "INGAME") return { key: "inMatch", label: t("friends.inMatch"), className: "text-gray-400" };
	if (friend.state === "away") return { key: "away", label: t("friends.away"), className: "text-yellow-500/80" };
	if (loop === "PREGAME") return { key: "agentSelect", label: t("friends.agentSelect"), className: "text-gray-400" };
	if (loop === "MENUS") return { key: "inLobby", label: t("friends.inLobby"), className: "text-gray-400" };
	return { key: "online", label: t("friends.online"), className: "text-green-500/80" };
};

/** Splits "Name#1234" so the tag can be dimmed. */
const NameWithTag = ({ friend }: { friend: { gameName: string; tagLine: string; displayName: string } }) => {
	if (!friend.gameName) return <span className="text-gray-300">{friend.displayName}</span>;
	return (
		<>
			<span className="text-white">{friend.gameName}</span>
			{friend.tagLine && <span className="text-gray-600">#{friend.tagLine}</span>}
		</>
	);
};

/** Player card with the competitive tier badge tucked into the corner. */
const Avatar = ({ friend, cards, tiers }: { friend: Friend; cards: Map<string, CardAsset>; tiers: Map<number, TierAsset> }) => {
	const cardId = friend.valorant?.playerCardId;
	const icon = cardId ? cards.get(cardId.toLowerCase())?.icon : undefined;
	const tier = friend.valorant?.competitiveTier ?? 0;
	const tierIcon = tier > 0 ? tiers.get(tier)?.icon : undefined;

	return (
		<div className="relative w-10 h-10 shrink-0">
			{icon ? (
				<img src={icon} alt="" className="w-10 h-10 rounded-md object-cover" />
			) : (
				<div className="w-10 h-10 rounded-md bg-white/5 flex items-center justify-center text-xs font-bold text-gray-600">
					{friend.gameName.slice(0, 2).toUpperCase() || "?"}
				</div>
			)}
			{tierIcon && (
				<img
					src={tierIcon}
					alt={tierName(tier)}
					title={tierName(tier)}
					className="absolute -bottom-1 -right-1 w-4 h-4 object-contain drop-shadow"
				/>
			)}
		</div>
	);
};

const Friends = () => {
	const { t } = useTranslation();
	const [friends, setFriends] = useState<Friend[]>([]);
	const [requests, setRequests] = useState<FriendRequest[]>([]);
	const [cards, setCards] = useState<Map<string, CardAsset>>(new Map());
	const [tiers, setTiers] = useState<Map<number, TierAsset>>(new Map());
	const [maps, setMaps] = useState<Map<string, MapAsset>>(new Map());
	const [search, setSearch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const [live, setLive] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getTiers().then((m) => !cancelled && setTiers(m));
		getMaps().then((m) => !cancelled && setMaps(m));
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("friends:get", (message: string) => {
			const res = JSON.parse(message) as FriendsResponse;
			setLoading(false);
			if (!res.success) {
				setLive(false);
				setLoginRequired(res.code === "loginRequired");
				setError(res.error ?? t("friends.failedToLoad"));
				return;
			}
			setLive(true);
			setLoginRequired(false);
			setError(null);
			setFriends(res.friends);
			setRequests(res.requests);
		});
		const refresh = () => window.Main.send("friends:get");
		refresh();
		const interval = setInterval(refresh, POLL_MS);
		return () => {
			clearInterval(interval);
			window.Main.removeAllListeners("friends:get");
		};
	}, []);

	// Player cards are per-friend lookups, so resolve only the ids we haven't
	// seen yet — the poll re-runs this effect every 10s.
	useEffect(() => {
		const ids = new Set(
			friends
				.map((f) => f.valorant?.playerCardId?.toLowerCase())
				.filter((id): id is string => Boolean(id) && !cards.has(id!))
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
	}, [friends, cards]);

	const matches = (name: string) => name.toLowerCase().includes(search.trim().toLowerCase());

	const groups = useMemo(() => {
		const visible = friends.filter((f) => matches(f.displayName));
		const playing = visible.filter((f) => f.isOnline && f.playing);
		return {
			valorant: playing.filter((f) => f.product === "valorant"),
			// Any other Riot game a friend is actually in — League today, but
			// keyed off the product string so a new title needs no code change.
			otherGames: Object.entries(
				playing
					.filter((f) => f.product !== "valorant")
					.reduce<Record<string, Friend[]>>((acc, f) => {
						(acc[f.product] ??= []).push(f);
						return acc;
					}, {})
			),
			online: visible.filter((f) => f.isOnline && !f.playing),
			offline: visible.filter((f) => !f.isOnline),
		};
	}, [friends, search]);

	/**
	 * Riot renders a party as one card. `partySize` counts everyone in it, but
	 * only some of them are on your roster — the rest collapse into "+N Others".
	 */
	const valorantParties = useMemo(() => {
		const byParty = new Map<string, Friend[]>();
		const solo: Friend[] = [];
		for (const friend of groups.valorant) {
			const partyId = friend.valorant?.partyId ?? "";
			const size = friend.valorant?.partySize ?? 1;
			if (!partyId || size <= 1) {
				solo.push(friend);
				continue;
			}
			(byParty.get(partyId) ?? byParty.set(partyId, []).get(partyId)!).push(friend);
		}
		return {
			solo,
			parties: [...byParty.entries()].map(([id, members]) => ({
				id,
				members,
				size: members[0].valorant?.partySize ?? members.length,
				maxSize: members[0].valorant?.maxPartySize ?? 5,
				others: Math.max(0, (members[0].valorant?.partySize ?? members.length) - members.length),
			})),
		};
	}, [groups.valorant]);

	const incoming = requests.filter((r) => r.direction === "incoming" && matches(r.displayName));
	const outgoing = requests.filter((r) => r.direction === "outgoing" && matches(r.displayName));

	const friendRow = (friend: Friend, inParty = false) => {
		const presence = presenceOf(friend, t);
		const v = friend.valorant;
		const map = mapName(v?.matchMap, maps);
		const inMatch = v?.sessionLoopState === "INGAME";
		const hasScore = inMatch && typeof v?.allyScore === "number" && typeof v?.enemyScore === "number";
		const winning = hasScore && v!.allyScore! > v!.enemyScore!;
		const losing = hasScore && v!.allyScore! < v!.enemyScore!;

		return (
			<div
				key={friend.puuid || friend.displayName}
				className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${inParty ? "hover:bg-white/4" : "bg-white/2 hover:bg-white/6"}`}
			>
				<Avatar friend={friend} cards={cards} tiers={tiers} />
				<div className="min-w-0 flex-1">
					<p className="text-sm font-semibold truncate">
						<NameWithTag friend={friend} />
					</p>
					{v && (
						<p className="text-xs text-gray-500 truncate flex items-center gap-1.5">
							<span>{queueLabel(v.queueId)}</span>
							{map && (
								<>
									<span className="text-gray-700">·</span>
									<span>{map}</span>
								</>
							)}
							{hasScore && (
								<>
									<span className="text-gray-700">·</span>
									<span
										className={`font-semibold tabular-nums ${winning ? "text-green-400/90" : losing ? "text-red-400/90" : "text-gray-400"}`}
									>
										{v.allyScore} - {v.enemyScore}
									</span>
								</>
							)}
						</p>
					)}
				</div>
				<span className={`text-xs shrink-0 ${presence.className}`}>{presence.label}</span>
			</div>
		);
	};

	/** Riot-style party card: the friends you know, then "+N Others". */
	const partyCard = (party: (typeof valorantParties.parties)[number]) => (
		<div key={party.id} className="rounded-xl bg-white/2 px-2 py-2">
			<div className="flex items-center gap-2 px-2 pb-1.5 text-xs text-gray-500">
				<FaUserGroup className="text-[10px]" />
				<span>{t("friends.partySize", { size: party.size, max: party.maxSize })}</span>
			</div>
			{party.members.map((m) => friendRow(m, true))}
			{party.others > 0 && (
				<p className="px-3 pt-1 pb-0.5 text-xs text-gray-600">{t("friends.others", { count: party.others })}</p>
			)}
		</div>
	);

	const simpleRow = (person: Friend | FriendRequest, label: string) => (
		<div
			key={person.puuid || person.displayName}
			className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/4 transition-colors"
		>
			<span className="w-1.5 h-1.5 rounded-full bg-gray-700 shrink-0" />
			<p className="min-w-0 flex-1 text-sm truncate">
				<NameWithTag friend={person} />
			</p>
			<span className="text-xs text-gray-600 shrink-0">{label}</span>
		</div>
	);

	const total = friends.length;
	const nothingToShow =
		groups.valorant.length === 0 &&
		groups.otherGames.length === 0 &&
		groups.online.length === 0 &&
		groups.offline.length === 0 &&
		incoming.length === 0 &&
		outgoing.length === 0;

	return (
		<div className="h-full flex flex-col animate-fade-in">
			{/* Header */}
			<div className="shrink-0 px-6 pt-5 pb-3 flex items-center justify-between gap-4">
				<span className="text-sm text-gray-500 shrink-0">{t("friends.count", { count: total })}</span>
				<div className="glass rounded-lg h-8 flex items-center gap-2 px-3 min-w-0 flex-1 max-w-xs">
					<FaMagnifyingGlass className="text-gray-600 text-xs shrink-0" />
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("friends.search")}
						className="min-w-0 flex-1 bg-transparent text-sm outline-none text-gray-200 placeholder:text-gray-600"
					/>
				</div>
				<span className="flex items-center gap-1.5 text-xs shrink-0">
					<span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-green-400 animate-pulse" : "bg-gray-700"}`} />
					<span className={live ? "text-gray-400" : "text-gray-600"}>{t("friends.live")}</span>
				</span>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 flex flex-col gap-4">
				{loading && <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">{t("friends.loading")}</div>}

				{!loading && loginRequired && (
					<div className="flex-1 flex items-center justify-center">
						<div className="glass p-6 text-center max-w-md flex flex-col items-center gap-2">
							<FaUserGroup className="text-3xl text-gray-700 mb-1" />
							<p className="text-white font-semibold">{t("friends.loginRequired")}</p>
							<p className="text-gray-500 text-sm">{t("friends.loginRequiredDesc")}</p>
						</div>
					</div>
				)}

				{!loading && error && !loginRequired && (
					<div className="glass px-4 py-3 text-sm text-red-300 border-red-500/20">{error}</div>
				)}

				{!loading && !loginRequired && nothingToShow && (
					<div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-500">
						<FaUserGroup className="text-4xl opacity-30" />
						<p className="text-sm">{search ? t("friends.noMatches") : t("friends.noFriends")}</p>
					</div>
				)}

				{groups.valorant.length > 0 && (
					<SectionCard title={t("friends.playingValorant")} count={groups.valorant.length} accent="#ff4655">
						{valorantParties.solo.map((f) => friendRow(f))}
						{valorantParties.parties.map(partyCard)}
					</SectionCard>
				)}

				{groups.otherGames.map(([product, players]) => (
					<SectionCard key={product} title={PRODUCT_LABELS[product] ?? product} count={players.length} accent="#c8aa6e">
						{players.map((f) => friendRow(f))}
					</SectionCard>
				))}

				{incoming.length > 0 && (
					<SectionCard title={t("friends.pendingIncoming")} count={incoming.length} accent="#f59e0b">
						{incoming.map((r) => simpleRow(r, t("friends.offline")))}
					</SectionCard>
				)}

				{outgoing.length > 0 && (
					<SectionCard title={t("friends.pendingOutgoing")} count={outgoing.length} accent="#f59e0b">
						{outgoing.map((r) => simpleRow(r, t("friends.sent")))}
					</SectionCard>
				)}

				{groups.online.length > 0 && (
					<SectionCard title={t("friends.onlineElsewhere")} count={groups.online.length} accent="#22d3ee">
						{groups.online.map((f) => friendRow(f))}
					</SectionCard>
				)}

				{groups.offline.length > 0 && (
					<SectionCard title={t("friends.offlineSection")} count={groups.offline.length} accent="#6b7280">
						{groups.offline.map((f) => simpleRow(f, t("friends.offline")))}
					</SectionCard>
				)}
			</div>
		</div>
	);
};

export default Friends;
