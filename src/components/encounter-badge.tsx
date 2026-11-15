import { useTranslation } from "react-i18next";
import { LuHistory } from "react-icons/lu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Encounter } from "@/util/encounters";

/**
 * "Played before" chip: how many of your recent matches this player was in,
 * coloured by side (green with you, red against you, amber both), with the
 * split in a tooltip.
 */
export const EncounterBadge = ({ encounter, recentMatches }: { encounter: Encounter | null; recentMatches: number }) => {
	const { t } = useTranslation();
	if (!encounter || encounter.with + encounter.against === 0) return null;
	const total = encounter.with + encounter.against;
	const tone =
		encounter.against === 0
			? "bg-emerald-400/10 text-emerald-300"
			: encounter.with === 0
				? "bg-red-400/10 text-red-300"
				: "bg-amber-400/10 text-amber-300";
	const parts = [
		encounter.with > 0 ? t("encounters.with", { count: encounter.with }) : null,
		encounter.against > 0 ? t("encounters.against", { count: encounter.against }) : null,
	].filter(Boolean);
	const detail = `${parts.join(" · ")} ${t("encounters.scope", { count: recentMatches })}`;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					data-encounter=""
					aria-label={t("encounters.label", { detail })}
					className={`inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-bold tabular-nums ${tone}`}
				>
					<LuHistory className="size-2.5" aria-hidden="true" />
					{total}×
				</span>
			</TooltipTrigger>
			<TooltipContent side="top">{detail}</TooltipContent>
		</Tooltip>
	);
};
