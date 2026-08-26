import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaChevronDown } from "react-icons/fa6";
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
};

const ActStat = ({ label, value }: { label: string; value: ReactNode }) => (
	<div className="min-w-0">
		<p className="text-[9px] uppercase tracking-widest text-gray-600">{label}</p>
		<p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-gray-100">{value}</p>
	</div>
);

export const ActRankPanel = ({ competitiveSeasons, assets, selectedSeasonId, onSeasonChange }: Props) => {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
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
			<section className="rounded-lg border border-white/6 bg-black/15 p-3">
				<header className={`flex items-center justify-between gap-3 ${expanded ? "border-b border-white/6 pb-2" : ""}`}>
					<h3 className="text-xs font-bold text-white">{t("liveGame.actRank")}</h3>
					<button
						type="button"
						onClick={() => setExpanded((current) => !current)}
						aria-expanded={expanded}
						aria-controls={bodyId}
						aria-label={t(expanded ? "liveGame.collapseActRank" : "liveGame.expandActRank")}
						className="grid h-9 w-9 place-items-center rounded-md border border-white/10 text-gray-400 hover:bg-white/6 hover:text-white focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
					>
						<FaChevronDown className={`text-xs transition-transform ${expanded ? "rotate-180" : ""}`} />
					</button>
				</header>
				<div id={bodyId} hidden={!expanded} className="px-3 py-5 text-center">
					<p className="text-xs text-gray-500">{t("liveGame.noActRank")}</p>
				</div>
			</section>
		);
	}

	const { lowest, peak } = tierRangeFromWins(selected.winsByTier);
	const rankText = (tier: number) => (tier > 0 ? tierName(tier) : t("liveGame.unavailable"));
	const winRate =
		selected.games > 0 ? `${((selected.wins / selected.games) * 100).toFixed(1)}%` : t("liveGame.unavailable");

	return (
		<section className="rounded-lg border border-white/6 bg-black/15 p-3">
			<header className={`flex items-center justify-between gap-3 ${expanded ? "border-b border-white/6 pb-2" : ""}`}>
				<div className="min-w-0">
					<h3 className="text-xs font-bold text-white">{t("liveGame.actRank")}</h3>
					<p className="text-[9px] uppercase tracking-widest text-gray-600">{labelFor(selected.seasonId)}</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<select
						aria-label={t("liveGame.selectAct")}
						value={selected.seasonId}
						onChange={(event) => onSeasonChange(event.target.value)}
						className="h-9 max-w-44 rounded-md border border-white/10 bg-[#101218] px-2 text-xs text-gray-200 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
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
						className="grid h-9 w-9 place-items-center rounded-md border border-white/10 text-gray-400 hover:bg-white/6 hover:text-white focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
					>
						<FaChevronDown className={`text-xs transition-transform ${expanded ? "rotate-180" : ""}`} />
					</button>
				</div>
			</header>

			<div id={bodyId} hidden={!expanded} className="mx-auto mt-3 grid w-full max-w-[48rem] grid-cols-2 gap-4 lg:grid-cols-[9rem_minmax(16rem,20rem)_10rem] lg:items-center lg:justify-center">
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
