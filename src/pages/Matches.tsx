import {
	MatchScoreboard,
	formatDateTime,
	useMatchAssets,
	useMatchDetails,
	type MatchAssets,
} from "@/components/match-scoreboard";
import { useMatchPlayerProfileModal } from "@/components/match-player-profile-modal";
import { PageHeader, SectionCard } from "@/components/section-card";
import { localize } from "@/util/valorant-assets";
import type { MatchDetails, MatchListEntry, MatchListResponse } from "@/types/matches";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { queueAccent, queueLabel } from "@/util/valorant-queues";
import { useEffect, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { FaChevronDown, FaClockRotateLeft } from "react-icons/fa6";

const PAGE_SIZE = 20;

const MatchCard = ({
	entry,
	details,
	loading,
	error,
	expanded,
	onToggle,
	assets,
	onPlayerSelect,
}: {
	entry: MatchListEntry;
	details?: MatchDetails;
	loading: boolean;
	error?: string;
	expanded: boolean;
	onToggle: () => void;
	assets: MatchAssets;
	onPlayerSelect: NonNullable<ComponentProps<typeof MatchScoreboard>["onPlayerSelect"]>;
}) => {
	const self = details?.players.find((p) => p.isSelf);
	const map = details ? mapName(details.mapId, assets.maps) : "";
	const thumb = details ? mapIcon(details.mapId, assets.maps) : null;
	const agent = self ? assets.agents.get(self.characterId.toLowerCase()) : undefined;
	const scoreTeams = (details?.teams ?? []).filter((team) => team.teamId === "Red" || team.teamId === "Blue");
	const myTeam = self ? scoreTeams.find((team) => team.teamId === self.teamId) : undefined;
	const theirTeam = scoreTeams.find((team) => team.teamId !== myTeam?.teamId);
	const won = myTeam?.won;

	return (
		<div className="rounded-xl bg-white/2 overflow-hidden">
			<button
				onClick={onToggle}
				aria-expanded={expanded}
				className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/4 transition-colors"
			>
				<span
					className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded shrink-0"
					style={{ color: queueAccent(entry.queueId), background: `${queueAccent(entry.queueId)}1a` }}
				>
					{queueLabel(entry.queueId)}
				</span>
				{thumb ? (
					<img src={thumb} alt="" className="w-14 h-8 rounded object-cover shrink-0" />
				) : (
					<span className="w-14 h-8 rounded bg-white/5 shrink-0" />
				)}
				<span className="text-sm font-semibold text-white truncate">{map || "—"}</span>

				{myTeam && theirTeam && (
					<span className="text-sm font-bold tabular-nums shrink-0">
						<span style={{ color: won ? "#4ade80" : "#f87171" }}>{myTeam.roundsWon}</span>
						<span className="text-gray-600"> - </span>
						<span className="text-gray-400">{theirTeam.roundsWon}</span>
					</span>
				)}

				<span className="ml-auto flex items-center gap-4 shrink-0">
					{agent?.icon && (
						<img src={agent.icon} alt={localize(agent.name)} title={localize(agent.name)} className="w-7 h-7 rounded shrink-0" />
					)}
					{self && (
						<>
							<span className="text-xs tabular-nums text-gray-300 hidden md:block">
								{self.kills} / {self.deaths} / {self.assists}
							</span>
							<span className="text-xs tabular-nums text-gray-500 hidden md:block w-12 text-right">
								{self.headshotPercent.toFixed(0)}%
							</span>
						</>
					)}
					<span className="text-xs text-gray-600 hidden sm:block">{formatDateTime(entry.startMillis)}</span>
				</span>
				<FaChevronDown className={`text-gray-600 text-xs shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
			</button>

			{expanded && (
				<div className="px-3 pb-3">
					<MatchScoreboard details={details} assets={assets} loading={loading} error={error} onPlayerSelect={onPlayerSelect} />
				</div>
			)}
		</div>
	);
};

const Matches = () => {
	const { t } = useTranslation();
	const [entries, setEntries] = useState<MatchListEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);

	const assets = useMatchAssets();
	const openMatchPlayerProfile = useMatchPlayerProfileModal(assets);
	const { details, errors, pending, ensure, prefetch } = useMatchDetails();

	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("match:list", (message: string) => {
			const res = JSON.parse(message) as MatchListResponse;
			setLoading(false);
			if (!res.success) {
				setLoginRequired(res.code === "loginRequired");
				setError(res.error ?? t("matches.failedToLoad"));
				return;
			}
			setLoginRequired(false);
			setError(null);
			setEntries(res.matches);
			setTotal(res.total);
		});
		window.Main.send("match:list", 0, PAGE_SIZE);
		return () => window.Main.removeAllListeners("match:list");
	}, []);

	useEffect(() => {
		const ids = entries.map((e) => e.matchId).filter(Boolean);
		if (ids.length) prefetch(ids);
	}, [entries, prefetch]);

	const toggle = (matchId: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(matchId)) next.delete(matchId);
			else next.add(matchId);
			return next;
		});
		ensure(matchId);
	};

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<FaClockRotateLeft className="text-[#ff4655] text-lg" />}
				title={t("matches.title")}
				subtitle={total ? t("matches.count", { count: total }) : undefined}
			/>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 flex flex-col gap-4">
				{loading && (
					<div className="flex-1 flex items-center justify-center text-gray-500 text-sm">{t("matches.loading")}</div>
				)}

				{!loading && loginRequired && (
					<div className="flex-1 flex items-center justify-center">
						<div className="glass p-6 text-center max-w-md flex flex-col items-center gap-2">
							<FaClockRotateLeft className="text-3xl text-gray-700 mb-1" />
							<p className="text-white font-semibold">{t("matches.loginRequired")}</p>
							<p className="text-gray-500 text-sm">{t("matches.loginRequiredDesc")}</p>
						</div>
					</div>
				)}

				{!loading && error && !loginRequired && (
					<div className="glass rounded-2xl px-4 py-3">
						<p className="text-sm text-red-300 font-semibold">{t("matches.failedToLoad")}</p>
						<p className="text-xs text-gray-500 mt-0.5">{error}</p>
					</div>
				)}

				{!loading && !error && !loginRequired && (
					<SectionCard title={t("matches.recentMatches")} count={entries.length} accent="#ff4655">
						{entries.length === 0 ? (
							<div className="flex flex-col items-center justify-center gap-2 py-10 text-gray-500">
								<FaClockRotateLeft className="text-4xl opacity-30" />
								<p className="text-sm">{t("matches.noMatches")}</p>
							</div>
						) : (
							entries.map((entry) => (
								<MatchCard
									key={entry.matchId}
									entry={entry}
									details={details[entry.matchId]}
									loading={pending.has(entry.matchId)}
									error={errors[entry.matchId]}
									expanded={expanded.has(entry.matchId)}
									onToggle={() => toggle(entry.matchId)}
									assets={assets}
									onPlayerSelect={openMatchPlayerProfile}
								/>
							))
						)}
					</SectionCard>
				)}
			</div>
		</div>
	);
};

export default Matches;
