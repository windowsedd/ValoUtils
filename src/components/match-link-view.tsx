import { useEffect, useMemo } from "react";
import { MatchScoreboard, useMatchAssets, useMatchDetails } from "@/components/match-scoreboard";

/**
 * A match's full scoreboard by ID, for `valoutils://match?id=...` links.
 * Uses the same `match_details` request and cache as the Matches page.
 */
export const MatchLinkView = ({ matchId }: { matchId: string }) => {
	const { details, errors, ensure } = useMatchDetails();
	const match = details[matchId];
	const loaded = useMemo(() => (match ? [match] : []), [match]);
	const assets = useMatchAssets(loaded);

	useEffect(() => {
		ensure(matchId);
	}, [matchId, ensure]);

	return (
		<div data-match-link={matchId}>
			<MatchScoreboard details={match} assets={assets} loading={!match && !errors[matchId]} error={errors[matchId]} copyPuuid />
		</div>
	);
};
