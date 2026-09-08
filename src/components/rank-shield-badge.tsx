import { LuShieldCheck } from "react-icons/lu";
import { useTranslation } from "react-i18next";

const SHIELD_TIERS = new Set([3, 6, 9, 12, 15, 18, 21, 24]);

export const isRankShieldTier = (tier: number) => SHIELD_TIERS.has(tier);

export const RankShieldBadge = ({
	tier,
	remaining,
	compact = false,
	inline = false,
}: {
	tier: number;
	remaining: number | null;
	compact?: boolean;
	/** Drops the pill chrome so the shield can sit on a dense row beside a
	 *  number without reading as a second column. */
	inline?: boolean;
}) => {
	const { t } = useTranslation();
	if (!isRankShieldTier(tier)) return null;

	const known = remaining === 0 || remaining === 1 || remaining === 2;
	const label = known
		? t("rankShield.remaining", { count: remaining })
		: t("rankShield.unavailable");

	return (
		<span
			data-rank-shield=""
			aria-label={label}
			title={label}
			className={
				inline
					? "inline-flex shrink-0 items-center gap-0.5 text-[10px] text-cyan-300/70"
					: `inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-cyan-300/20 bg-cyan-300/8 text-cyan-200 ${compact ? "px-1 py-0.5 text-[9px]" : "px-2 py-1 text-[11px]"}`
			}
		>
			<LuShieldCheck aria-hidden="true" />
			<span className="tabular-nums">{known ? `${remaining}/2` : "—"}</span>
		</span>
	);
};
