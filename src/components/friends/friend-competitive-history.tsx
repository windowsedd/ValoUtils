import { formatDpr } from "@/components/match-dpr";
import { MatchScoreboard, useMatchAssets, useMatchDetails } from "@/components/match-scoreboard";
import { useMatchPlayerProfileModal } from "@/components/match-player-profile-modal";
import { SectionCard, SectionRow } from "@/components/section-card";
import type { FriendMatch } from "@/types/friend-profile";
import { localize } from "@/util/valorant-assets";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { queueLabel } from "@/util/valorant-queues";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowDown, LuArrowUp, LuChevronDown, LuMinus, LuTrophy } from "react-icons/lu";
import { availableFriendQueues, filterFriendMatches } from "./friend-match-filter";

// Row accent is compared by value further down, so these stay single sources.
const POS = "var(--signal-pos)";
const NEG = "var(--signal-neg)";
const NEUTRAL = "var(--text-muted)";

export const FriendMatchHistory = ({
	puuid,
	matches,
	playerProfilesEnabled = true,
}: {
	puuid: string;
	matches: FriendMatch[];
	playerProfilesEnabled?: boolean;
}) => {
	const { t } = useTranslation();
	const assets = useMatchAssets();
	const openPlayerProfileModal = useMatchPlayerProfileModal(assets);
	const openMatchPlayerProfile = playerProfilesEnabled ? openPlayerProfileModal : undefined;
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
			right={
				<select aria-label={t("friends.profileModeFilter")} value={queue} onChange={(event) => setQueue(event.target.value)} className="h-8 max-w-40 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[12px] text-(--text-primary) outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]">
					<option value="all">{t("friends.profileAllModes")}</option>
					{queues.map((queueId) => <option key={queueId || "custom"} value={queueId}>{queueLabel(queueId)}</option>)}
				</select>
			}
		>
			{/*
			 * Column header. Without it the trailing figures are three unlabelled
			 * number columns; the widths mirror the row cells below so they line up,
			 * and each one hides at the same breakpoint as the cell it names.
			 */}
			{visibleMatches.length > 0 && (
				<div
					data-friend-match-headers=""
					className="flex items-center gap-3 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-widest text-(--text-muted)"
				>
					<span className="w-1 shrink-0" aria-hidden="true" />
					<span className="w-16 shrink-0">{t("matches.map")}</span>
					<span className="w-9 shrink-0">{t("matches.agent")}</span>
					<span className="min-w-0 flex-1" />
					<span className="hidden w-32 text-right sm:block">{t("friends.profileCurrentRank")}</span>
					<span className="hidden w-24 text-right md:block">{t("matches.kda")}</span>
					<span className="hidden w-12 text-right lg:block" title={t("matches.dpr")}>
						{t("matches.dpr")}
					</span>
					<span className="hidden w-8 text-right lg:block" title={t("matches.firstBloods")}>
						{t("matches.fb")}
					</span>
					<span className="w-16 text-right">RR</span>
					<span className="w-[10px] shrink-0" aria-hidden="true" />
				</div>
			)}

			{visibleMatches.length === 0 ? (
				<div className="flex flex-col items-center justify-center gap-2 py-10 text-(--text-muted)">
					<LuTrophy className="text-3xl opacity-30" />
					<p className="text-[12px]">{t("friends.profileNoMatches")}</p>
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
				const agent = player ? assets.agents.get(player.characterId.toLowerCase()) : undefined;
				const map = mapName(matchDetails?.mapId, assets.maps) || t("friends.profileUnknownMap");
				const thumbnail = mapIcon(matchDetails?.mapId, assets.maps);
				const tierIcon = tierAfter > 0 ? assets.tiers.get(tierAfter)?.icon : null;
				const date = match.startMillis ? new Date(match.startMillis).toLocaleDateString() : "—";
				const team = player ? matchDetails?.teams.find((item) => item.teamId === player.teamId) : undefined;
				const won = team?.won;
				const accent = competitive && rr != null ? (rr > 0 ? POS : rr < 0 ? NEG : NEUTRAL) : won === true ? POS : won === false ? NEG : NEUTRAL;

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
								{thumbnail ? <img src={thumbnail} alt="" className="h-9 w-16 shrink-0 rounded object-cover" /> : <span className="h-9 w-16 shrink-0 rounded bg-(--control)" />}
								{agent ? <img src={agent.icon} alt={localize(agent.name)} title={localize(agent.name)} className="h-9 w-9 shrink-0 rounded bg-(--control) object-contain" /> : <span className="h-9 w-9 shrink-0 rounded bg-(--control)" />}
								<div className="min-w-0 flex-1">
									<p className="truncate text-[12px] font-medium text-(--text-primary)">{map}</p>
									<p className="flex items-center gap-2 text-[11px] text-(--text-muted)"><span className="tabular-nums">{date}</span><span>{queueLabel(match.queueId)}</span></p>
								</div>
								{competitive && (promoted || demoted) && (
									<span className={`hidden items-center gap-1 text-xs font-semibold sm:flex ${promoted ? "text-(--signal-pos)" : "text-(--signal-neg)"}`}>
										{promoted ? <LuArrowUp /> : <LuArrowDown />}
										{t(promoted ? "career.promoted" : "career.demoted")}
									</span>
								)}
								<div className={`hidden w-32 items-center justify-end gap-2 sm:flex ${competitive ? "" : "invisible"}`}>
									{tierIcon && <img src={tierIcon} alt="" className="h-5 w-5 object-contain" />}
									<span className="truncate text-[12px] font-semibold" style={{ color: tierColor(tierAfter) }}>{tierName(tierAfter)}</span>
								</div>
								<span className="hidden w-24 text-right text-[11px] tabular-nums text-(--text-secondary) md:block">
									{player ? `${player.kills} / ${player.deaths} / ${player.assists}` : "—"}
								</span>
								<span className="hidden w-12 text-right text-[11px] tabular-nums text-(--text-muted) lg:block">
									{player ? formatDpr(player) : "—"}
								</span>
								<span className="hidden w-8 text-right text-[11px] tabular-nums text-(--text-muted) lg:block">
									{player ? String(player.firstBloods ?? 0) : "—"}
								</span>
								<span className={`w-16 text-right text-[12px] font-semibold tabular-nums ${accent === POS ? "text-(--signal-pos)" : accent === NEG ? "text-(--signal-neg)" : "text-(--text-muted)"}`}>
									{competitive ? (rr == null || rr === 0 ? <LuMinus className="ml-auto" /> : `${rr > 0 ? "+" : ""}${rr} RR`) : won == null ? <LuMinus className="ml-auto" /> : t(won ? "matches.victory" : "matches.defeat")}
								</span>
								<LuChevronDown className={`shrink-0 text-[10px] text-(--text-muted) transition-transform ${open ? "rotate-180" : ""}`} />
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
									onPlayerSelect={openMatchPlayerProfile}
								/>
							</div>
						)}
					</div>
				);
			})}
		</SectionCard>
	);
};
