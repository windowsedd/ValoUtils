import { ActRankPanel } from "@/components/live-game/act-rank-panel";
import { initialSeasonId, seasonFallbackLabel } from "@/components/live-game/act-rank";
import { PageHeader, SectionCard } from "@/components/section-card";
import type { FriendProfileData, FriendProfileResponse } from "@/types/friend-profile";
import type { Friend } from "@/types/friends";
import { getSeasonAssets, type CardAsset, type SeasonAsset, type TierAsset } from "@/util/valorant-assets";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaArrowLeft, FaArrowRotateRight, FaUser } from "react-icons/fa6";
import { acceptedFriendProfile } from "./friend-profile-state";
import { FriendMatchHistory } from "./friend-competitive-history";

type Props = {
	friend: Friend;
	card?: CardAsset | null;
	tiers: Map<number, TierAsset>;
	presenceLabel: string;
	cachedProfile?: FriendProfileData;
	onProfileLoaded: (puuid: string, profile: FriendProfileData) => void;
	onBack: () => void;
};

export const FriendProfile = ({ friend, card, tiers, presenceLabel, cachedProfile, onProfileLoaded, onBack }: Props) => {
	const { t } = useTranslation();
	const [profile, setProfile] = useState<FriendProfileData | null>(cachedProfile ?? null);
	const [loading, setLoading] = useState(!cachedProfile);
	const [error, setError] = useState<string | null>(null);
	const [seasons, setSeasons] = useState<Map<string, SeasonAsset>>(new Map());
	const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		getSeasonAssets().then((assets) => !cancelled && setSeasons(assets));
		return () => { cancelled = true; };
	}, []);

	const requestProfile = useCallback(() => {
		setLoading(true);
		setError(null);
		window.Main.send("friend:profile:get", friend.puuid);
	}, [friend.puuid]);

	useEffect(() => {
		if (!window.Main) return;
		const onResponse = (message: string) => {
			let response: FriendProfileResponse;
			try {
				response = JSON.parse(message) as FriendProfileResponse;
			} catch {
				setLoading(false);
				setError(t("friends.profileFailed"));
				return;
			}
			const accepted = acceptedFriendProfile(friend.puuid, response);
			if (accepted) {
				setProfile(accepted);
				onProfileLoaded(friend.puuid, accepted);
				setError(null);
				setLoading(false);
				return;
			}
			if (!response.success) {
				setError(response.code === "loginRequired" ? t("friends.profileLoginRequired") : response.error ?? t("friends.profileFailed"));
				setLoading(false);
			}
		};
		window.Main.on("friend:profile:get", onResponse);
		if (!cachedProfile) requestProfile();
		return () => window.Main.removeListener("friend:profile:get", onResponse);
	}, [cachedProfile, friend.puuid, onProfileLoaded, requestProfile, t]);

	const seasonStarts = useMemo(
		() => new Map([...seasons].map(([id, season]) => [id, season.startMillis])),
		[seasons],
	);
	useEffect(() => {
		if (!profile) return;
		setSelectedSeasonId(initialSeasonId(profile.competitiveSeasons, profile.currentSeasonId, seasonStarts));
	}, [profile, seasonStarts]);

	const tier = profile?.currentTier ?? 0;
	const rankIcon = tier > 0 ? tiers.get(tier)?.largeIcon ?? tiers.get(tier)?.icon : null;
	const color = tier > 0 ? tierColor(tier) : "#6b7280";
	const peakTier = profile?.peakTier ?? 0;
	const peakRankIcon = peakTier > 0 ? tiers.get(peakTier)?.largeIcon ?? tiers.get(peakTier)?.icon : null;
	const peakColor = peakTier > 0 ? tierColor(peakTier) : "#6b7280";
	const peakSeasonLabel = profile?.peakSeasonId
		? seasons.get(profile.peakSeasonId.toLowerCase())?.label ?? seasonFallbackLabel(profile.peakSeasonId)
		: null;
	const displayName = friend.gameName ? `${friend.gameName}${friend.tagLine ? `#${friend.tagLine}` : ""}` : friend.displayName;

	return (
		<div className="flex h-full min-h-0 flex-col animate-fade-in">
			<PageHeader
				icon={
					<button type="button" onClick={onBack} title={t("friends.profileBack")} aria-label={t("friends.profileBack")} className="grid h-10 w-10 place-items-center rounded-md border border-white/10 text-gray-400 hover:bg-white/6 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
						<FaArrowLeft />
					</button>
				}
				title={displayName}
				subtitle={presenceLabel}
			>
				<button type="button" onClick={requestProfile} disabled={loading} title={t("friends.profileRefresh")} aria-label={t("friends.profileRefresh")} className="grid h-10 w-10 place-items-center rounded-md border border-white/10 text-gray-400 hover:bg-white/6 hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
					<FaArrowRotateRight className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
				</button>
			</PageHeader>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
				<div className="flex items-center gap-4 border-b border-white/6 pb-4">
					{card?.icon ? <img src={card.icon} alt="" className="h-16 w-16 shrink-0 rounded-md object-cover" /> : <span className="grid h-16 w-16 shrink-0 place-items-center rounded-md bg-white/5 text-gray-600"><FaUser /></span>}
					<div className="min-w-0">
						<p className="truncate text-xl font-bold text-white">{displayName}</p>
						<p className="text-sm text-gray-500">{presenceLabel}</p>
					</div>
				</div>

				{loading && !profile && <div className="grid min-h-48 place-items-center text-sm text-gray-500">{t("friends.profileLoading")}</div>}
				{error && !profile && (
					<div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
						<p className="text-sm text-red-300">{error}</p>
						<button type="button" onClick={requestProfile} className="rounded-md border border-white/10 px-3 py-2 text-sm text-gray-200 hover:bg-white/6">{t("friends.profileRetry")}</button>
					</div>
				)}

				{profile && (
					<>
						<SectionCard title={t("friends.profileCurrentRank")} accent={color} right={tier > 0 ? `${profile.currentRR} RR` : null}>
							<div className="grid gap-4 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
								<div className="flex min-w-0 items-center gap-4">
									{rankIcon && <img src={rankIcon} alt={tierName(tier)} className="h-16 w-16 shrink-0 object-contain" />}
									<div className="min-w-0 flex-1">
										<p className="truncate text-2xl font-bold" style={{ color }}>{tier > 0 ? tierName(tier) : t("career.unranked")}</p>
										<p className="text-sm tabular-nums text-gray-400">{tier > 0 ? `${profile.currentRR} / 100 RR` : "—"}</p>
										<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, profile.currentRR))}%`, background: color }} /></div>
									</div>
								</div>
								<div className="flex min-w-36 items-center gap-3 border-t border-white/6 pt-3 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
									{peakRankIcon && <img src={peakRankIcon} alt={tierName(peakTier)} className="h-11 w-11 shrink-0 object-contain" />}
									<div className="min-w-0">
										<p className="text-[9px] uppercase tracking-widest text-gray-600">{t("friends.profilePeakRank")}</p>
										<p className="truncate text-sm font-semibold" style={{ color: peakColor }}>{peakTier > 0 ? tierName(peakTier) : t("career.unranked")}</p>
										{peakSeasonLabel && <p className="mt-0.5 text-[10px] text-gray-500">{t("friends.profileEpisodeAct")}: {peakSeasonLabel}</p>}
									</div>
								</div>
							</div>
						</SectionCard>

						<ActRankPanel
							competitiveSeasons={profile.competitiveSeasons}
							assets={{ seasons }}
							selectedSeasonId={selectedSeasonId}
							onSeasonChange={setSelectedSeasonId}
						/>

						<FriendMatchHistory puuid={friend.puuid} matches={profile.matches} />
					</>
				)}
			</div>
		</div>
	);
};
