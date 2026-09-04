import { useDynamicModal } from "@/components/dynamic-modal";
import { FriendMatchHistory } from "@/components/friends/friend-competitive-history";
import { ActRankPanel } from "@/components/live-game/act-rank-panel";
import { initialSeasonId, seasonFallbackLabel } from "@/components/live-game/act-rank";
import type { MatchAssets } from "@/components/match-scoreboard";
import { SectionCard } from "@/components/section-card";
import type { FriendProfileData } from "@/types/friend-profile";
import type { MatchPlayer } from "@/types/matches";
import { getSeasonAssets, localize, type SeasonAsset } from "@/util/valorant-assets";
import { tierColor, tierName } from "@/util/valorant-ranks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuUser } from "react-icons/lu";
import { subscribeMatchPlayerProfile } from "./match-player-profile-modal-state";

const MatchPlayerProfileBody = ({ player, assets }: { player: MatchPlayer; assets: MatchAssets }) => {
	const { t } = useTranslation();
	const [profile, setProfile] = useState<FriendProfileData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [retryVersion, setRetryVersion] = useState(0);
	const [seasons, setSeasons] = useState<Map<string, SeasonAsset>>(new Map());
	const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		getSeasonAssets().then((values) => {
			if (!cancelled) setSeasons(values);
		});
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		setLoading(true);
		setError(null);
		return subscribeMatchPlayerProfile(player.subject, {
			onProfile: (value) => {
				setProfile(value);
				setLoading(false);
			},
			onError: (code, detail) => {
				setError(
					code === "loginRequired"
						? t("friends.profileLoginRequired")
						: detail ?? t("friends.profileFailed"),
				);
				setLoading(false);
			},
		});
	}, [player.subject, retryVersion, t]);

	const seasonStarts = useMemo(
		() => new Map([...seasons].map(([id, season]) => [id, season.startMillis])),
		[seasons],
	);
	useEffect(() => {
		if (!profile) return;
		setSelectedSeasonId(initialSeasonId(profile.competitiveSeasons, profile.currentSeasonId, seasonStarts));
	}, [profile, seasonStarts]);

	const agent = assets.agents.get(player.characterId.toLowerCase());
	const currentTier = profile?.currentTier ?? 0;
	const peakTier = profile?.peakTier ?? 0;
	const currentIcon = currentTier > 0 ? assets.tiers.get(currentTier)?.largeIcon ?? assets.tiers.get(currentTier)?.icon : null;
	const peakIcon = peakTier > 0 ? assets.tiers.get(peakTier)?.icon : null;
	const peakSeason = profile?.peakSeasonId
		? seasons.get(profile.peakSeasonId.toLowerCase())?.label ?? seasonFallbackLabel(profile.peakSeasonId)
		: null;

	if (loading && !profile) {
		return <div className="grid min-h-48 place-items-center text-[12px] text-(--text-muted)">{t("friends.profileLoading")}</div>;
	}

	if (error && !profile) {
		return (
			<div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
				<p className="text-[12px] text-(--signal-neg)">{error}</p>
				<button
					type="button"
					onClick={() => setRetryVersion((value) => value + 1)}
					className="h-8 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[12px] font-medium text-(--text-primary) transition-colors hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:border-(--accent)"
				>
					{t("friends.profileRetry")}
				</button>
			</div>
		);
	}

	if (!profile) return null;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-3 border-b border-(--line) pb-3">
				{agent?.icon ? (
					<img src={agent.icon} alt={localize(agent.name)} className="h-12 w-12 shrink-0 rounded-md object-cover" />
				) : (
					<span className="grid h-12 w-12 shrink-0 place-items-center rounded-[8px] bg-(--control) text-(--text-muted)"><LuUser /></span>
				)}
				<div className="min-w-0">
					<p className="truncate text-[15px] font-semibold text-(--text-primary)">{player.gameName || t("matches.player")}{player.tagLine ? <span className="text-(--text-muted)">#{player.tagLine}</span> : null}</p>
					<p className="text-[11px] text-(--text-muted)">{agent ? localize(agent.name) : t("matches.player")}</p>
				</div>
			</div>

			<SectionCard title={t("friends.profileCurrentRank")} accent={currentTier > 0 ? tierColor(currentTier) : "var(--text-muted)"} right={currentTier > 0 ? `${profile.currentRR} RR` : null}>
				<div className="grid gap-4 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
					<div className="flex min-w-0 items-center gap-4">
						{currentIcon && <img src={currentIcon} alt={tierName(currentTier)} className="h-16 w-16 shrink-0 object-contain" />}
						<div className="min-w-0">
							<p className="truncate text-2xl font-bold" style={{ color: currentTier > 0 ? tierColor(currentTier) : "var(--text-muted)" }}>{currentTier > 0 ? tierName(currentTier) : t("career.unranked")}</p>
							<p className="text-[12px] tabular-nums text-(--text-secondary)">{currentTier > 0 ? `${profile.currentRR} / 100 RR` : "â€”"}</p>
						</div>
					</div>
					<div className="flex min-w-36 items-center gap-3 border-t border-(--line) pt-3 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
						{peakIcon && <img src={peakIcon} alt={tierName(peakTier)} className="h-11 w-11 shrink-0 object-contain" />}
						<div className="min-w-0">
							<p className="text-[9px] uppercase tracking-widest text-(--text-muted)">{t("friends.profilePeakRank")}</p>
							<p className="truncate text-sm font-semibold" style={{ color: peakTier > 0 ? tierColor(peakTier) : "var(--text-muted)" }}>{peakTier > 0 ? tierName(peakTier) : t("career.unranked")}</p>
							{peakSeason && <p className="mt-0.5 text-[10px] text-(--text-muted)">{t("friends.profileEpisodeAct")}: {peakSeason}</p>}
						</div>
					</div>
				</div>
			</SectionCard>

			<ActRankPanel
				defaultExpanded
				competitiveSeasons={profile.competitiveSeasons}
				assets={{ seasons }}
				selectedSeasonId={selectedSeasonId}
				onSeasonChange={setSelectedSeasonId}
			/>

			<FriendMatchHistory
				puuid={player.subject}
				matches={profile.matches}
				playerProfilesEnabled={false}
			/>
		</div>
	);
};

export const useMatchPlayerProfileModal = (assets: MatchAssets) => {
	const { t } = useTranslation();
	const { showModal, closeModal } = useDynamicModal();
	return useCallback((player: MatchPlayer) => {
		const riotId = player.gameName
			? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ""}`
			: t("matches.player");
		showModal({
			title: riotId,
			body: <MatchPlayerProfileBody player={player} assets={assets} />,
			footer: (
				<button type="button" onClick={closeModal} className="h-8 rounded-[6px] border border-(--border) bg-(--control) px-4 text-[12px] font-medium text-(--text-primary) transition-colors hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:border-(--accent)">
					{t("common.close")}
				</button>
			),
		});
	}, [assets, closeModal, showModal, t]);
};
