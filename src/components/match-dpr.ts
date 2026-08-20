import type { MatchPlayer } from "@/types/matches";

/** Damage / rounds. Cached matches from before `dpr` still have `adr`. */
export const formatDpr = (player: Pick<MatchPlayer, "dpr" | "adr" | "damage" | "roundsPlayed">) => {
	const value =
		typeof player.dpr === "number" && Number.isFinite(player.dpr)
			? player.dpr
			: typeof player.adr === "number" && Number.isFinite(player.adr)
				? player.adr
				: player.damage / Math.max(player.roundsPlayed, 1);
	return String(Math.round(value));
};
