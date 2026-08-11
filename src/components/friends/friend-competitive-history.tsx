import { MatchScoreboard, useMatchAssets, useMatchDetails } from "@/components/match-scoreboard";
import { SectionCard, SectionRow } from "@/components/section-card";
import type { FriendMatch } from "@/types/friend-profile";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { queueLabel } from "@/util/valorant-queues";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaArrowDown, FaArrowUp, FaChevronDown, FaMinus, FaTrophy } from "react-icons/fa6";
import { availableFriendQueues, filterFriendMatches } from "./friend-match-filter";

export const FriendMatchHistory = ({
	puuid,
	matches,
}: {
	puuid: string;
	matches: FriendMatch[];
}) => {
	const { t } = useTranslation();
	const assets = useMatchAssets();
	const { details, errors, pending, ensure, prefetch } = useMatchDetails();
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [queue, setQueue] = useState("all");
	const queues = useMemo(() => availableFriendQueues(matches), [matches]);
	const visibleMatches = useMemo(() => filterFriendMatches(matches, queue), [matches, queue]);

	useEffect(() => {
		prefetch(visibleMatches.map((match) => match.matchId).filter(Boolean));
	}, [prefetch, visibleMatches]);

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
		<SectionCard
			title={t("friends.profileRecentMatches")}
			accent="#22d3ee"
			right={
				<select aria-label={t("friends.profileModeFilter")} value={queue} onChange={(event) => setQueue(event.target.value)} className="h-8 max-w-40 rounded-md border border-white/10 bg-[#101218] px-2 text-xs text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
					<option value="all">{t("friends.profileAllModes")}</option>
					{queues.map((queueId) => <option key={queueId || "custom"} value={queueId}>{queueLabel(queueId)}</option>)}
				</select>
			}
		>
			{visibleMatches.length === 0 ? (
				<div className="flex flex-col items-center justify-center gap-2 py-10 text-gray-500">
					<FaTrophy className="text-3xl opacity-30" />
					<p className="text-sm">{t("friends.profileNoMatches")}</p>
				</div>
			) : visibleMatches.map((match, index) => {
				const matchId = match.matchId;
				const open = expanded.has(matchId);
				const competitive = match.queueId.toLowerCase() === "competitive";
				const tierBefore = match.tierBefore ?? 0;
				const tierAfter = match.tierAfter ?? 0;
				const rr = match.rrEarned;
				const promoted = tierAfter > tierBefore;
				const demoted = tierAfter < tierBefore;
				const matchDetails = details[matchId];
				const player = matchDetails?.players.find((item) => item.subject.toLowerCase() === puuid.toLowerCase());
				const map = mapName(matchDetails?.mapId, assets.maps) || t("friends.profileUnknownMap");
				const thumbnail = mapIcon(matchDetails?.mapId, assets.maps);
				const tierIcon = tierAfter > 0 ? assets.tiers.get(tierAfter)?.icon : null;
				const date = match.startMillis ? new Date(match.startMillis).toLocaleDateString() : "—";
				const team = player ? matchDetails?.teams.find((item) => item.teamId === player.teamId) : undefined;
				const won = team?.won;
				const accent = competitive && rr != null ? (rr > 0 ? "#4ade80" : rr < 0 ? "#f87171" : "#6b7280") : won === true ? "#4ade80" : won === false ? "#f87171" : "#6b7280";

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
								<span className="w-1 self-stretch rounded-full" style={{ background: accent }} />
								{thumbnail ? <img src={thumbnail} alt="" className="h-9 w-16 shrink-0 rounded object-cover" /> : <span className="h-9 w-16 shrink-0 rounded bg-white/5" />}
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-semibold text-white">{map}</p>
									<p className="flex items-center gap-2 text-xs text-gray-500"><span>{date}</span><span className="text-gray-600">{queueLabel(match.queueId)}</span></p>
								</div>
								{competitive && (promoted || demoted) && (
									<span className={`hidden items-center gap-1 text-xs font-semibold sm:flex ${promoted ? "text-green-400" : "text-red-400"}`}>
										{promoted ? <FaArrowUp /> : <FaArrowDown />}
										{t(promoted ? "career.promoted" : "career.demoted")}
									</span>
								)}
								<div className={`hidden w-32 items-center justify-end gap-2 sm:flex ${competitive ? "" : "invisible"}`}>
									{tierIcon && <img src={tierIcon} alt="" className="h-5 w-5 object-contain" />}
									<span className="truncate text-sm font-semibold" style={{ color: tierColor(tierAfter) }}>{tierName(tierAfter)}</span>
								</div>
								<span className="hidden w-24 text-right text-xs tabular-nums text-gray-300 md:block">
									{player ? `${player.kills} / ${player.deaths} / ${player.assists}` : "—"}
								</span>
								<span className={`w-16 text-right text-sm font-bold tabular-nums ${accent === "#4ade80" ? "text-green-400" : accent === "#f87171" ? "text-red-400" : "text-gray-500"}`}>
									{competitive ? (rr == null || rr === 0 ? <FaMinus className="ml-auto" /> : `${rr > 0 ? "+" : ""}${rr} RR`) : won == null ? <FaMinus className="ml-auto" /> : t(won ? "matches.victory" : "matches.defeat")}
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
