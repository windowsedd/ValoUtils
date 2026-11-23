import { useCallback, useEffect, useState } from "react";
import { FriendProfile } from "@/components/friends/friend-profile";
import type { FriendProfileData } from "@/types/friend-profile";
import type { Friend } from "@/types/friends";
import { onPlayerPage, type PlayerPageTarget } from "@/util/deep-links";
import { getTiers, type TierAsset } from "@/util/valorant-assets";

const asFriend = (player: PlayerPageTarget): Friend => ({
	puuid: player.subject,
	gameName: player.gameName ?? "",
	tagLine: player.tagLine ?? "",
	displayName: player.gameName ? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ""}` : "",
	region: "",
	note: "",
	lastOnline: null,
	state: "",
	product: "",
	isOnline: false,
	playing: false,
	valorant: null,
});

/**
 * A player's profile as a full page laid over the current one (View profile on a
 * scoreboard), so Back returns to exactly where you were: the page underneath
 * stays mounted. Profiles opened from inside one stack up; Back pops one. The
 * router keys this by route, so switching pages closes it.
 */
export const PlayerPageOverlay = () => {
	const [stack, setStack] = useState<PlayerPageTarget[]>([]);
	const [tiers, setTiers] = useState<Map<number, TierAsset>>(new Map());
	const [profiles, setProfiles] = useState<Record<string, FriendProfileData>>({});

	useEffect(
		() =>
			onPlayerPage((player) =>
				setStack((current) =>
					current[current.length - 1]?.subject.toLowerCase() === player.subject.toLowerCase() ? current : [...current, player],
				),
			),
		[],
	);
	const open = stack.length > 0;
	useEffect(() => {
		if (!open || tiers.size > 0) return;
		let cancelled = false;
		getTiers()
			.then((assets) => !cancelled && setTiers(assets))
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [open, tiers.size]);
	const back = useCallback(() => setStack((current) => current.slice(0, -1)), []);
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) back();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, back]);
	const cache = useCallback(
		(puuid: string, profile: FriendProfileData) =>
			setProfiles((current) => ({ ...current, [puuid.toLowerCase()]: profile })),
		[],
	);

	const player = stack[stack.length - 1];
	if (!player) return null;
	return (
		<div data-player-page="" className="absolute inset-0 z-20 bg-(--background)">
			<FriendProfile
				key={player.subject}
				friend={asFriend(player)}
				tiers={tiers}
				presenceLabel=""
				cachedProfile={profiles[player.subject.toLowerCase()]}
				onProfileLoaded={cache}
				onBack={back}
			/>
		</div>
	);
};
