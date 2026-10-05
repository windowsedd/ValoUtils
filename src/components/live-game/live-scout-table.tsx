import { RankShieldBadge } from "@/components/rank-shield-badge";
import type { LiveGameResponse, LivePlayer, RecentStatsState, WeaponSkin } from "@/types/live-game";
import { localize, weaponSkinKey } from "@/util/valorant-assets";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { queueLabel } from "@/util/valorant-queues";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useEffect, useMemo, useState } from "react";
import { FaArrowRotateRight, FaChevronDown } from "react-icons/fa6";
import { LuCrosshair } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { partyColor, rowAccentColor } from "./party-accent";
import { initialSeasonId } from "./act-rank";
import { ActRankPanel } from "./act-rank-panel";
import { buildTeamMatchup } from "./live-game-metrics";
import { livePlayerStatsKey } from "./live-game-events";
import { groupPlayersByParty, orderTeamsSelfFirst, selfTeamId } from "./live-party-order";
import { LivePlayerHistory } from "./live-player-history";
import { LiveTeamMatchup } from "./live-team-matchup";
import { PreviousActsPanel } from "./previous-acts-panel";
import type { LiveGameAssets } from "./use-live-game-assets";

type Snapshot = Extract<LiveGameResponse, { success: true }>;

type Props = {
	snapshot: Snapshot;
	assets: LiveGameAssets;
	recent: Record<string, RecentStatsState>;
	refreshing: boolean;
	refreshError?: string;
	onRefresh: () => void;
};


/** Roster columns follow the table's own width, not the window's: the Events
 *  sidebar and page inset make the table far narrower than the viewport, and the
 *  fixed tracks then pushed the chevron past the right edge. Breakpoints are the
 *  minimum each template needs (tracks + gaps + padding + 3px party accent). */
const ROSTER_COLUMNS = "grid-cols-[minmax(150px,1.5fr)_88px_44px_52px_56px_34px] @min-[51rem]:grid-cols-[minmax(180px,300px)_110px_44px_140px_52px_56px_52px_52px_minmax(34px,1fr)] @min-[63rem]:grid-cols-[minmax(180px,300px)_76px_110px_44px_140px_52px_56px_52px_52px_100px_minmax(34px,1fr)]";

const statsErrorText = (error: string, t: ReturnType<typeof useTranslation>["t"]) =>
	error === "rateLimited"
		? t("liveGame.rateLimited")
		: error === "unavailable" ? t("liveGame.failedToLoad") : error;

const teamMeta = (teamId: string, t: ReturnType<typeof useTranslation>["t"]) => {
	switch (teamId) {
		case "Blue": return { label: t("liveGame.teamBlue"), color: "#60a5fa" };
		case "Red": return { label: t("liveGame.teamRed"), color: "#f87171" };
		case "Ally": return { label: t("liveGame.teamAlly"), color: "#4ade80" };
		case "Enemy": return { label: t("liveGame.teamEnemy"), color: "#f87171" };
		default: return { label: t("liveGame.players"), color: "#22d3ee" };
	}
};

/** RR reads as its own column — mixing it into the rank cell made "Gold 2 · 66"
 *  hard to scan and impossible to compare down the row. */
const RrValue = ({ tier, rr, stats }: { tier: number; rr?: number; stats?: RecentStatsState }) => {
	const { t } = useTranslation();
	if (tier <= 0 || typeof rr !== "number") {
		return <span aria-label={t("liveGame.unavailable")} className="text-xs text-gray-700">—</span>;
	}
	return (
		<span className="flex items-center gap-1.5">
			<span className="text-xs tabular-nums text-gray-300">{rr}</span>
			{stats && stats.status !== "loading" && (
				<RankShieldBadge
					tier={tier}
					remaining={stats?.status === "ready" ? stats.stats.rankShields : null}
					inline
				/>
			)}
		</span>
	);
};

const RankValue = ({ tier, act, assets }: { tier: number; act?: string; assets: LiveGameAssets }) => {
	const { t } = useTranslation();
	const icon = assets.tiers.get(tier)?.icon;
	return (
		<div className="min-w-0 flex items-center gap-1.5">
			{icon && <img src={icon} alt="" className="w-5 h-5 object-contain shrink-0" />}
			<div className="min-w-0 flex items-baseline text-xs">
				<span className="truncate font-semibold" style={{ color: tier > 0 ? tierColor(tier) : "#6b7280" }}>
					{tier > 0 ? tierName(tier) : <span aria-label={t("liveGame.unavailable")}>—</span>}
				</span>
				{tier > 0 && act && <span className="shrink-0 text-gray-500 font-normal"> · {act}</span>}
			</div>
		</div>
	);
};

