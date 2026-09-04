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
			fill="var(--control)"
			stroke="var(--border)"
			strokeWidth="3"
			strokeLinejoin="round"
		/>
		<text x="32" y="40" textAnchor="middle" fontSize="22" fontWeight="700" fill="var(--text-muted)">
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
		<section data-previous-acts="" className="panel px-3 py-2.5">
			<h3 className="text-[12px] font-medium text-(--text-primary)">{t("liveGame.previousActs")}</h3>
			<div className="mt-2 flex gap-2 overflow-x-auto pb-1">
				{cards.map((card) => {
					const rated = card.peakTier >= 3;
					const icon = rated
						? (assets.tiers.get(card.peakTier)?.largeIcon ?? assets.tiers.get(card.peakTier)?.icon)
						: null;
					return (
						<article
							key={card.seasonId}
							data-previous-act={card.seasonId}
							className="flex w-[7.5rem] shrink-0 flex-col items-center rounded-[8px] border border-(--line) bg-(--panel-raised) px-2 py-2.5 text-center"
						>
							<p className="text-[10px] font-semibold uppercase tracking-wider text-(--text-secondary)">{card.label}</p>
							<div className="mt-1.5 grid h-12 w-12 place-items-center">
								{icon ? (
									<img src={icon} alt="" className="h-12 w-12 object-contain" />
								) : (
									<UnratedBadge />
								)}
							</div>
							<p className="mt-1.5 text-[9px] uppercase tracking-widest text-(--text-muted)">
								{t("liveGame.peakRating")}
							</p>
							<p
								className="mt-0.5 text-xs font-semibold"
								style={{ color: rated ? tierColor(card.peakTier) : "var(--text-muted)" }}
							>
								{rated ? tierName(card.peakTier) : t("liveGame.unrated")}
							</p>
							{/*
							 * Win rate and match count used to run together in one wrapping
							 * line. Two fixed rows keep them readable and let the numbers
							 * line up down the strip.
							 */}
							<dl className="mt-2 w-full space-y-0.5 border-t border-(--line) pt-1.5 text-[10px]">
								<div className="flex items-baseline justify-between gap-1">
									<dt className="text-(--text-muted)">{t("liveGame.winRate")}</dt>
									<dd className="tabular-nums text-(--text-secondary)">
										{card.winRate != null ? `${card.winRate.toFixed(0)}%` : "—"}
									</dd>
								</div>
								<div className="flex items-baseline justify-between gap-1">
									<dt className="text-(--text-muted)">{t("liveGame.actMatchesLabel")}</dt>
									<dd className="tabular-nums text-(--text-secondary)">{card.games}</dd>
								</div>
							</dl>
						</article>
					);
				})}
			</div>
		</section>
	);
};
