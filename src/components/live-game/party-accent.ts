/**
 * Colours that mark detected parties in the live roster.
 *
 * Kept out of the table component so the rule can be tested without pulling in
 * i18n and the rest of the page.
 */
const PARTY_COLORS = ["#22d3ee", "#f59e0b", "#a78bfa", "#34d399", "#fb7185"];

export const partyColor = (party: string) => {
	const number = Number.parseInt(party.replace(/\D/g, ""), 10) || 1;
	return PARTY_COLORS[(number - 1) % PARTY_COLORS.length];
};

/**
 * The row's left edge marks a *party*, not a team.
 *
 * It used to fall back to the team colour, which put a full-strength bar on
 * every row — so the one thing the edge could say at a glance, "these two
 * queued together", was drowned out by ten identical bars. The team is already
 * named and coloured by the group header above the rows. Unpartied rows keep a
 * transparent border so their text stays on the same x-position.
 */
export const rowAccentColor = (party: string | null) =>
	party ? partyColor(party) : "transparent";
