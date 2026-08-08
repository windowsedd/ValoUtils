import { useEffect, useState } from "react";
import { FaArrowUp, FaArrowDown, FaMinus, FaTrophy, FaChevronDown } from "react-icons/fa6";
import { useTranslation } from "react-i18next";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { getMaps, getTiers, localize, type MapAsset, type TierAsset } from "@/util/valorant-assets";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { PageHeader, SectionCard, SectionRow } from "@/components/section-card";
import { MatchScoreboard, useMatchAssets, useMatchDetails } from "@/components/match-scoreboard";

const getMapName = (mapId: string, maps: Map<string, MapAsset>) => mapName(mapId, maps) || "Unknown";

type CareerData = { mmr: any; competitiveUpdates: any };

/** Rank badge image from valorant-api.com, falling back to a coloured dot while it loads. */
const RankBadge = ({
	tier,
	tiers,
	size = 24,
	large = false,
}: { tier: number; tiers: Map<number, TierAsset>; size?: number; large?: boolean }) => {
	if (tier <= 0) return null;
	const asset = tiers.get(tier);
	const icon = large ? asset?.largeIcon ?? asset?.icon : asset?.icon;
	if (!icon) return null;
	return (
		<img
			src={icon}
			alt={tierName(tier)}
			title={tierName(tier)}
			className="object-contain shrink-0"
			style={{ width: size, height: size }}
		/>
	);
};

