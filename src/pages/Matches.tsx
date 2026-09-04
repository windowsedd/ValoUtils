import { formatDpr } from "@/components/match-dpr";
import {
	MatchScoreboard,
	formatDateTime,
	useMatchAssets,
	useMatchDetails,
	type MatchAssets,
} from "@/components/match-scoreboard";
import { useMatchPlayerProfileModal } from "@/components/match-player-profile-modal";
import { LoginRequiredPanel } from "@/components/login-required-panel";
import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import { localize } from "@/util/valorant-assets";
import type { MatchDetails, MatchListEntry, MatchListResponse } from "@/types/matches";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { queueAccent, queueLabel } from "@/util/valorant-queues";
import { useEffect, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown, LuHistory } from "react-icons/lu";

const PAGE_SIZE = 20;

const matchListGrid =
	"grid w-full items-center gap-x-3 px-3 " +
	"grid-cols-[6.75rem_3.5rem_minmax(0,1fr)_0.75rem] " +
	"md:grid-cols-[6.75rem_3.5rem_minmax(8rem,1fr)_1.75rem_5.5rem_3rem_3rem_2rem_3.25rem_9.5rem_0.75rem]";

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
	const resultAccent =
		won === true ? "var(--signal-pos)" : won === false ? "var(--signal-neg)" : "var(--text-muted)";

	return (
		<div
			className="overflow-hidden rounded-[8px] border border-(--line) bg-(--panel-raised)"
			/* Result as a stripe as well as a colour — the score alone encodes
			   win/loss in hue only, which disappears for a colour-blind reader. */
			style={{ borderLeft: `3px solid ${resultAccent}` }}
			data-match-result={won === true ? "win" : won === false ? "loss" : undefined}
		>
			<button
				onClick={onToggle}
				aria-expanded={expanded}
				className={`${matchListGrid} py-2.5 text-left transition-colors hover:bg-(--surface-hover)`}
			>
				<span
					className={`truncate rounded-[5px] border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest ${queueAccent(entry.queueId)}`}
				>
					{queueLabel(entry.queueId)}
				</span>
				{thumb ? (
					<img src={thumb} alt="" className="w-14 h-8 rounded object-cover" />
				) : (
					<span className="h-8 w-14 rounded bg-(--control)" />
				)}
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="truncate text-[12px] font-medium text-(--text-primary)">{map || "—"}</span>
					{myTeam && theirTeam && (
						<span className="flex shrink-0 items-baseline gap-1.5">
							{/*
							 * The word is the only non-colour cue for the result, but it is
							 * also the widest thing competing with the map name. Kept from
							 * lg up where the row has room; below that the score colour and
							 * the row's left stripe carry it.
							 */}
							<span
								className="hidden text-[10px] font-semibold uppercase lg:inline"
								style={{ color: resultAccent }}
							>
								{won === true ? t("matches.victory") : won === false ? t("matches.defeat") : "—"}
							</span>
							<span className="text-[12px] font-semibold tabular-nums">
								<span style={{ color: resultAccent }}>{myTeam.roundsWon}</span>
								<span className="text-(--text-muted)">-</span>
								<span className="text-(--text-secondary)">{theirTeam.roundsWon}</span>
							</span>
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
						<span className="hidden text-right text-[11px] tabular-nums text-(--text-primary) md:block">
							{self.kills} / {self.deaths} / {self.assists}
						</span>
						<span className="hidden text-right text-[11px] tabular-nums text-(--text-muted) md:block" title={t("matches.acs")}>
							{self.acs}
						</span>
						<span className="hidden text-right text-[11px] tabular-nums text-(--text-muted) md:block" title={t("matches.dpr")}>
							{formatDpr(self)}
						</span>
						<span className="hidden text-right text-[11px] tabular-nums text-(--text-muted) md:block" title={t("matches.firstBloods")}>
							{self.firstBloods ?? 0}
						</span>
						<span className="hidden text-right text-[11px] tabular-nums text-(--text-muted) md:block" title={t("matches.headshot")}>
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
				<span className="hidden truncate text-right text-[11px] tabular-nums text-(--text-muted) md:block">
					{formatDateTime(entry.startMillis)}
				</span>
				<LuChevronDown className={`justify-self-end text-[11px] text-(--text-muted) transition-transform ${expanded ? "rotate-180" : ""}`} />
			</button>

			{expanded && (
				<div className="border-t border-(--line) px-3 py-3">
					<MatchScoreboard details={details} assets={assets} loading={loading} error={error} onPlayerSelect={onPlayerSelect} />
				</div>
			)}
		</div>
	);
};

const Matches = () => {
	const { t } = useTranslation();
	const [entries, setEntries] = useState<MatchListEntry[]>([]);
	// Bumped when the login panel sees a Riot Client appear, so the fetch
	// below re-runs without the user having to leave and re-enter the page.
	const [reloadKey, setReloadKey] = useState(0);
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
	}, [t, reloadKey]);

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
				icon={<LuHistory className="text-lg" />}
				title={t("matches.title")}
				subtitle={total ? t("matches.count", { count: total }) : undefined}
			/>

			<div className={pageBodyClass}>
				{loading && (
					<div className="flex flex-1 items-center justify-center text-[12px] text-(--text-muted)">{t("matches.loading")}</div>
				)}

				{!loading && loginRequired && (
					<LoginRequiredPanel
						onRetry={() => setReloadKey((key) => key + 1)}
						icon={<LuHistory />}
						title={t("matches.loginRequired")}
						description={t("matches.loginRequiredDesc")}
					/>
				)}

				{!loading && error && !loginRequired && (
					<div className="panel px-4 py-3">
						<p className="text-[12px] font-semibold text-(--signal-neg)">{t("matches.failedToLoad")}</p>
						<p className="mt-0.5 text-[11px] text-(--text-muted)">{error}</p>
					</div>
				)}

				{!loading && !error && !loginRequired && (
					<SectionCard title={t("matches.recentMatches")} count={entries.length}>
						{entries.length === 0 ? (
							<div className="flex flex-col items-center justify-center gap-2 py-10 text-(--text-muted)">
								<LuHistory className="text-4xl opacity-30" />
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
