import type { LiveGameResponse, LivePlayer, RecentStatsState, WeaponSkin } from "@/types/live-game";
import { localize, weaponSkinKey } from "@/util/valorant-assets";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { queueLabel } from "@/util/valorant-queues";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useEffect, useMemo, useState } from "react";
import { FaArrowRotateRight, FaChevronDown, FaCrosshairs } from "react-icons/fa6";
import { useTranslation } from "react-i18next";
import { initialSeasonId } from "./act-rank";
import { ActRankPanel } from "./act-rank-panel";
import { buildTeamMatchup } from "./live-game-metrics";
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

const PARTY_COLORS = ["#22d3ee", "#f59e0b", "#a78bfa", "#34d399", "#fb7185"];
const partyColor = (party: string) => {
	const number = Number.parseInt(party.replace(/\D/g, ""), 10) || 1;
	return PARTY_COLORS[(number - 1) % PARTY_COLORS.length];
};

const teamMeta = (teamId: string, t: ReturnType<typeof useTranslation>["t"]) => {
	switch (teamId) {
		case "Blue": return { label: t("liveGame.teamBlue"), color: "#60a5fa" };
		case "Red": return { label: t("liveGame.teamRed"), color: "#f87171" };
		case "Ally": return { label: t("liveGame.teamAlly"), color: "#4ade80" };
		case "Enemy": return { label: t("liveGame.teamEnemy"), color: "#f87171" };
		default: return { label: t("liveGame.players"), color: "#22d3ee" };
	}
};

const RankValue = ({ tier, rr, act, assets }: { tier: number; rr?: number; act?: string; assets: LiveGameAssets }) => {
	const { t } = useTranslation();
	const icon = assets.tiers.get(tier)?.icon;
	return (
		<div className="min-w-0 flex items-center gap-1.5">
			{icon && <img src={icon} alt="" className="w-5 h-5 object-contain shrink-0" />}
			<div className="min-w-0 flex items-baseline text-xs">
				<span className="truncate font-semibold" style={{ color: tier > 0 ? tierColor(tier) : "#6b7280" }}>
					{tier > 0 ? tierName(tier) : <span aria-label={t("liveGame.unavailable")}>—</span>}
					{tier > 0 && typeof rr === "number" && <span className="text-gray-500 font-normal"> · {rr}</span>}
				</span>
				{tier > 0 && act && <span className="shrink-0 text-gray-500 font-normal"> · {act}</span>}
			</div>
		</div>
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
		<div className="min-w-0 rounded-lg bg-black/20 border border-white/6 px-2 py-1.5">
			<div className="h-7 flex items-center justify-center">
				{skin?.icon ? <img src={skin.icon} alt={name} className="max-h-7 w-full object-contain" /> : <FaCrosshairs aria-hidden="true" className="text-gray-700" />}
			</div>
			<p className="mt-1 text-[10px] uppercase tracking-wider text-gray-600">{label}</p>
			<p className="text-xs text-gray-300 truncate" title={name}>{name}</p>
		</div>
	);
};

