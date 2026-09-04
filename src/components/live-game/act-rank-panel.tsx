import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown } from "react-icons/lu";
import type { CompetitiveSeason } from "../../types/live-game";
import { tierColor, tierName } from "../../util/valorant-ranks";
import { seasonFallbackLabel, sortCompetitiveSeasons, tierRangeFromWins } from "./act-rank";
import { ActRankTriangle } from "./act-rank-triangle";
import type { LiveGameAssets } from "./use-live-game-assets";

type Props = {
	competitiveSeasons: CompetitiveSeason[];
	assets: Pick<LiveGameAssets, "seasons">;
	selectedSeasonId: string | null;
	onSeasonChange: (seasonId: string) => void;
	/**
	 * Single-player views open on the detail. The scout table leaves this off —
	 * ten expanded triangles at once would bury the roster.
	 */
	defaultExpanded?: boolean;
};

const ActStat = ({ label, value }: { label: string; value: ReactNode }) => (
	<div className="min-w-0">
		<p className="text-[9px] uppercase tracking-widest text-(--text-muted)">{label}</p>
		<p className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-(--text-primary)">{value}</p>
	</div>
);

/** One `label value` pair on the collapsed strip. */
const SummaryStat = ({ label, value }: { label: string; value: ReactNode }) => (
	<span className="flex items-baseline gap-1.5">
		<span className="text-[9px] uppercase tracking-widest text-(--text-muted)">{label}</span>
		<span className="text-[12px] font-semibold tabular-nums text-(--text-primary)">{value}</span>
	</span>
);

const selectClass =
	"h-8 max-w-44 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[12px] text-(--text-primary) outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]";
const toggleClass =
	"grid h-8 w-8 place-items-center rounded-[6px] border border-(--border) bg-(--control) text-(--text-muted) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]";

export const ActRankPanel = ({
	competitiveSeasons,
	assets,
	selectedSeasonId,
	onSeasonChange,
	defaultExpanded = false,
}: Props) => {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(defaultExpanded);
	const bodyId = useId();
	const starts = useMemo(
		() => new Map([...assets.seasons].map(([id, season]) => [id, season.startMillis])),
		[assets.seasons],
	);
	const seasons = useMemo(
		() => sortCompetitiveSeasons(competitiveSeasons, starts),
		[competitiveSeasons, starts],
	);
	const selected = seasons.find((season) => season.seasonId === selectedSeasonId) ?? seasons[0];
	const labelFor = (seasonId: string) =>
		assets.seasons.get(seasonId.toLowerCase())?.label ?? seasonFallbackLabel(seasonId);

	if (!selected) {
		return (
			<section className="panel px-3 py-2.5">
				<header className="flex items-center justify-between gap-3">
					<h3 className="text-[12px] font-medium text-(--text-primary)">{t("liveGame.actRank")}</h3>
					<p className="text-[11px] text-(--text-muted)">{t("liveGame.noActRank")}</p>
				</header>
			</section>
		);
	}

	const { lowest, peak } = tierRangeFromWins(selected.winsByTier);
	const rankText = (tier: number) => (tier > 0 ? tierName(tier) : t("liveGame.unavailable"));
	const winRate =
		selected.games > 0 ? `${((selected.wins / selected.games) * 100).toFixed(1)}%` : t("liveGame.unavailable");

	return (
		<section className="panel px-3 py-2.5">
			<header className={`flex items-center justify-between gap-3 ${expanded ? "border-b border-(--line) pb-2.5" : ""}`}>
				<div className="min-w-0">
					<h3 className="text-[12px] font-medium text-(--text-primary)">{t("liveGame.actRank")}</h3>
					<p className="text-[9px] uppercase tracking-widest text-(--text-muted)">{labelFor(selected.seasonId)}</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<select
						aria-label={t("liveGame.selectAct")}
						value={selected.seasonId}
						onChange={(event) => onSeasonChange(event.target.value)}
						className={selectClass}
					>
						{seasons.map((season) => (
							<option key={season.seasonId} value={season.seasonId}>
								{labelFor(season.seasonId)}
							</option>
						))}
					</select>
					<button
						type="button"
						onClick={() => setExpanded((current) => !current)}
						aria-expanded={expanded}
						aria-controls={bodyId}
						aria-label={t(expanded ? "liveGame.collapseActRank" : "liveGame.expandActRank")}
						className={toggleClass}
					>
						<LuChevronDown className={`text-xs transition-transform ${expanded ? "rotate-180" : ""}`} />
					</button>
				</div>
			</header>

			{/*
			 * Collapsed used to render an empty box — a full-width card holding nothing
			 * but its own header, which reads as a broken panel rather than a closed
			 * one. The headline numbers stand in for the triangle instead.
			 */}
			{!expanded && (
				<div data-act-rank-summary="" className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
					<span className="flex items-baseline gap-1.5">
						<span className="text-[9px] uppercase tracking-widest text-(--text-muted)">
							{t("liveGame.rank")}
						</span>
						<span
							className="text-[12px] font-semibold"
							style={{ color: selected.tier > 0 ? tierColor(selected.tier) : undefined }}
						>
							{rankText(selected.tier)}
						</span>
					</span>
					{selected.tier > 0 && (
						<SummaryStat label={t("liveGame.rankedRating")} value={`${selected.rankedRating} / 100`} />
					)}
					<SummaryStat label={t("liveGame.wins")} value={selected.wins} />
					<SummaryStat label={t("liveGame.games")} value={selected.games} />
					<SummaryStat label={t("liveGame.winRate")} value={winRate} />
				</div>
			)}

			<div
				id={bodyId}
				hidden={!expanded}
				className="mx-auto mt-3 grid w-full max-w-[48rem] grid-cols-2 gap-4 lg:grid-cols-[9rem_minmax(16rem,20rem)_10rem] lg:items-center lg:justify-center"
			>
				<div className="order-2 col-span-2 grid grid-cols-2 gap-3 lg:order-1 lg:col-span-1 lg:grid-cols-1">
					<ActStat
						label={t("liveGame.rank")}
						value={
							<span style={{ color: selected.tier > 0 ? tierColor(selected.tier) : undefined }}>
								{rankText(selected.tier)}
							</span>
						}
					/>
					<ActStat
						label={t("liveGame.rankedRating")}
						value={selected.tier > 0 ? `${selected.rankedRating} / 100` : t("liveGame.unavailable")}
					/>
				</div>
				<div className="order-1 col-span-2 lg:order-2 lg:col-span-1">
					<ActRankTriangle winsByTier={selected.winsByTier} wins={selected.wins} />
				</div>
				<div className="order-3 col-span-2 grid grid-cols-2 gap-3 lg:col-span-1 lg:grid-cols-1">
					<ActStat label={t("liveGame.wins")} value={selected.wins} />
					<ActStat label={t("liveGame.games")} value={selected.games} />
					<ActStat label={t("liveGame.winRate")} value={winRate} />
					<ActStat label={t("liveGame.peak")} value={rankText(peak)} />
					<ActStat label={t("liveGame.lowest")} value={rankText(lowest)} />
					<ActStat label={t("liveGame.finalRank")} value={rankText(selected.tier)} />
				</div>
			</div>
		</section>
	);
};
