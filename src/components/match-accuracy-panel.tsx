import type { MatchPlayer } from "@/types/matches";
import { useTranslation } from "react-i18next";
import { formatShotPercent, shotAccuracy, type ShotZone } from "./match-accuracy";

/** Mix ink-faint → ink so 0% matches the flat gray tracker figure. */
const zoneFill = (percent: number) => {
	const t = Math.min(1, Math.max(0, percent / 100));
	return `rgba(230, 234, 237, ${0.36 + t * 0.54})`;
};

const AccuracySilhouette = ({
	head,
	body,
	legs,
}: {
	head: number;
	body: number;
	legs: number;
}) => (
	<svg viewBox="0 0 80 180" className="h-[100px] w-auto shrink-0" aria-hidden="true">
		<ellipse cx="40" cy="22" rx="16" ry="18" fill={zoneFill(head)} />
		<rect x="33" y="38" width="14" height="10" rx="3" fill={zoneFill(body)} />
		<path
			d="M18 50c0-5 8-8 22-8s22 3 22 8l5 52H13z"
			fill={zoneFill(body)}
		/>
		<path d="M15 102h22l-2 68c0 4-4 8-9 8s-10-4-10-8z" fill={zoneFill(legs)} />
		<path d="M43 102h22l-1 68c0 4-5 8-10 8s-9-4-9-8z" fill={zoneFill(legs)} />
	</svg>
);

export const MatchAccuracy = ({
	player,
}: {
	player: Pick<MatchPlayer, "headshots" | "bodyshots" | "legshots">;
}) => {
	const { t } = useTranslation();
	const accuracy = shotAccuracy(player);
	const byZone = Object.fromEntries(accuracy.zones.map((zone) => [zone.zone, zone])) as Record<
		ShotZone,
		(typeof accuracy.zones)[number]
	>;

	return (
		<div data-match-accuracy="" className="flex min-w-[15rem] shrink-0 flex-col rounded-[8px] border border-(--line) bg-(--surface) px-3 py-2.5">
			<p className="text-sm font-semibold text-(--ink)">{t("matches.accuracy")}</p>
			<div className="mt-1 flex items-center gap-4">
				<AccuracySilhouette
					head={byZone.head.percent}
					body={byZone.body.percent}
					legs={byZone.legs.percent}
				/>
				<div className="min-w-0 flex-1">
					{accuracy.zones.map((zone) => (
						<div
							key={zone.zone}
							data-accuracy-zone={zone.zone}
							className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-baseline gap-3 py-px"
						>
							<span className="text-xs text-(--ink-dim)">{t(`matches.${zone.zone}`)}</span>
							<span className="text-right text-xs tabular-nums text-(--ink)">{formatShotPercent(zone.percent)}</span>
							<span className="text-right text-xs tabular-nums text-(--ink-faint)">
								{t("matches.hits", { count: zone.hits })}
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
