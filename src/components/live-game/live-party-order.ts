import type { LivePlayer } from "@/types/live-game";

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
