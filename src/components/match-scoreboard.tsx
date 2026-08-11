import type { MatchDetails, MatchDetailsResponse, MatchPlayer } from "@/types/matches";
import {
	getAgents,
	getMaps,
	getSeasonLabels,
	getTiers,
	localize,
	type AgentAsset,
	type MapAsset,
	type TierAsset,
} from "@/util/valorant-assets";
import { tierName } from "@/util/valorant-ranks";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isMatchPlayerHighlighted } from "./match-player-highlight";

/** CDN lookups every match view needs. Each getter memoises at module scope. */
export type MatchAssets = {
	agents: Map<string, AgentAsset>;
	tiers: Map<number, TierAsset>;
	maps: Map<string, MapAsset>;
	seasons: Map<string, string>;
};

export const useMatchAssets = (): MatchAssets => {
	const [assets, setAssets] = useState<MatchAssets>({
		agents: new Map(),
		tiers: new Map(),
		maps: new Map(),
		seasons: new Map(),
	});
	useEffect(() => {
		let cancelled = false;
		Promise.all([getAgents(), getTiers(), getMaps(), getSeasonLabels()]).then(([agents, tiers, maps, seasons]) => {
			if (!cancelled) setAssets({ agents, tiers, maps, seasons });
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return assets;
};

/**
 * Lazy per-match detail loader. Raw match documents are ~830 KB, so nothing is
 * fetched until a card is opened; the backend reduces them to a scoreboard and
 * caches by match id, and results are kept here too (matches never change).
 */
export const useMatchDetails = () => {
	const [details, setDetails] = useState<Record<string, MatchDetails>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [pending, setPending] = useState<Set<string>>(new Set());

	// One long-lived listener keyed by match id, rather than a one-shot handler
	// per request: `match:summaries` pushes many matches down this same channel,
	// and several cards can be in flight at once.
	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("match:details", (message: string) => {
			const res = JSON.parse(message) as MatchDetailsResponse;
			const id = res.success ? res.match.matchId : res.matchId;
			if (!id) return;
			if (res.success) setDetails((prev) => (prev[id] ? prev : { ...prev, [id]: res.match }));
			else setErrors((prev) => ({ ...prev, [id]: res.error }));
			setPending((prev) => {
				if (!prev.has(id)) return prev;
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		});
		return () => window.Main.removeAllListeners("match:details");
	}, []);

	/** Fetch one match; already-loaded or in-flight ids are no-ops. */
	const ensure = useCallback(
		(matchId: string) => {
			if (!window.Main || !matchId || details[matchId] || pending.has(matchId)) return;
			setPending((prev) => new Set(prev).add(matchId));
			window.Main.send("match:details", matchId);
		},
		[details, pending]
	);

	/**
	 * Warm a whole list. Results arrive one at a time on `match:details`, so
	 * rows fill in progressively instead of blocking on the slowest match.
	 */
	const prefetch = useCallback(
		(matchIds: string[]) => {
			if (!window.Main) return;
			const wanted = matchIds.filter((id) => id && !details[id] && !pending.has(id));
			if (wanted.length === 0) return;
			setPending((prev) => {
				const next = new Set(prev);
				for (const id of wanted) next.add(id);
				return next;
			});
			window.Main.send("match:summaries", wanted);
		},
		[details, pending]
	);

	return { details, errors, pending, ensure, prefetch };
};

const TEAM_COLORS: Record<string, string> = { Red: "#ff4655", Blue: "#22d3ee" };
export const teamColor = (teamId: string) => TEAM_COLORS[teamId] ?? "#6b7280";

export const formatDateTime = (ms: number) =>
	ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export const formatDuration = (ms: number) => {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

const Stat = ({ label, value, color }: { label: string; value: string; color?: string }) => (
	<div className="min-w-0">
		<p className="text-[10px] uppercase tracking-widest text-gray-600">{label}</p>
		<p className="text-sm font-semibold tabular-nums truncate" style={color ? { color } : undefined}>
			{value}
		</p>
	</div>
);

const ScoreboardRow = ({ player, assets, highlighted }: { player: MatchPlayer; assets: MatchAssets; highlighted: boolean }) => {
	const agent = assets.agents.get(player.characterId.toLowerCase());
	const tierIcon = player.competitiveTier > 0 ? assets.tiers.get(player.competitiveTier)?.icon : undefined;

	return (
		<div
			className={`flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors ${
				highlighted ? "bg-white/6" : "hover:bg-white/4"
			}`}
		>
			<span className="w-0.5 self-stretch rounded-full shrink-0" style={{ background: teamColor(player.teamId) }} />
			{agent?.icon ? (
				<img src={agent.icon} alt={localize(agent.name)} title={localize(agent.name)} className="w-7 h-7 rounded shrink-0" />
			) : (
				<span className="w-7 h-7 rounded bg-white/5 shrink-0" />
			)}
			<div className="min-w-0 flex-1">
				<p className="text-xs font-semibold truncate">
					<span className={highlighted ? "text-white" : "text-gray-300"}>{player.gameName || "—"}</span>
					{player.tagLine && <span className="text-gray-600">#{player.tagLine}</span>}
				</p>
				<p className="text-[10px] text-gray-600 truncate">{agent ? localize(agent.name) : ""}</p>
			</div>
			{tierIcon && (
				<img src={tierIcon} alt={tierName(player.competitiveTier)} title={tierName(player.competitiveTier)} className="w-5 h-5 shrink-0" />
			)}
			<span className="w-20 text-right text-xs tabular-nums text-gray-300 shrink-0">
				{player.kills} / {player.deaths} / {player.assists}
			</span>
			<span className="w-12 text-right text-xs font-semibold tabular-nums text-white shrink-0">{player.acs}</span>
			<span className="w-12 text-right text-xs tabular-nums text-gray-400 shrink-0">{player.adr}</span>
			<span className="w-12 text-right text-xs tabular-nums text-gray-400 shrink-0">{player.headshotPercent.toFixed(0)}%</span>
		</div>
	);
};

/**
 * Expanded match body: the highlighted player's line, the full scoreboard, and match metadata.
 * Shared by the Matches tab and the Competitive tab's match history.
 */
export const MatchScoreboard = ({
	details,
	assets,
	loading,
	error,
	highlightPuuid,
}: { details?: MatchDetails; assets: MatchAssets; loading?: boolean; error?: string; highlightPuuid?: string }) => {
	const { t } = useTranslation();
	if (loading) return <p className="text-xs text-gray-500 px-2 py-3">{t("matches.loadingDetails")}</p>;
	if (error) return <p className="text-xs text-red-300 px-2 py-3">{error}</p>;
	if (!details) return null;

	const self = details.players.find((player) => isMatchPlayerHighlighted(player, highlightPuuid));
	// Deathmatch gives each player their own "team", so a Red/Blue scoreline
	// would be meaningless there.
	const scoreTeams = details.teams.filter((team) => team.teamId === "Red" || team.teamId === "Blue");
	const myTeam = self ? scoreTeams.find((team) => team.teamId === self.teamId) : undefined;
	const won = myTeam?.won;
	const seasonLabel = details.seasonId ? assets.seasons.get(details.seasonId.toLowerCase()) : undefined;

	return (
		<div className="flex flex-col gap-3">
			{self && (
				<div className="flex items-center gap-4 flex-wrap rounded-lg bg-black/20 px-3 py-2.5">
					{assets.agents.get(self.characterId.toLowerCase())?.icon && (
						<img src={assets.agents.get(self.characterId.toLowerCase())!.icon} alt="" className="w-10 h-10 rounded shrink-0" />
					)}
					<Stat label={t("matches.kda")} value={`${self.kills} / ${self.deaths} / ${self.assists}`} />
					<Stat label={t("matches.acs")} value={String(self.acs)} />
					<Stat label={t("matches.adr")} value={String(self.adr)} />
					<Stat label={t("matches.headshot")} value={`${self.headshotPercent.toFixed(1)}%`} />
					<Stat label={t("matches.damage")} value={String(self.damage)} />
					<Stat
						label={t("matches.result")}
						value={won === undefined ? "—" : won ? t("matches.victory") : t("matches.defeat")}
						color={won === undefined ? undefined : won ? "#4ade80" : "#f87171"}
					/>
				</div>
			)}

			<div className="flex flex-col gap-0.5">
				<div className="flex items-center gap-3 px-2 pb-1 text-[10px] uppercase tracking-widest text-gray-600">
					<span className="w-0.5 shrink-0" />
					<span className="w-7 shrink-0" />
					<span className="flex-1">{t("matches.player")}</span>
					<span className="w-5 shrink-0" />
					<span className="w-20 text-right shrink-0">{t("matches.kda")}</span>
					<span className="w-12 text-right shrink-0">{t("matches.acs")}</span>
					<span className="w-12 text-right shrink-0">{t("matches.adr")}</span>
					<span className="w-12 text-right shrink-0">{t("matches.hs")}</span>
				</div>
				{details.players.map((player) => (
					<ScoreboardRow key={player.subject} player={player} assets={assets} highlighted={isMatchPlayerHighlighted(player, highlightPuuid)} />
				))}
			</div>

			<div className="flex flex-wrap gap-x-6 gap-y-1 px-2 pt-1 text-[10px] text-gray-600 border-t border-white/5">
				<span>
					{t("matches.started")} {formatDateTime(details.startMillis)}
				</span>
				<span>
					{t("matches.duration")} {formatDuration(details.lengthMillis)}
				</span>
				<span>
					{t("matches.rounds")} {details.rounds}
				</span>
				{seasonLabel && (
					<span>
						{t("matches.season")} {seasonLabel}
					</span>
				)}
				{details.server && <span className="font-mono">{details.server}</span>}
				{details.gameVersion && <span className="font-mono">{details.gameVersion}</span>}
			</div>
		</div>
	);
};