const formatStreakRr = (rr: number) => (rr === 0 ? "" : ` · ${rr > 0 ? "+" : ""}${rr}`);

const StreakBadge = ({ state }: { state?: RecentStatsState }) => {
	const { t } = useTranslation();
	if (!state || state.status === "loading") return <span className="inline-block h-3 w-8 rounded bg-white/8 animate-pulse motion-reduce:animate-none" />;
	if (state.status === "error") return null;
	const streak = state.stats.streak;
	if (!streak?.kind || streak.matches < 1) return null;
	const label = t(streak.kind === "win" ? "liveGame.winStreak" : "liveGame.loseStreak", { count: streak.matches });
	return (
		<span
			className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
				streak.kind === "win" ? "bg-emerald-400/10 text-emerald-300" : "bg-red-400/10 text-red-300"
			}`}
			title={t(streak.kind === "win" ? "liveGame.winStreakHint" : "liveGame.loseStreakHint", { count: streak.matches, rr: streak.rr })}
		>
			{label}{formatStreakRr(streak.rr)}
		</span>
	);
};

const StatValue = ({ state, field }: { state?: RecentStatsState; field: "kd" | "winRate" | "acs" | "dpr" }) => {
	const { t } = useTranslation();
	if (!state || state.status === "loading") return <span className="inline-block h-3 w-9 rounded bg-white/8 animate-pulse motion-reduce:animate-none" />;
	if (state.status === "error") return <span className="text-[10px] text-gray-600">{t("liveGame.unavailable")}</span>;
	const value = state.stats[field] ?? 0;
	return <span className="text-xs font-semibold tabular-nums text-gray-200">{field === "winRate" ? `${value.toFixed(0)}%` : field === "kd" ? value.toFixed(2) : value.toFixed(0)}</span>;
};

const SkinCard = ({ weapon, label, assets }: { weapon: WeaponSkin; label: string; assets: LiveGameAssets }) => {
	const { t } = useTranslation();
	const key = weaponSkinKey(weapon);
	const skin = key ? assets.skins.get(key) : null;
	const name = skin ? localize(skin.name) : weapon?.skinId ? label : t("liveGame.unavailable");
	return (
		<div className="min-w-0 rounded-[10px] border border-(--line) bg-(--surface) px-2 py-1.5">
			<div className="h-7 flex items-center justify-center">
				{skin?.icon ? <img src={skin.icon} alt={name} className="max-h-7 w-full object-contain" /> : <LuCrosshair aria-hidden="true" className="text-(--text-muted)" />}
			</div>
			<p className="mt-1 text-[10px] uppercase tracking-wider text-gray-600">{label}</p>
			<p className="text-xs text-gray-300 truncate" title={name}>{name}</p>
		</div>
	);
};

const PlayerRow = ({ player, assets, stats, expanded, onToggle, teamLabel, recentMode, inMatch, agentFallback }: {
	player: LivePlayer;
	assets: LiveGameAssets;
	stats?: RecentStatsState;
	expanded: boolean;
	onToggle: () => void;
	teamLabel: string;
	recentMode: string;
	inMatch: boolean;
	agentFallback: string;
}) => {
	const { t } = useTranslation();
	const agent = player.characterId ? assets.agents.get(player.characterId.toLowerCase()) : undefined;
	const card = player.cardId ? assets.cards.get(player.cardId.toLowerCase()) : undefined;
	const agentName = agent ? localize(agent.name) : agentFallback;
	// "Hide My Name" hides you from opponents, not from your own party — in game
	// your premades still see you, and you obviously know your own name. Riot's
	// name service returns these names regardless of the flag, so masking them
	// here only hid them from the person already allowed to see them.
	const nameHidden = player.incognito && !player.inMyParty;
	const displayName = nameHidden || !player.gameName ? t("liveGame.hidden") : `${player.gameName}#${player.tagLine}`;
	const partyLabel = player.party ? t("liveGame.partyDetected", { party: player.party }) : null;
	const peakAct = player.peakSeasonId ? assets.seasons.get(player.peakSeasonId.toLowerCase())?.label : null;
	const detailsId = `live-player-${player.puuid.replace(/[^a-z0-9]/gi, "-")}`;
	const seasonStarts = useMemo(
		() => new Map([...assets.seasons].map(([id, season]) => [id, season.startMillis])),
		[assets.seasons],
	);
	const defaultSeasonId = useMemo(
		() => initialSeasonId(player.competitiveSeasons, player.currentSeasonId, seasonStarts),
		[player.competitiveSeasons, player.currentSeasonId, seasonStarts],
	);
	const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(defaultSeasonId);
	useEffect(() => {
		if (
			!selectedSeasonId ||
			!player.competitiveSeasons.some((season) => season.seasonId === selectedSeasonId)
		) {
			setSelectedSeasonId(defaultSeasonId);
		}
	}, [defaultSeasonId, player.competitiveSeasons, selectedSeasonId]);
	return (
		<div className="border-b border-(--line) last:border-0" style={{ borderLeft: `3px solid ${rowAccentColor(player.party)}` }}>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				aria-controls={detailsId}
				aria-label={`${t(expanded ? "liveGame.collapsePlayer" : "liveGame.expandPlayer", { player: displayName })}, ${teamLabel}${partyLabel ? `, ${partyLabel}` : ""}`}
				className={`w-full min-h-12 grid ${ROSTER_COLUMNS} items-center gap-2 px-3 py-1.5 text-left hover:bg-white/4 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent-soft)] transition-colors motion-reduce:transition-none`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<div className="relative w-8 h-9 rounded-md bg-white/5 overflow-hidden shrink-0">
						{(agent?.icon ?? card?.icon) && <img src={agent?.icon ?? card?.icon} alt={agentName} className="w-full h-full object-cover" />}
						{player.level != null && <span className="absolute inset-x-0 bottom-0 bg-black/70 text-[8px] text-white text-center">{player.level}</span>}
					</div>
					<div className="min-w-0 flex-1">
						<p className="flex items-center gap-1.5 text-xs font-semibold text-white" title={displayName}>
							<span className="truncate">{displayName}</span>
							{player.isSelf && <span className="shrink-0 rounded-[5px] border border-(--accent-border) bg-(--accent-soft) px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-(--accent-selected)">{t("liveGame.me")}</span>}
							<StreakBadge state={stats} />
						</p>
						<p className="text-[10px] text-gray-500 truncate">
							{agentName || t("liveGame.unavailable")}
							{player.party && <span style={{ color: partyColor(player.party) }}> · {partyLabel}</span>}
						</p>
					</div>
				</div>
				<div className="hidden @min-[63rem]:flex items-center min-w-0">
					{player.party && <span className="text-[10px] font-medium truncate" style={{ color: partyColor(player.party) }}>{player.party}</span>}
				</div>
				<RankValue tier={player.currentTier} assets={assets} />
				<RrValue tier={player.currentTier} rr={player.currentRR} stats={stats} />
				<div className="hidden @min-[51rem]:block"><RankValue tier={player.peakTier} act={peakAct ?? undefined} assets={assets} /></div>
				<StatValue state={stats} field="kd" />
				<StatValue state={stats} field="winRate" />
				<div className="hidden @min-[51rem]:block"><StatValue state={stats} field="acs" /></div>
				<div className="hidden @min-[51rem]:block"><StatValue state={stats} field="dpr" /></div>
				<div className="hidden @min-[63rem]:flex items-center gap-1">
					{player.loadout ? [player.loadout.vandal, player.loadout.phantom, player.loadout.knife].map((weapon, index) => {
						const skin = assets.skins.get(weaponSkinKey(weapon) ?? "");
						return skin?.icon ? <img key={index} src={skin.icon} alt="" className="w-7 h-5 object-contain" /> : <span key={index} aria-label={t("liveGame.unavailable")} className="w-5 h-1 rounded bg-white/10" />;
					}) : <span aria-label={t("liveGame.unavailable")} className="text-gray-700">—</span>}
				</div>
				<FaChevronDown className={`justify-self-end text-gray-500 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
			</button>
			{expanded && (
				<div id={detailsId} className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-2.5 border-t border-(--line) bg-(--background)/50 px-3 pt-2.5 pb-3">
					<div className="rounded-[10px] border border-(--line) bg-(--surface) p-2.5">
						<p className="mb-1 text-[10px] text-gray-500">{teamLabel}{partyLabel ? ` · ${partyLabel}` : ""}</p>
						{stats?.status === "ready" && stats.stats.streak?.kind && stats.stats.streak.matches > 0 && (
							<p className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${stats.stats.streak.kind === "win" ? "text-emerald-300" : "text-red-300"}`}>
								{t(stats.stats.streak.kind === "win" ? "liveGame.winStreakHint" : "liveGame.loseStreakHint", { count: stats.stats.streak.matches, rr: stats.stats.streak.rr })}
							</p>
						)}
						<p className="text-[10px] uppercase tracking-widest text-gray-500">{t("liveGame.recentFive", { mode: recentMode })}</p>
						{stats?.status === "ready" ? (
							<><div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1.5">
								<div><p className="text-[10px] text-gray-600">K / D / A</p><p className="text-sm font-semibold tabular-nums">{stats.stats.kills} / {stats.stats.deaths} / {stats.stats.assists}</p></div>
								<div><p className="text-[10px] text-gray-600">{t("liveGame.acs")}</p><p className="text-sm font-semibold tabular-nums">{stats.stats.acs.toFixed(0)}</p></div>
								<div><p className="text-[10px] text-gray-600">{t("liveGame.dpr")}</p><p className="text-sm font-semibold tabular-nums">{(stats.stats.dpr ?? 0).toFixed(0)}</p></div>
								<div><p className="text-[10px] text-gray-600">{t("liveGame.winRate")}</p><p className="text-sm font-semibold tabular-nums">{stats.stats.winRate.toFixed(0)}%</p></div>
							</div><p className="mt-1.5 text-[10px] text-gray-600">{t("liveGame.matchesAnalyzed", { count: stats.stats.matches })}</p></>
						) : stats?.status === "error" ? <p className="mt-3 text-xs text-red-300">{statsErrorText(stats.error, t)}</p> : <div className="mt-3 h-12 rounded bg-white/5 animate-pulse motion-reduce:animate-none" />}
						<div className="mt-1.5 pt-1.5 border-t border-white/5 flex items-center justify-between text-[10px] text-gray-600">
							<span>{t("liveGame.peak")} {peakAct ?? ""}</span><span>{player.peakTier > 0 ? tierName(player.peakTier) : <span aria-label={t("liveGame.unavailable")}>—</span>}</span>
						</div>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
						<SkinCard weapon={player.loadout?.vandal ?? null} label={t("liveGame.vandal")} assets={assets} />
						<SkinCard weapon={player.loadout?.phantom ?? null} label={t("liveGame.phantom")} assets={assets} />
						<SkinCard weapon={player.loadout?.knife ?? null} label={t("liveGame.knife")} assets={assets} />
					</div>
					<div className="lg:col-span-2">
						<ActRankPanel
							competitiveSeasons={player.competitiveSeasons}
							assets={assets}
							selectedSeasonId={selectedSeasonId}
							onSeasonChange={setSelectedSeasonId}
						/>
					</div>
					{inMatch && (
						<div className="lg:col-span-2">
							<PreviousActsPanel
								competitiveSeasons={player.competitiveSeasons}
								currentSeasonId={player.currentSeasonId}
								assets={assets}
							/>
						</div>
					)}
					{stats?.status === "ready" && <div className="lg:col-span-2"><LivePlayerHistory history={stats.stats.history} assets={assets} /></div>}
				</div>
			)}
		</div>
	);
};

