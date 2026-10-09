import { invoke } from "@tauri-apps/api/core";
import { FriendMatchHistory } from "@/components/friends/friend-competitive-history";
import { initialSeasonId } from "@/components/live-game/act-rank";
import { ActRankPanel } from "@/components/live-game/act-rank-panel";
import { LoginRequiredPanel } from "@/components/login-required-panel";
import { RankShieldBadge } from "@/components/rank-shield-badge";
import { CareerAccountStatus } from "@/components/career-account-status";
import { PageHeader, PageSplit, pageBodyClass } from "@/components/section-card";
import type { CompetitiveSeason } from "@/types/live-game";
import { rateLimitedSeconds } from "@/util/rate-limit";
import { getSeasonAssets, getTiers, type SeasonAsset, type TierAsset } from "@/util/valorant-assets";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { LuTrophy } from "react-icons/lu";
import { normalizeCareerMatches } from "./player-career-history";

type CareerData = {
	puuid: string;
	riotId: string | null;
	mmr: any;
	competitiveUpdates: any;
	matchHistory: any;
	currentSeasonId: string | null;
	competitiveSeasons: CompetitiveSeason[];
	rankShields: 0 | 1 | 2 | null;
	accountLevel: { level: number; xp: number } | null;
};

// Every account level costs the same amount of XP.
const XP_PER_LEVEL = 5000;

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
			className="shrink-0 object-contain"
			style={{ width: size, height: size }}
		/>
	);
};

