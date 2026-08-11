import { MatchScoreboard, useMatchAssets, useMatchDetails } from "@/components/match-scoreboard";
import { SectionCard, SectionRow } from "@/components/section-card";
import type { CompetitiveUpdate } from "@/types/friend-profile";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaArrowDown, FaArrowUp, FaChevronDown, FaMinus, FaTrophy } from "react-icons/fa6";

export const FriendCompetitiveHistory = ({
	puuid,
	matches,
}: {
	puuid: string;
	matches: CompetitiveUpdate[];
}) => {
	const { t } = useTranslation();
	const assets = useMatchAssets();
	const { details, errors, pending, ensure, prefetch } = useMatchDetails();
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	useEffect(() => {
		prefetch(matches.map((match) => match.MatchID ?? "").filter(Boolean));
	}, [matches, prefetch]);

	const toggle = (matchId: string) => {
		if (!matchId) return;
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(matchId)) next.delete(matchId);
			else next.add(matchId);
			return next;
		});
		ensure(matchId);
	};

	return (
		<SectionCard title={t("friends.profileRecentMatches")} count={matches.length} accent="#22d3ee">
			{matches.length === 0 ? (
				<div className="flex flex-col items-center justify-center gap-2 py-10 text-gray-500">
					<FaTrophy className="text-3xl opacity-30" />
					<p className="text-sm">{t("friends.profileNoMatches")}</p>
				</div>
			) : matches.map((match, index) => {
				const matchId = match.MatchID ?? "";
				const open = expanded.has(matchId);
				const tierBefore = match.TierBeforeUpdate ?? 0;
				const tierAfter = match.TierAfterUpdate ?? 0;
				const rr = match.RankedRatingEarned ?? 0;
				const promoted = tierAfter > tierBefore;
				const demoted = tierAfter < tierBefore;
				const matchDetails = details[matchId];
				const player = matchDetails?.players.find((item) => item.subject.toLowerCase() === puuid.toLowerCase());
				const map = mapName(match.MapID ?? matchDetails?.mapId, assets.maps) || t("friends.profileUnknownMap");
				const thumbnail = mapIcon(match.MapID ?? matchDetails?.mapId, assets.maps);
				const tierIcon = tierAfter > 0 ? assets.tiers.get(tierAfter)?.icon : null;
				const date = match.MatchStartTime ? new Date(match.MatchStartTime).toLocaleDateString() : "—";

				return (
					<div key={matchId || index} className="overflow-hidden rounded-lg">
						<button
							type="button"
							onClick={() => toggle(matchId)}
							aria-expanded={open}
							disabled={!matchId}
							className="w-full text-left disabled:cursor-default"
						>
							<SectionRow>
								<span className="w-1 self-stretch rounded-full" style={{ background: rr > 0 ? "#4ade80" : rr < 0 ? "#f87171" : "#6b7280" }} />
								{thumbnail ? <img src={thumbnail} alt="" className="h-9 w-16 shrink-0 rounded object-cover" /> : <span className="h-9 w-16 shrink-0 rounded bg-white/5" />}
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-semibold text-white">{map}</p>
									<p className="text-xs text-gray-500">{date}</p>
								</div>
								{(promoted || demoted) && (
									<span className={`hidden items-center gap-1 text-xs font-semibold sm:flex ${promoted ? "text-green-400" : "text-red-400"}`}>
										{promoted ? <FaArrowUp /> : <FaArrowDown />}
										{t(promoted ? "career.promoted" : "career.demoted")}
									</span>
								)}
								<div className="hidden w-32 items-center justify-end gap-2 sm:flex">
									{tierIcon && <img src={tierIcon} alt="" className="h-5 w-5 object-contain" />}
									<span className="truncate text-sm font-semibold" style={{ color: tierColor(tierAfter) }}>{tierName(tierAfter)}</span>
								</div>
								<span className="hidden w-24 text-right text-xs tabular-nums text-gray-300 md:block">
									{player ? `${player.kills} / ${player.deaths} / ${player.assists}` : "—"}
								</span>
								<span className={`w-16 text-right text-sm font-bold tabular-nums ${rr > 0 ? "text-green-400" : rr < 0 ? "text-red-400" : "text-gray-500"}`}>
									{rr === 0 ? <FaMinus className="ml-auto" /> : `${rr > 0 ? "+" : ""}${rr} RR`}
								</span>
								<FaChevronDown className={`shrink-0 text-[10px] text-gray-600 transition-transform ${open ? "rotate-180" : ""}`} />
							</SectionRow>
						</button>
						{open && (
							<div className="px-3 pb-3 pt-1">
								<MatchScoreboard
									details={matchDetails}
									assets={assets}
									loading={pending.has(matchId)}
									error={errors[matchId]}
									highlightPuuid={puuid}
								/>
							</div>
						)}
					</div>
				);
			})}
		</SectionCard>
	);
};
