import { ActRankPanel } from "@/components/live-game/act-rank-panel";
import { initialSeasonId, seasonFallbackLabel } from "@/components/live-game/act-rank";
import { PreviousActsPanel } from "@/components/live-game/previous-acts-panel";
import { PageHeader } from "@/components/section-card";
import type { FriendProfileData, FriendProfileResponse } from "@/types/friend-profile";
import type { Friend } from "@/types/friends";
import { getSeasonAssets, type CardAsset, type SeasonAsset, type TierAsset } from "@/util/valorant-assets";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowLeft, LuRotateCw, LuUser } from "react-icons/lu";
import { acceptedFriendProfile } from "./friend-profile-state";
import { FriendMatchHistory } from "./friend-competitive-history";

type Props = {
	friend: Friend;
	card?: CardAsset | null;
	tiers: Map<number, TierAsset>;
	presenceLabel: string;
	cachedProfile?: FriendProfileData;
	onProfileLoaded: (puuid: string, profile: FriendProfileData) => void;
	onBack?: () => void;
	embedded?: boolean;
};

export const FriendProfile = ({ friend, card, tiers, presenceLabel, cachedProfile, onProfileLoaded, onBack, embedded = false }: Props) => {
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
		if (!window.Main || embedded) return;
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
	}, [cachedProfile, embedded, friend.puuid, onProfileLoaded, requestProfile, t]);

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
	const color = tier > 0 ? tierColor(tier) : "var(--text-muted)";
	const peakTier = profile?.peakTier ?? 0;
	const peakRankIcon = peakTier > 0 ? tiers.get(peakTier)?.largeIcon ?? tiers.get(peakTier)?.icon : null;
	const peakColor = peakTier > 0 ? tierColor(peakTier) : "var(--text-muted)";
	const peakSeasonLabel = profile?.peakSeasonId
		? seasons.get(profile.peakSeasonId.toLowerCase())?.label ?? seasonFallbackLabel(profile.peakSeasonId)
		: null;
	const displayName = friend.gameName ? `${friend.gameName}${friend.tagLine ? `#${friend.tagLine}` : ""}` : friend.displayName;

	return (
		<div className={`flex min-h-0 flex-col ${embedded ? "" : "h-full animate-fade-in"}`}>
			{!embedded && (
				<PageHeader
					icon={
						<button type="button" onClick={onBack} title={t("friends.profileBack")} aria-label={t("friends.profileBack")} className="grid h-8 w-8 place-items-center rounded-[6px] border border-(--border) bg-(--control) text-(--text-muted) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]">
							<LuArrowLeft />
						</button>
					}
					title={displayName}
					subtitle={presenceLabel}
				>
					<button type="button" onClick={requestProfile} disabled={loading} title={t("friends.profileRefresh")} aria-label={t("friends.profileRefresh")} className="grid h-8 w-8 place-items-center rounded-[6px] border border-(--border) bg-(--control) text-(--text-muted) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:opacity-40 focus-visible:outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]">
						<LuRotateCw className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
					</button>
				</PageHeader>
			)}

			<div className={`flex min-h-0 flex-col gap-4 ${embedded ? "pb-2" : "flex-1 overflow-y-auto px-6 pt-4 pb-6"}`}>
				<div
					data-friend-profile-summary=""
					className={`flex flex-wrap items-center gap-4 ${embedded ? "panel px-4 py-3" : "panel px-4 py-3"}`}
				>
					<div className="flex min-w-0 flex-1 items-center gap-4">
						{card?.icon ? <img src={card.icon} alt="" className="h-16 w-16 shrink-0 rounded-[8px] object-cover" /> : <span className="grid h-16 w-16 shrink-0 place-items-center rounded-[8px] bg-(--control) text-(--text-muted)"><LuUser /></span>}
						<div className="min-w-0">
							<p className="truncate text-[17px] font-semibold text-(--text-primary)">{displayName}</p>
							{/* Presence already sits in the page header; repeating it here just
							    doubled the same two lines under the name. */}
							{embedded && presenceLabel ? (
								<p className="text-[12px] text-(--text-muted)">{presenceLabel}</p>
							) : null}
						</div>
					</div>

					{profile && (
						<div className="flex w-full flex-wrap items-center gap-4 md:w-auto md:flex-nowrap">
							<div className="flex min-w-40 flex-1 items-center gap-3 border-t border-(--line) pt-3 md:flex-none md:border-l md:border-t-0 md:pl-5 md:pt-0">
								{rankIcon && <img src={rankIcon} alt={tierName(tier)} className="h-12 w-12 shrink-0 object-contain" />}
								<div className="min-w-0">
									<p className="text-[9px] uppercase tracking-widest text-(--text-muted)">{t("friends.profileCurrentRank")}</p>
									<p className="truncate text-[15px] font-semibold" style={{ color }}>{tier > 0 ? tierName(tier) : t("career.unranked")}</p>
									{tier > 0 && <p className="text-[11px] tabular-nums text-(--text-secondary)">{profile.currentRR} / 100 RR</p>}
								</div>
							</div>

							<div className="flex min-w-40 flex-1 items-center gap-3 border-t border-(--line) pt-3 md:flex-none md:border-l md:border-t-0 md:pl-5 md:pt-0">
								{peakRankIcon && <img src={peakRankIcon} alt={tierName(peakTier)} className="h-11 w-11 shrink-0 object-contain" />}
								<div className="min-w-0">
									<p className="text-[9px] uppercase tracking-widest text-(--text-muted)">{t("friends.profilePeakRank")}</p>
									<p className="truncate text-[13px] font-semibold" style={{ color: peakColor }}>{peakTier > 0 ? tierName(peakTier) : t("career.unranked")}</p>
									{peakSeasonLabel && <p className="mt-0.5 text-[10px] text-(--text-muted)">{t("friends.profileEpisodeAct")}: {peakSeasonLabel}</p>}
								</div>
							</div>
						</div>
					)}
				</div>

				{loading && !profile && <div className="grid min-h-48 place-items-center text-[12px] text-(--text-muted)">{t("friends.profileLoading")}</div>}
				{error && !profile && (
					<div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
						<p className="text-[12px] text-(--signal-neg)">{error}</p>
						<button type="button" onClick={requestProfile} className="h-8 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[12px] font-medium text-(--text-primary) transition-colors hover:bg-(--surface-hover)">{t("friends.profileRetry")}</button>
					</div>
				)}

				{profile && (
					<>
						<ActRankPanel
							defaultExpanded
							competitiveSeasons={profile.competitiveSeasons}
							assets={{ seasons }}
							selectedSeasonId={selectedSeasonId}
							onSeasonChange={setSelectedSeasonId}
						/>
						<PreviousActsPanel
							competitiveSeasons={profile.competitiveSeasons}
							currentSeasonId={profile.currentSeasonId}
							assets={{ seasons, tiers }}
						/>

						<FriendMatchHistory puuid={friend.puuid} matches={profile.matches} />
					</>
				)}
			</div>
		</div>
	);
};
