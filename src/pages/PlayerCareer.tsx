import { FriendMatchHistory } from "@/components/friends/friend-competitive-history";
import { initialSeasonId } from "@/components/live-game/act-rank";
import { ActRankPanel } from "@/components/live-game/act-rank-panel";
import { LoginRequiredPanel } from "@/components/login-required-panel";
import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import type { CompetitiveSeason } from "@/types/live-game";
import { getSeasonAssets, getTiers, type SeasonAsset, type TierAsset } from "@/util/valorant-assets";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { LuTrophy } from "react-icons/lu";
import { normalizeCareerMatches } from "./player-career-history";

type CareerData = {
	puuid: string;
	mmr: any;
	competitiveUpdates: any;
	matchHistory: any;
	currentSeasonId: string | null;
	competitiveSeasons: CompetitiveSeason[];
};

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
		if (!window.Main) return;
		const onResponse = (message: string) => {
			window.Main.removeAllListeners("career:get");
			const response = JSON.parse(message);
			if (!response.success) {
				if (response.code === "loginRequired") {
					setLoginRequired(true);
					setLoading(false);
					return;
				}
				setError(response.error ?? t("career.failedToLoad"));
				setLoading(false);
				return;
			}
			// A retry got through — drop the signed-out state so the panel makes way
			// for the content instead of hiding a successful load behind it.
			setLoginRequired(false);
			setError(null);
			setData({
				puuid: response.puuid,
				mmr: response.mmr,
				competitiveUpdates: response.competitiveUpdates,
				matchHistory: response.matchHistory,
				currentSeasonId: response.currentSeasonId ?? null,
				competitiveSeasons: response.competitiveSeasons ?? [],
			});
			setLoading(false);
		};
		window.Main.on("career:get", onResponse);
		window.Main.send("career:get");
		return () => window.Main.removeAllListeners("career:get");
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

	return (
		<div className="flex h-full flex-col animate-fade-in">
			<PageHeader icon={<LuTrophy className="text-lg" />} title={t("career.title")} />

			<div className={pageBodyClass}>
				{loading && (
					<div className="flex flex-1 items-center justify-center text-sm text-gray-500">{t("career.loading")}</div>
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
					<div className="glass rounded-lg px-4 py-3">
						<p className="text-sm font-semibold text-red-300">{t("career.failedToLoad")}</p>
						<p className="mt-0.5 text-xs text-gray-500">{error}</p>
					</div>
				)}

				{!loading && !error && !loginRequired && data && (
					<>
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
									<div className="min-w-0 flex-1">
										<div className="mb-2.5 flex items-end gap-3">
											<p className="text-3xl font-bold leading-none" style={{ color }}>{tierName(currentTier)}</p>
											<p className="text-base leading-none text-gray-400">{currentRR} RR</p>
										</div>
										<div className="h-1.5 overflow-hidden rounded-full bg-white/10">
											<div className="h-full rounded-full transition-all duration-700" style={{ width: `${currentRR}%`, background: color }} />
										</div>
										<p className="mt-1.5 text-xs text-gray-600">{t("career.rrToNext", { rr: currentRR })}</p>
									</div>
								</div>
							)}
						</SectionCard>

						<ActRankPanel
							defaultExpanded
							competitiveSeasons={data.competitiveSeasons}
							assets={{ seasons }}
							selectedSeasonId={selectedSeasonId}
							onSeasonChange={setSelectedSeasonId}
						/>

						<FriendMatchHistory puuid={data.puuid} matches={matches} />
					</>
				)}
			</div>
		</div>
	);
};

export default PlayerCareer;
