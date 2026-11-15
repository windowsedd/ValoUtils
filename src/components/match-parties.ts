/**
 * "Party N" numbers for a finished match: players who share a `partyId` with
 * at least one other player, numbered in roster order. Solo players are left
 * out, so the colour only appears where it says "these queued together".
 */
export const matchPartyNumbers = (players: readonly { subject: string; partyId: string }[]) => {
	const sizes = new Map<string, number>();
	for (const player of players) {
		if (player.partyId) sizes.set(player.partyId, (sizes.get(player.partyId) ?? 0) + 1);
	}
	const numbers = new Map<string, number>();
	const bySubject = new Map<string, number>();
	for (const player of players) {
		if (!player.partyId || (sizes.get(player.partyId) ?? 0) < 2) continue;
		if (!numbers.has(player.partyId)) numbers.set(player.partyId, numbers.size + 1);
		bySubject.set(player.subject, numbers.get(player.partyId)!);
	}
	return bySubject;
};
