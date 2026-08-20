import type { CompetitiveSeason } from "../../types/live-game";
import { tierColor, tierName } from "../../util/valorant-ranks";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { previousActCards } from "./previous-acts";
import type { LiveGameAssets } from "./use-live-game-assets";

type Props = {
	competitiveSeasons: CompetitiveSeason[];
	currentSeasonId: string | null;
	assets: Pick<LiveGameAssets, "seasons" | "tiers">;
};

const UnratedBadge = () => (
	<svg viewBox="0 0 64 64" className="h-12 w-12" aria-hidden="true">
		<polygon
			points="32,6 54,19 54,45 32,58 10,45 10,19"
			fill="#1c2329"
			stroke="#5a646c"
			strokeWidth="3"
			strokeLinejoin="round"
		/>
		<text x="32" y="40" textAnchor="middle" fontSize="22" fontWeight="700" fill="#8d979f">
			?
		</text>
	</svg>
);

export const PreviousActsPanel = ({ competitiveSeasons, currentSeasonId, assets }: Props) => {
	const { t } = useTranslation();
	const starts = useMemo(
		() => new Map([...assets.seasons].map(([id, season]) => [id, season.startMillis])),
		[assets.seasons],
	);
	const labels = useMemo(
		() => new Map([...assets.seasons].map(([id, season]) => [id, season.label])),
		[assets.seasons],
	);
	const cards = useMemo(
		() => previousActCards(competitiveSeasons, currentSeasonId, starts, labels),
		[competitiveSeasons, currentSeasonId, starts, labels],
	);
	if (cards.length === 0) return null;

	return (
		<section data-previous-acts="" className="rounded-lg border border-white/6 bg-black/15 px-3 py-2.5">
			<h3 className="text-xs font-bold text-white">{t("liveGame.previousActs")}</h3>
			<div className="mt-2 flex gap-3 overflow-x-auto pb-1">
				{cards.map((card) => {
					const rated = card.peakTier >= 3;
					const icon = rated
						? (assets.tiers.get(card.peakTier)?.largeIcon ?? assets.tiers.get(card.peakTier)?.icon)
						: null;
					return (
						<article
							key={card.seasonId}
							data-previous-act={card.seasonId}
							className="flex w-[7.5rem] shrink-0 flex-col items-center text-center"
						>
							<p className="text-[10px] font-semibold uppercase tracking-wider text-(--ink-dim)">{card.label}</p>
							<div className="mt-1.5 grid h-12 w-12 place-items-center">
								{icon ? (
									<img src={icon} alt="" className="h-12 w-12 object-contain" />
								) : (
									<UnratedBadge />
								)}
							</div>
							<p className="mt-1.5 text-[9px] uppercase tracking-widest text-(--ink-faint)">
								{t("liveGame.peakRating")}
							</p>
							<p
								className="mt-0.5 text-xs font-semibold"
								style={{ color: rated ? tierColor(card.peakTier) : "#8d979f" }}
							>
								{rated ? tierName(card.peakTier) : t("liveGame.unrated")}
							</p>
							<p className="mt-1 text-[10px] tabular-nums text-(--ink-faint)">
								{card.winRate != null && <span>{t("liveGame.winRate")} {card.winRate.toFixed(0)}% </span>}
								<span>{t("liveGame.actMatches", { count: card.games })}</span>
							</p>
						</article>
					);
				})}
			</div>
		</section>
	);
};