const PlayerRow = ({ player, assets, stats, expanded, onToggle, teamColor, teamLabel, recentMode, inMatch }: {
	player: LivePlayer;
	assets: LiveGameAssets;
	stats?: RecentStatsState;
	expanded: boolean;
	onToggle: () => void;
	teamColor: string;
	teamLabel: string;
	recentMode: string;
	inMatch: boolean;
}) => {
	const { t } = useTranslation();
	const agent = player.characterId ? assets.agents.get(player.characterId.toLowerCase()) : undefined;
	const card = player.cardId ? assets.cards.get(player.cardId.toLowerCase()) : undefined;
	const agentName = agent ? localize(agent.name) : "";
	const displayName = player.incognito || !player.gameName ? t("liveGame.hidden") : `${player.gameName}#${player.tagLine}`;
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
		<div className="border-b border-white/5 last:border-0" style={{ borderLeft: `3px solid ${teamColor}` }}>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				aria-controls={detailsId}
				aria-label={`${t(expanded ? "liveGame.collapsePlayer" : "liveGame.expandPlayer", { player: displayName })}, ${teamLabel}`}
				className="w-full min-h-12 grid grid-cols-[minmax(150px,1.5fr)_88px_52px_56px_34px] md:grid-cols-[minmax(180px,300px)_110px_140px_52px_56px_52px_52px_minmax(34px,1fr)] xl:grid-cols-[minmax(180px,300px)_76px_110px_140px_52px_56px_52px_52px_100px_minmax(34px,1fr)] items-center gap-2 px-3 py-1.5 text-left hover:bg-white/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400 transition-colors motion-reduce:transition-none"
			>
				<div className="flex items-center gap-2 min-w-0">
					<div className="relative w-8 h-9 rounded-md bg-white/5 overflow-hidden shrink-0">
						{(agent?.icon ?? card?.icon) && <img src={agent?.icon ?? card?.icon} alt={agentName} className="w-full h-full object-cover" />}
						{player.level != null && <span className="absolute inset-x-0 bottom-0 bg-black/70 text-[8px] text-white text-center">{player.level}</span>}
					</div>
					<div className="min-w-0 flex-1">
						<p className="flex items-center gap-1.5 text-xs font-semibold text-white" title={displayName}>
							<span className="truncate">{displayName}</span>
							{player.isSelf && <span className="shrink-0 rounded border border-cyan-300/30 bg-cyan-300/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-cyan-200">{t("liveGame.me")}</span>}
						</p>
						<p className="text-[10px] text-gray-500 truncate">
							{agentName || t("liveGame.unavailable")}
							{player.party && <span className="xl:hidden"> · {t("liveGame.partyDetected", { party: player.party })}</span>}
						</p>
					</div>
					{player.party && <span className="w-2 h-2 rounded-full shrink-0" title={t("liveGame.partyDetected", { party: player.party })} style={{ background: partyColor(player.party) }} />}
				</div>
				<div className="hidden xl:flex items-center gap-1.5 min-w-0">
					{player.party ? <><span className="w-2 h-2 rounded-full shrink-0" style={{ background: partyColor(player.party) }} /><span className="text-[10px] text-gray-400 truncate">{player.party}</span></> : <span aria-label={t("liveGame.unavailable")} className="text-[10px] text-gray-700">—</span>}
				</div>
				<RankValue tier={player.currentTier} rr={player.currentRR} assets={assets} />
				<div className="hidden md:block"><RankValue tier={player.peakTier} act={peakAct ?? undefined} assets={assets} /></div>
				<StatValue state={stats} field="kd" />
				<StatValue state={stats} field="winRate" />
				<div className="hidden md:block"><StatValue state={stats} field="acs" /></div>
				<div className="hidden md:block"><StatValue state={stats} field="dpr" /></div>
				<div className="hidden xl:flex items-center gap-1">
					{player.loadout ? [player.loadout.vandal, player.loadout.phantom, player.loadout.knife].map((weapon, index) => {
						const skin = assets.skins.get(weaponSkinKey(weapon) ?? "");
						return skin?.icon ? <img key={index} src={skin.icon} alt="" className="w-7 h-5 object-contain" /> : <span key={index} aria-label={t("liveGame.unavailable")} className="w-5 h-1 rounded bg-white/10" />;
					}) : <span aria-label={t("liveGame.unavailable")} className="text-gray-700">—</span>}
				</div>
				<FaChevronDown className={`justify-self-end text-gray-500 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
			</button>
			{expanded && (
				<div id={detailsId} className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-2 px-3 pb-2 pt-2 bg-black/10">
					<div className="rounded-lg border border-white/6 bg-white/2 p-2">
						<p className="mb-1 text-[10px] text-gray-500">{teamLabel}{player.party ? ` · ${t("liveGame.partyDetected", { party: player.party })}` : ""}</p>
						<p className="text-[10px] uppercase tracking-widest text-gray-500">{t("liveGame.recentFive", { mode: recentMode })}</p>
						{stats?.status === "ready" ? (
							<><div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1.5">
								<div><p className="text-[10px] text-gray-600">K / D / A</p><p className="text-sm font-semibold tabular-nums">{stats.stats.kills} / {stats.stats.deaths} / {stats.stats.assists}</p></div>
								<div><p className="text-[10px] text-gray-600">{t("liveGame.acs")}</p><p className="text-sm font-semibold tabular-nums">{stats.stats.acs.toFixed(0)}</p></div>
								<div><p className="text-[10px] text-gray-600">{t("liveGame.dpr")}</p><p className="text-sm font-semibold tabular-nums">{(stats.stats.dpr ?? 0).toFixed(0)}</p></div>
								<div><p className="text-[10px] text-gray-600">{t("liveGame.winRate")}</p><p className="text-sm font-semibold tabular-nums">{stats.stats.winRate.toFixed(0)}%</p></div>
							</div><p className="mt-1.5 text-[10px] text-gray-600">{t("liveGame.matchesAnalyzed", { count: stats.stats.matches })}</p></>
						) : stats?.status === "error" ? <p className="mt-3 text-xs text-red-300">{stats.error}</p> : <div className="mt-3 h-12 rounded bg-white/5 animate-pulse motion-reduce:animate-none" />}
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
	const teams = useMemo(() => {
		const groups = new Map<string, LivePlayer[]>();
		for (const player of snapshot.players) {
			const key = player.teamId ?? "all";
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(player);
		}
		return groups;
	}, [snapshot.players]);
	const parties = new Set(snapshot.players.map((player) => player.party).filter(Boolean)).size;
	const matchup = useMemo(() => buildTeamMatchup(snapshot.players, recent), [snapshot.players, recent]);
	const map = mapName(snapshot.match?.mapId, assets.maps);
	const mapArt = mapIcon(snapshot.match?.mapId, assets.maps);
	const recentMode = queueLabel(snapshot.match?.queueId) || t("liveGame.unavailable");
	const inMatch = snapshot.state === "coregame" || snapshot.state === "pregame";
	const summaryId = `live-match-summary-${snapshot.rosterKey.replace(/[^a-z0-9]/gi, "-")}`;
	return (
		<div className="flex-1 min-h-0 px-6 pb-5 flex flex-col gap-3 overflow-hidden">
			<section className="glass rounded-2xl overflow-hidden shrink-0">
				<div className="relative min-h-16 px-4 py-3 flex items-center gap-3 overflow-hidden">
					{mapArt && <img src={mapArt} alt="" className="absolute inset-0 w-full h-full object-cover opacity-10" />}
					<div className="relative min-w-0"><p className="text-[10px] uppercase tracking-widest text-gray-500">{t("liveGame.matchContext")}</p><p className="text-lg font-bold text-white truncate">{map || <span aria-label={t("liveGame.unavailable")}>—</span>}</p></div>
					<span className="relative px-2 py-1 rounded-full bg-white/6 text-[10px] uppercase tracking-wider text-gray-300">{queueLabel(snapshot.match?.queueId) || t(`liveGame.state${snapshot.state === "coregame" ? "Coregame" : snapshot.state === "pregame" ? "Pregame" : "Party"}`)}</span>
					<span className="relative px-2 py-1 rounded-full bg-cyan-400/10 text-[10px] font-semibold uppercase tracking-wider text-cyan-300">● {t(`liveGame.state${snapshot.state === "coregame" ? "Coregame" : snapshot.state === "pregame" ? "Pregame" : "Party"}`)}</span>
					<div className="relative ml-auto flex items-center gap-2">
						<button type="button" onClick={() => setSummaryExpanded((current) => !current)} aria-expanded={summaryExpanded} aria-controls={summaryId} aria-label={t(summaryExpanded ? "liveGame.collapseSummary" : "liveGame.expandSummary")} className="h-11 w-11 rounded-lg border border-white/10 text-gray-400 hover:text-white hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 grid place-items-center transition-colors motion-reduce:transition-none"><FaChevronDown className={`transition-transform motion-reduce:transition-none ${summaryExpanded ? "rotate-180" : ""}`} /></button>
						<button type="button" onClick={onRefresh} disabled={refreshing} aria-label={t(refreshing ? "liveGame.refreshing" : "liveGame.refresh")} className="h-11 w-11 rounded-lg border border-white/10 text-gray-400 hover:text-white hover:bg-white/6 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 grid place-items-center transition-colors motion-reduce:transition-none"><FaArrowRotateRight className={refreshing ? "animate-spin motion-reduce:animate-none" : ""} /></button>
					</div>
				</div>
				{refreshError && <div role="status" className="px-4 py-2 border-t border-red-400/15 bg-red-400/5 text-xs text-red-300 flex items-center justify-between gap-3"><span className="truncate">{refreshError}</span><button type="button" onClick={onRefresh} className="shrink-0 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">{t("liveGame.retry")}</button></div>}
				<div id={summaryId} hidden={!summaryExpanded}>
					<div className="grid grid-cols-2 lg:grid-cols-4 border-t border-white/6">
						{[0, 1].map((index) => { const team = snapshot.teams[index]; const meta = team ? teamMeta(team.id, t) : { label: t(index === 0 ? "liveGame.teamAlly" : "liveGame.teamEnemy"), color: index === 0 ? "#4ade80" : "#f87171" }; return <div key={team?.id ?? index} className="px-4 py-2.5 border-r border-b lg:border-b-0 border-white/6"><p className="text-[10px] uppercase tracking-wider" style={{ color: meta.color }}>{meta.label} · {t("liveGame.teamAverage")}</p><p className="text-sm font-semibold text-white">{team?.averageTier != null ? tierName(Math.round(team.averageTier)) : <span aria-label={t("liveGame.unavailable")}>—</span>}</p><p className="text-[10px] text-gray-600">{t("liveGame.ratedPlayers", { count: team?.ratedPlayers ?? 0 })}</p></div>; })}
						<div className="px-4 py-2.5 border-r border-white/6"><p className="text-[10px] uppercase tracking-wider text-gray-500">{t("liveGame.detectedParties")}</p><p className="text-lg font-semibold tabular-nums">{parties}</p></div>
						<div className="px-4 py-2.5"><p className="text-[10px] uppercase tracking-wider text-gray-500">{t("liveGame.rosterSize")}</p><p className="text-lg font-semibold tabular-nums">{snapshot.players.length}</p></div>
					</div>
					{matchup && <LiveTeamMatchup matchup={matchup} mode={recentMode} />}
				</div>
			</section>

			<section className="glass rounded-2xl overflow-y-auto min-h-0" aria-label={t("liveGame.players")}>
				<div className="sticky top-0 z-10 grid grid-cols-[minmax(150px,1.5fr)_88px_52px_56px_34px] md:grid-cols-[minmax(180px,300px)_110px_140px_52px_56px_52px_52px_minmax(34px,1fr)] xl:grid-cols-[minmax(180px,300px)_76px_110px_140px_52px_56px_52px_52px_100px_minmax(34px,1fr)] gap-2 px-3 py-2 bg-[#101218]/95 backdrop-blur border-b border-white/8 text-[9px] uppercase tracking-widest text-gray-600">
					<span>{t("matches.player")}</span><span className="hidden xl:block">{t("liveGame.detectedParties")}</span><span>{t("liveGame.current")}</span><span className="hidden md:block">{t("liveGame.peak")}</span><span>{t("liveGame.kd")}</span><span>{t("liveGame.winRate")}</span><span className="hidden md:block">{t("liveGame.acs")}</span><span className="hidden md:block">{t("liveGame.dpr")}</span><span className="hidden xl:block">{t("liveGame.skins")}</span><span />
				</div>
				{[...teams.entries()].map(([teamId, players]) => { const meta = teamMeta(teamId, t); return <div key={teamId}><div className="px-3 py-2 flex items-center gap-2 bg-black/15 border-b border-white/5"><span className="w-2 h-2 rounded-full" style={{ background: meta.color }} /><h2 className="text-[10px] font-bold uppercase tracking-widest" style={{ color: meta.color }}>{meta.label}</h2><span className="ml-auto text-[10px] text-gray-600">{players.length}</span></div>{players.map((player) => <PlayerRow key={player.puuid} player={player} assets={assets} stats={recent[player.puuid]} expanded={expanded === player.puuid} onToggle={() => setExpanded((current) => current === player.puuid ? null : player.puuid)} teamColor={meta.color} teamLabel={meta.label} recentMode={recentMode} inMatch={inMatch} />)}</div>; })}
			</section>
		</div>
	);
};