export const LiveScoutTable = ({ snapshot, assets, recent, refreshing, refreshError, onRefresh }: Props) => {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [summaryExpanded, setSummaryExpanded] = useState(false);
	const self = useMemo(() => selfTeamId(snapshot.players), [snapshot.players]);
	const teams = useMemo(() => {
		const groups = new Map<string, LivePlayer[]>();
		for (const player of snapshot.players) {
			const key = player.teamId ?? "all";
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(player);
		}
		return orderTeamsSelfFirst([...groups.entries()], ([id]) => id, self);
	}, [snapshot.players, self]);
	const teamSummaries = useMemo(
		() => orderTeamsSelfFirst(snapshot.teams ?? [], (team) => team.id, self),
		[snapshot.teams, self],
	);
	const parties = new Set(snapshot.players.map((player) => player.party).filter(Boolean)).size;
	const matchup = useMemo(() => buildTeamMatchup(snapshot.players, recent), [snapshot.players, recent]);
	const map = mapName(snapshot.match?.mapId, assets.maps);
	const mapArt = mapIcon(snapshot.match?.mapId, assets.maps);
	const recentMode = queueLabel(snapshot.match?.queueId) || t("liveGame.unavailable");
	const inMatch = snapshot.state === "coregame" || snapshot.state === "pregame";
	const isPregame = snapshot.state === "pregame";
	const allyCount = snapshot.players.filter((player) => player.teamId === "Ally").length;
	const enemyCount = snapshot.players.filter((player) => player.teamId === "Enemy").length;
	const agentFallback = isPregame ? t("liveGame.hiddenAgent") : "";
	const summaryId = `live-match-summary-${(snapshot.rosterKey ?? "roster").replace(/[^a-z0-9]/gi, "-")}`;
	const stateLabel = t(`liveGame.state${snapshot.state === "coregame" ? "Coregame" : snapshot.state === "pregame" ? "Pregame" : "Party"}`);
	const queue = queueLabel(snapshot.match?.queueId);
	// Only teams the snapshot actually has; Deathmatch has no enemy team to average.
	const shownTeams = teamSummaries.slice(0, 2);
	return (
		<div className="flex flex-col gap-3.5">
			<section className="overflow-hidden rounded-[12px] border border-(--border) bg-(--surface)" aria-label={t("liveGame.matchContext")}>
				<div className="flex items-center gap-3.5 px-4 py-3">
					<div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-[10px] bg-(--control)">
						{mapArt && <img src={mapArt} alt="" className="h-full w-full object-cover" />}
					</div>
					<div className="min-w-0 flex-1">
						<p className="truncate text-[17px] leading-tight font-semibold text-(--text-primary)">
							{map || <span aria-label={t("liveGame.unavailable")}>—</span>}
						</p>
						<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
							<span className="flex items-center gap-1.5 rounded-full border border-(--accent-border) bg-(--accent-soft) px-2 py-0.5 text-[10px] font-medium text-(--accent-selected)">
								<span className="h-1.5 w-1.5 rounded-full bg-(--accent-selected) animate-pulse motion-reduce:animate-none" aria-hidden="true" />
								{stateLabel}
							</span>
							{queue && <span className="rounded-full border border-(--border) px-2 py-0.5 text-[10px] text-(--text-secondary)">{queue}</span>}
							{isPregame && (
								<span className="rounded-full border border-(--border) px-2 py-0.5 text-[10px] text-(--text-secondary)">
									{t("liveGame.pregameRoster", { ally: allyCount, enemy: enemyCount, total: snapshot.players.length })}
								</span>
							)}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						{matchup && (
							<button
								type="button"
								onClick={() => setSummaryExpanded((current) => !current)}
								aria-expanded={summaryExpanded}
								aria-controls={summaryId}
								aria-label={t(summaryExpanded ? "liveGame.collapseSummary" : "liveGame.expandSummary")}
								className={`flex h-8 items-center gap-1.5 rounded-[8px] border px-2.5 text-[11px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] ${
									summaryExpanded
										? "border-(--accent-border) bg-(--accent-soft) text-(--accent-selected)"
										: "border-(--border) text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
								}`}
							>
								{t("liveGame.matchup")}
								<FaChevronDown className={`h-2.5 w-2.5 transition-transform motion-reduce:transition-none ${summaryExpanded ? "rotate-180" : ""}`} />
							</button>
						)}
						<button
							type="button"
							onClick={onRefresh}
							disabled={refreshing}
							aria-label={t(refreshing ? "liveGame.refreshing" : "liveGame.refresh")}
							title={t(refreshing ? "liveGame.refreshing" : "liveGame.refresh")}
							className="press-tile grid h-8 w-8 place-items-center rounded-[8px] border border-(--border) text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] motion-reduce:transition-none"
						>
							<FaArrowRotateRight className={`h-3 w-3 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />
						</button>
					</div>
				</div>

				<dl className="flex flex-wrap border-t border-(--line)">
					{shownTeams.map((team) => {
						const meta = teamMeta(team.id, t);
						const tier = team.averageTier != null ? Math.round(team.averageTier) : null;
						return (
							<div key={team.id} className="min-w-36 flex-1 border-r border-(--line) px-4 py-2">
								<dt className="flex items-center gap-1.5 text-[10px] text-(--text-muted)">
									<span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} aria-hidden="true" />
									{meta.label} · {t("liveGame.teamAverage")}
								</dt>
								<dd className="mt-0.5 flex items-baseline gap-1.5">
									<span className="text-[13px] font-semibold text-(--text-primary)" style={tier ? { color: tierColor(tier) } : undefined}>
										{tier ? tierName(tier) : <span aria-label={t("liveGame.unavailable")}>—</span>}
									</span>
									<span className="text-[10px] text-(--text-muted)">{t("liveGame.ratedPlayers", { count: team.ratedPlayers ?? 0 })}</span>
								</dd>
							</div>
						);
					})}
					<div className="min-w-28 flex-1 border-r border-(--line) px-4 py-2">
						<dt className="text-[10px] text-(--text-muted)">{t("liveGame.detectedParties")}</dt>
						<dd className="mt-0.5 text-[13px] font-semibold tabular-nums text-(--text-primary)">{parties}</dd>
					</div>
					<div className="min-w-28 flex-1 px-4 py-2">
						<dt className="text-[10px] text-(--text-muted)">{t("liveGame.rosterSize")}</dt>
						<dd className="mt-0.5 text-[13px] font-semibold tabular-nums text-(--text-primary)">{snapshot.players.length}</dd>
					</div>
				</dl>

				{refreshError && (
					<div role="status" className="flex items-center justify-between gap-3 border-t border-(--signal-neg)/20 bg-(--signal-neg)/8 px-4 py-2 text-[11px] text-(--signal-neg)">
						<span className="truncate">{refreshError}</span>
						<button type="button" onClick={onRefresh} className="shrink-0 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--signal-neg)">{t("liveGame.retry")}</button>
					</div>
				)}
				{isPregame && enemyCount === 0 && (
					<div role="status" className="border-t border-(--signal-warn)/20 bg-(--signal-warn)/8 px-4 py-2 text-[11px] text-(--signal-warn)">
						{t("liveGame.enemyRosterUnavailable")}
					</div>
				)}
				{matchup && (
					<div id={summaryId} hidden={!summaryExpanded}>
						<LiveTeamMatchup matchup={matchup} mode={recentMode} />
					</div>
				)}
			</section>

			{/* No scroll box of its own: the page scrolls, and the header sticks to its top. */}
			<section className="@container rounded-[12px] border border-(--border) bg-(--surface)" aria-label={t("liveGame.players")}>
				<div className={`sticky top-0 z-10 grid ${ROSTER_COLUMNS} gap-2 rounded-t-[12px] border-b border-(--line) bg-(--panel-raised) py-2 pr-3 pl-[15px] text-[9px] uppercase tracking-widest text-(--text-muted)`}>
					<span>{t("matches.player")}</span><span className="hidden @min-[63rem]:block">{t("liveGame.detectedParties")}</span><span>{t("liveGame.current")}</span><span>{t("liveGame.rr")}</span><span className="hidden @min-[51rem]:block">{t("liveGame.peak")}</span><span>{t("liveGame.kd")}</span><span>{t("liveGame.winRate")}</span><span className="hidden @min-[51rem]:block">{t("liveGame.acs")}</span><span className="hidden @min-[51rem]:block">{t("liveGame.dpr")}</span><span className="hidden @min-[63rem]:block">{t("liveGame.skins")}</span><span />
				</div>
				{teams.map(([teamId, players]) => {
					const meta = teamMeta(teamId, t);
					return (
						<div key={teamId}>
							<div className="flex items-center gap-2 border-b border-(--line) bg-(--background)/40 px-3 py-2">
								<span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
								<h2 className="text-[10px] font-bold uppercase tracking-widest" style={{ color: meta.color }}>{meta.label}</h2>
								<span className="ml-auto text-[10px] tabular-nums text-(--text-muted)">{players.length}</span>
							</div>
							{groupPlayersByParty(players).map((player) => (
								<PlayerRow
									key={player.puuid}
									player={player}
									assets={assets}
									stats={recent[livePlayerStatsKey(player.puuid)]}
									expanded={expanded === player.puuid}
									onToggle={() => setExpanded((current) => current === player.puuid ? null : player.puuid)}
									teamLabel={meta.label}
									recentMode={recentMode}
									inMatch={inMatch}
									agentFallback={agentFallback}
								/>
							))}
						</div>
					);
				})}
			</section>
		</div>
	);
};