const PlayerCareer = () => {
	const [data, setData] = useState<CareerData | null>(null);
	// Bumped when the login panel sees a Riot Client appear, so the fetch
	// below re-runs without the user having to leave and re-enter the page.
	const [reloadKey, setReloadKey] = useState(0);
	const [tiers, setTiers] = useState<Map<number, TierAsset>>(new Map());
	const [seasons, setSeasons] = useState<Map<string, SeasonAsset>>(new Map());
	const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const { t } = useTranslation();

	useEffect(() => {
		let cancelled = false;
		Promise.all([getTiers(), getSeasonAssets()]).then(([tierAssets, seasonAssets]) => {
			if (cancelled) return;
			setTiers(tierAssets);
			setSeasons(seasonAssets);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
const onResponse = (message: any) => {

			const response = message;
			if (!response.success) {
				if (response.code === "loginRequired") {
					setLoginRequired(true);
					setLoading(false);
					return;
				}
				const throttled = rateLimitedSeconds(response);
				setError(
					throttled === null
						? response.error ?? t("career.failedToLoad")
						: t("common.rateLimited", { seconds: throttled }),
				);
				setLoading(false);
				return;
			}
			// A retry got through — drop the signed-out state so the panel makes way
			// for the content instead of hiding a successful load behind it.
			setLoginRequired(false);
			setError(null);
			setData({
				puuid: response.puuid,
				riotId: response.riotId ?? null,
				mmr: response.mmr,
				competitiveUpdates: response.competitiveUpdates,
				matchHistory: response.matchHistory,
				currentSeasonId: response.currentSeasonId ?? null,
				competitiveSeasons: response.competitiveSeasons ?? [],
				rankShields: response.rankShields ?? null,
				accountLevel: response.accountLevel ?? null,
			});
			setLoading(false);
		};

		let active = true;

		invoke<any>("career_get").then(reply => { if (active) onResponse(reply); }).catch(error => { if (active) onResponse({ success: false, error: String(error) }); });

		return () => { active = false; };
}, [t, reloadKey]);

	const competitiveMatches: any[] = data?.competitiveUpdates?.Matches ?? [];
	const matches = useMemo(
		() => normalizeCareerMatches(data?.matchHistory, data?.competitiveUpdates),
		[data?.matchHistory, data?.competitiveUpdates],
	);
	const seasonStarts = useMemo(
		() => new Map([...seasons].map(([id, season]) => [id, season.startMillis])),
		[seasons],
	);
	useEffect(() => {
		if (!data) return;
		setSelectedSeasonId(initialSeasonId(data.competitiveSeasons, data.currentSeasonId, seasonStarts));
	}, [data, seasonStarts]);
	const latest = competitiveMatches[0];
	const currentTier: number = latest?.TierAfterUpdate ?? 0;
	const currentRR: number = latest?.RankedRatingAfterUpdate ?? 0;
	const color = tierColor(currentTier);

	const ready = !loading && !error && !loginRequired && data;

	return (
		<div className="flex h-full flex-col animate-fade-in">
			<PageHeader
				icon={<LuTrophy className="text-lg" />}
				title={t("career.title")}
				subtitle={ready ? data.riotId ?? t("career.subtitle") : undefined}
			/>

			{!ready && (
				<div className={pageBodyClass}>
					{loading && (
						<div className="flex flex-1 items-center justify-center text-[12px] text-(--text-muted)">{t("career.loading")}</div>
					)}

					{!loading && loginRequired && (
						<LoginRequiredPanel
							onRetry={() => setReloadKey((key) => key + 1)}
							icon={<LuTrophy />}
							title={t("career.loginRequired")}
							description={t("career.loginRequiredDesc")}
						/>
					)}

					{!loading && error && !loginRequired && (
						<div className="panel px-4 py-3">
							<p className="text-[12px] font-semibold text-(--signal-neg)">{t("career.failedToLoad")}</p>
							<p className="mt-0.5 text-[11px] text-(--text-muted)">{error}</p>
						</div>
					)}
				</div>
			)}

			{ready && (
				<PageSplit
					aside={
						<>
						<section
							aria-label={t("career.currentRank")}
							className="flex flex-col items-center gap-2 rounded-[12px] border border-(--border) bg-(--surface) px-4 pt-5 pb-4 text-center"
						>
							<span className="text-[10px] font-medium tracking-[0.08em] text-(--text-muted) uppercase">
								{t("career.currentRank")}
							</span>
							{currentTier === 0 ? (
								<p className="py-4 text-[20px] font-semibold text-(--text-secondary)">{t("career.unranked")}</p>
							) : (
								<>
									<RankBadge tier={currentTier} tiers={tiers} size={88} large />
									<p className="text-[20px] leading-tight font-semibold" style={{ color }}>{tierName(currentTier)}</p>
									<div className="flex items-center gap-2">
										<span className="tabular-nums text-[12px] text-(--text-secondary)">{currentRR} RR</span>
										<RankShieldBadge tier={currentTier} remaining={data.rankShields} />
									</div>
									<div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-(--control)">
										<div className="h-full rounded-full transition-all duration-700" style={{ width: `${currentRR}%`, background: color }} />
									</div>
									<p className="text-[11px] text-(--text-muted)">{t("career.rrToNext", { rr: currentRR })}</p>
								</>
							)}
							{data.accountLevel && (
								<div className="mt-2 w-full border-t border-(--border) pt-3">
									<div className="flex items-baseline justify-between">
										<span className="text-[10px] font-medium tracking-[0.08em] text-(--text-muted) uppercase">
											{t("career.accountLevel")}
										</span>
										<span className="tabular-nums text-[14px] font-semibold text-(--text-primary)">
											{data.accountLevel.level}
										</span>
									</div>
									<div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-(--control)">
										<div
											className="h-full rounded-full bg-(--text-secondary)"
											style={{ width: `${Math.min(100, (data.accountLevel.xp / XP_PER_LEVEL) * 100)}%` }}
										/>
									</div>
									<p className="mt-1 text-left text-[11px] tabular-nums text-(--text-muted)">
										{t("career.accountXp", {
											xp: data.accountLevel.xp.toLocaleString(),
											total: XP_PER_LEVEL.toLocaleString(),
										})}
									</p>
								</div>
							)}
						</section>
						<CareerAccountStatus puuid={data.puuid} />
						</>
					}
				>
					<ActRankPanel
						defaultExpanded
						competitiveSeasons={data.competitiveSeasons}
						assets={{ seasons }}
						selectedSeasonId={selectedSeasonId}
						onSeasonChange={setSelectedSeasonId}
					/>

					<FriendMatchHistory puuid={data.puuid} matches={matches} />
				</PageSplit>
			)}
		</div>
	);
};

export default PlayerCareer;
