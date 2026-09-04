import type { LivePlayer } from "@/types/live-game";

/**
 * Team id of the signed-in player, or null when we can't tell.
 *
 * Pregame reports teams as "Ally"/"Enemy", so which side is ours is implicit in
 * the name. Coregame reports "Blue"/"Red" instead, where it isn't — hence this.
 */
export const selfTeamId = (players: readonly LivePlayer[]): string | null =>
	players.find((player) => player.isSelf)?.teamId ?? null;

/**
 * Order team ids so the player's own team comes first.
 *
 * A fixed "Blue then Red" order shows the enemy on top for every player who
 * happens to be on Red. Anchoring on the self player keeps our team at the top
 * of the scoreboard regardless of which side the match assigned us. Ids we
 * can't place (the "all" bucket used before teams are known) sink to the end,
 * and ordering is otherwise stable.
 */
export const orderTeamsSelfFirst = <T>(
	entries: readonly T[],
	teamIdOf: (entry: T) => string,
	self: string | null,
): T[] => {
	const rank = (id: string) => {
		if (id === "all") return 2;
		if (self) return id === self ? 0 : 1;
		// No self player (spectator, or roster still resolving) — fall back to
		// Riot's own naming so the order stays deterministic.
		return id === "Ally" || id === "Blue" ? 0 : id === "Enemy" || id === "Red" ? 1 : 2;
	};
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => rank(teamIdOf(a.entry)) - rank(teamIdOf(b.entry)) || a.index - b.index)
		.map(({ entry }) => entry);
};

export const groupPlayersByParty = (players: readonly LivePlayer[]): LivePlayer[] => {
	const members = new Map<string, LivePlayer[]>();
	for (const player of players) {
		if (!player.party) continue;
		const group = members.get(player.party) ?? [];
		group.push(player);
		members.set(player.party, group);
	}

	const emitted = new Set<string>();
	const result: LivePlayer[] = [];
	for (const player of players) {
		if (!player.party) {
			result.push(player);
			continue;
		}
		if (emitted.has(player.party)) continue;
		emitted.add(player.party);
		result.push(...(members.get(player.party) ?? []));
	}
	return result;
};
