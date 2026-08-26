import { formatDpr } from "@/components/match-dpr";
import {
	MatchScoreboard,
	formatDateTime,
	useMatchAssets,
	useMatchDetails,
	type MatchAssets,
} from "@/components/match-scoreboard";
import { useMatchPlayerProfileModal } from "@/components/match-player-profile-modal";
import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import { localize } from "@/util/valorant-assets";
import type { MatchDetails, MatchListEntry, MatchListResponse } from "@/types/matches";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { queueAccent, queueLabel } from "@/util/valorant-queues";
import { useEffect, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { FaChevronDown, FaClockRotateLeft } from "react-icons/fa6";

const PAGE_SIZE = 20;

const matchListGrid =
	"grid w-full items-center gap-x-3 px-3 " +
	"grid-cols-[6.75rem_3.5rem_minmax(0,1fr)_0.75rem] " +
	"md:grid-cols-[6.75rem_3.5rem_minmax(5.5rem,1fr)_1.75rem_5.5rem_3rem_3rem_2rem_3.25rem_9.5rem_0.75rem]";

const MatchListHeader = () => {
	const { t } = useTranslation();
	return (
		<div
			className={`${matchListGrid} py-1.5 text-[10px] font-medium uppercase tracking-widest text-(--text-muted)`}
			data-match-list-headers=""
		>
			<span>{t("matches.mode")}</span>
			<span className="col-span-2">{t("matches.map")}</span>
			<span className="hidden md:block" title={t("matches.agent")} />
			<span className="hidden text-right md:block">{t("matches.kda")}</span>
			<span className="hidden text-right md:block" title={t("matches.acs")}>
				{t("matches.acs")}
			</span>
			<span className="hidden text-right md:block" title={t("matches.dpr")}>
				{t("matches.dpr")}
			</span>
			<span className="hidden text-right md:block" title={t("matches.firstBloods")}>
				{t("matches.fb")}
			</span>
			<span className="hidden text-right md:block" title={t("matches.headshot")}>
				{t("matches.hs")}
			</span>
			<span className="hidden text-right md:block">{t("matches.started")}</span>
			<span />
		</div>
	);
};

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
	const { t } = useTranslation();
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
				className={`${matchListGrid} py-2.5 text-left hover:bg-white/4 transition-colors`}
			>
				<span
					className="truncate text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded"
					style={{ color: queueAccent(entry.queueId), background: `${queueAccent(entry.queueId)}1a` }}
				>
					{queueLabel(entry.queueId)}
				</span>
				{thumb ? (
					<img src={thumb} alt="" className="w-14 h-8 rounded object-cover" />
				) : (
					<span className="w-14 h-8 rounded bg-white/5" />
				)}
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="truncate text-sm font-semibold text-white">{map || "—"}</span>
					{myTeam && theirTeam && (
						<span className="shrink-0 text-sm font-bold tabular-nums">
							<span style={{ color: won ? "#4ade80" : "#f87171" }}>{myTeam.roundsWon}</span>
							<span className="text-gray-600"> - </span>
							<span className="text-gray-400">{theirTeam.roundsWon}</span>
						</span>
					)}
				</span>
				{agent?.icon ? (
					<img
						src={agent.icon}
						alt={localize(agent.name)}
						title={localize(agent.name)}
						className="hidden h-7 w-7 rounded md:block"
					/>
				) : (
					<span className="hidden h-7 w-7 md:block" />
				)}
				{self ? (
					<>
						<span className="hidden text-right text-xs tabular-nums text-gray-300 md:block">
							{self.kills} / {self.deaths} / {self.assists}
						</span>
						<span className="hidden text-right text-xs tabular-nums text-gray-500 md:block" title={t("matches.acs")}>
							{self.acs}
						</span>
						<span className="hidden text-right text-xs tabular-nums text-gray-500 md:block" title={t("matches.dpr")}>
							{formatDpr(self)}
						</span>
						<span className="hidden text-right text-xs tabular-nums text-gray-500 md:block" title={t("matches.firstBloods")}>
							{self.firstBloods ?? 0}
						</span>
						<span className="hidden text-right text-xs tabular-nums text-gray-500 md:block" title={t("matches.headshot")}>
							{self.headshotPercent.toFixed(0)}%
						</span>
					</>
				) : (
					<>
						<span className="hidden md:block" />
						<span className="hidden md:block" />
						<span className="hidden md:block" />
						<span className="hidden md:block" />
						<span className="hidden md:block" />
					</>
				)}
				<span className="hidden truncate text-right text-xs text-gray-600 md:block">
					{formatDateTime(entry.startMillis)}
				</span>
				<FaChevronDown className={`justify-self-end text-gray-600 text-xs transition-transform ${expanded ? "rotate-180" : ""}`} />
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
	}, [t]);

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

			<div className={pageBodyClass}>
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
							<>
							<MatchListHeader />
							{entries.map((entry) => (
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
							))}
							</>
						)}
					</SectionCard>
				)}
			</div>
		</div>
	);
};

export default Matches;