const PlayerCareer = () => {
	const [data, setData] = useState<CareerData | null>(null);
	const [tiers, setTiers] = useState<Map<number, TierAsset>>(new Map());
	const [maps, setMaps] = useState<Map<string, MapAsset>>(new Map());
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const matchAssets = useMatchAssets();
	const { details, errors, pending, ensure, prefetch } = useMatchDetails();
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const { t } = useTranslation();

	useEffect(() => {
		let cancelled = false;
		getTiers().then((m) => { if (!cancelled) setTiers(m); });
		getMaps().then((m) => { if (!cancelled) setMaps(m); });
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("career:get", (message: string) => {
			window.Main.removeAllListeners("career:get");
			const res = JSON.parse(message);
			if (!res.success) {
				if (res.code === "loginRequired") { setLoginRequired(true); setLoading(false); return; }
				setError(res.error ?? t("career.failedToLoad"));
				setLoading(false);
				return;
			}
			setData({ mmr: res.mmr, competitiveUpdates: res.competitiveUpdates });
			setLoading(false);
		});
		window.Main.send("career:get");
		return () => { window.Main.removeAllListeners("career:get"); };
	}, []);

	const matches: any[] = data?.competitiveUpdates?.Matches ?? [];
	const latest = matches[0];
	const currentTier: number = latest?.TierAfterUpdate ?? 0;
	const currentRR: number = latest?.RankedRatingAfterUpdate ?? 0;
	const color = tierColor(currentTier);

	useEffect(() => {
		const ids = matches.map((m: any) => m.MatchID).filter(Boolean);
		if (ids.length) prefetch(ids);
	}, [matches, prefetch]);

	// Competitive rows carry a MatchID, so the full scoreboard can be pulled in
	// on demand — same panel the Matches tab uses.
	const toggleMatch = (matchId: string) => {
		if (!matchId) return;
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(matchId)) next.delete(matchId);
			else next.add(matchId);
			return next;
		});
		ensure(matchId);
	};

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader icon={<FaTrophy className="text-[#ff4655] text-lg" />} title={t("career.title")}>
				{!loading && !error && !loginRequired && currentTier > 0 && (
					<span className="flex items-center gap-2 text-xs font-semibold" style={{ color }}>
						<RankBadge tier={currentTier} tiers={tiers} size={18} />
						{tierName(currentTier)}
					</span>
				)}
			</PageHeader>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 flex flex-col gap-4">
				{loading && (
					<div className="flex-1 flex items-center justify-center text-gray-500 text-sm">{t("career.loading")}</div>
				)}

				{!loading && loginRequired && (
					<div className="flex-1 flex items-center justify-center">
						<div className="glass p-6 text-center max-w-md flex flex-col items-center gap-2">
							<FaTrophy className="text-3xl text-gray-700 mb-1" />
							<p className="text-white font-semibold">{t("career.loginRequired")}</p>
							<p className="text-gray-500 text-sm">{t("career.loginRequiredDesc")}</p>
						</div>
					</div>
				)}

				{!loading && error && !loginRequired && (
					<div className="glass rounded-2xl px-4 py-3">
						<p className="text-sm text-red-300 font-semibold">{t("career.failedToLoad")}</p>
						<p className="text-xs text-gray-500 mt-0.5">{error}</p>
					</div>
				)}

				{!loading && !error && !loginRequired && (
					<>
						{/* Current rank */}
						<SectionCard
							title={t("career.currentRank")}
							accent={currentTier > 0 ? color : "#6b7280"}
							right={currentTier > 0 ? <span className="tabular-nums">{currentRR} RR</span> : null}
						>
							{currentTier === 0 ? (
								<p className="px-3 py-2 text-2xl font-bold text-gray-400">{t("career.unranked")}</p>
							) : (
								<div className="flex items-center gap-5 px-3 py-1">
									<RankBadge tier={currentTier} tiers={tiers} size={80} large />
									<div className="flex-1 min-w-0">
										<div className="flex items-end gap-3 mb-2.5">
											<p className="text-3xl font-bold leading-none" style={{ color }}>{tierName(currentTier)}</p>
											<p className="text-base text-gray-400 leading-none">{currentRR} RR</p>
										</div>
										{/* RR progress toward the next tier */}
										<div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
											<div
												className="h-full rounded-full transition-all duration-700"
												style={{ width: `${currentRR}%`, background: color }}
											/>
										</div>
										<p className="text-xs text-gray-600 mt-1.5">{t("career.rrToNext", { rr: currentRR })}</p>
									</div>
								</div>
							)}
						</SectionCard>

						{/* Match history */}
						<SectionCard title={t("career.recentMatches")} count={matches.length} accent="#22d3ee">
							{matches.length === 0 ? (
								<div className="flex flex-col items-center justify-center gap-2 py-10 text-gray-500">
									<FaTrophy className="text-4xl opacity-30" />
									<p className="text-sm">{t("career.noMatches")}</p>
								</div>
							) : (
								matches.map((match: any, i: number) => {
									const rr: number = match.RankedRatingEarned ?? 0;
									const tierAfter: number = match.TierAfterUpdate ?? 0;
									const tierBefore: number = match.TierBeforeUpdate ?? 0;
									const promoted = tierAfter > tierBefore;
									const demoted = tierAfter < tierBefore;
									const rrPositive = rr > 0;
									const matchMapName = getMapName(match.MapID ?? "", maps);
									const date = match.MatchStartTime ? new Date(match.MatchStartTime).toLocaleDateString() : "—";
									const col = tierColor(tierAfter);

									const matchId: string = match.MatchID ?? "";
									const isOpen = expanded.has(matchId);
									const selfStats = details[matchId]?.players.find((p) => p.isSelf);
									const thumb = mapIcon(match.MapID ?? "", maps);
									const agent = selfStats ? matchAssets.agents.get(selfStats.characterId.toLowerCase()) : undefined;

									return (
										<div key={matchId || i} className="rounded-xl overflow-hidden">
										<button
											type="button"
											onClick={() => toggleMatch(matchId)}
											aria-expanded={isOpen}
											disabled={!matchId}
											className="w-full text-left disabled:cursor-default"
										>
										<SectionRow>
											{/* Result stripe — green gained RR, red lost, grey flat */}
											<div
												className="w-1 self-stretch rounded-full shrink-0"
												style={{ background: rr > 0 ? "#4ade80" : rr < 0 ? "#f87171" : "#6b7280" }}
											/>

											{thumb ? (
												<img src={thumb} alt="" className="w-16 h-9 rounded object-cover shrink-0" />
											) : (
												<span className="w-16 h-9 rounded bg-white/5 shrink-0" />
											)}

											<div className="flex-1 min-w-0">
												<p className="text-sm font-semibold text-white truncate">{matchMapName}</p>
												<p className="text-xs text-gray-500">{date}</p>
											</div>

											{agent?.icon && (
												<img
													src={agent.icon}
													alt={localize(agent.name)}
													title={localize(agent.name)}
													className="w-7 h-7 rounded shrink-0 hidden sm:block"
												/>
											)}

											{(promoted || demoted) && (
												<span
													className="text-xs font-semibold flex items-center gap-1 px-2 py-0.5 rounded-full shrink-0"
													style={{
														color: promoted ? "#4ade80" : "#f87171",
														background: promoted ? "rgba(74,222,128,0.1)" : "rgba(248,113,113,0.1)",
													}}
												>
													{promoted ? <FaArrowUp className="text-[10px]" /> : <FaArrowDown className="text-[10px]" />}
													{promoted ? t("career.promoted") : t("career.demoted")}
												</span>
											)}

											<div className="flex items-center justify-end gap-2 w-32 shrink-0">
												<RankBadge tier={tierAfter} tiers={tiers} size={22} />
												<p className="text-sm font-semibold text-right truncate" style={{ color: col }}>
													{tierName(tierAfter)}
												</p>
											</div>

											{/* Filled in by the background prefetch */}
											<div className="w-20 text-right shrink-0 hidden md:block">
												{selfStats ? (
													<p className="text-xs tabular-nums text-gray-300">
														{selfStats.kills} / {selfStats.deaths} / {selfStats.assists}
													</p>
												) : (
													<p className="text-xs text-gray-700">—</p>
												)}
											</div>
											<div className="w-14 text-right shrink-0 hidden md:block">
												{selfStats ? (
													<p className="text-xs tabular-nums text-gray-400">
														{selfStats.headshotPercent.toFixed(0)}%
													</p>
												) : (
													<p className="text-xs text-gray-700">—</p>
												)}
											</div>

											<div className="flex items-center gap-1 w-16 justify-end shrink-0">
												{rr === 0 ? (
													<FaMinus className="text-gray-500 text-xs" />
												) : (
													<span
														className="font-bold text-sm tabular-nums"
														style={{ color: rrPositive ? "#4ade80" : "#f87171" }}
													>
														{rrPositive ? "+" : ""}{rr} RR
													</span>
												)}
											</div>
											<FaChevronDown
												className={`text-gray-700 text-[10px] shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
											/>
										</SectionRow>
										</button>
										{isOpen && (
											<div className="px-3 pb-3 pt-1">
												<MatchScoreboard
													details={details[matchId]}
													assets={matchAssets}
													loading={pending.has(matchId)}
													error={errors[matchId]}
												/>
											</div>
										)}
										</div>
									);
								})
							)}
						</SectionCard>
					</>
				)}
			</div>
		</div>
	);
};

export default PlayerCareer;
