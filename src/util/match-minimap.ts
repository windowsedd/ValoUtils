import type { GamePoint, TimelineKill, TimelineRound } from "@/types/matches";
import type { MinimapAsset } from "@/util/valorant-assets";

/**
 * Game coordinates -> a 0..1 fraction of the minimap image, using the
 * multipliers valorant-api.com publishes per map. The axes are swapped: the
 * game's Y drives the image's horizontal position.
 */
export const minimapPoint = (minimap: MinimapAsset, point: GamePoint): GamePoint => ({
	x: point.y * minimap.xMultiplier + minimap.xScalarToAdd,
	y: point.x * minimap.yMultiplier + minimap.yScalarToAdd,
});

/** Whether a projected point lands on the image (with a little slack at the edges). */
export const onMinimap = (point: GamePoint) =>
	point.x >= -0.05 && point.x <= 1.05 && point.y >= -0.05 && point.y <= 1.05;

/** Round time as m:ss. */
export const formatRoundTime = (millis: number) => {
	const seconds = Math.max(0, Math.floor(millis / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The planted spike is visible only after the plant at the selected moment. */
export const visiblePlant = (round: TimelineRound, kill?: TimelineKill) =>
	round.plant && (!kill || round.plant.time <= kill.time) ? round.plant : null;

/**
 * Players still alive just before `kill`: everyone not killed earlier in the
 * round. Riot's `playerLocations` already omits the dead, so this only matters
 * for labelling the victim, who is listed there at the moment they die.
 */
export const deadBefore = (round: TimelineRound, kill: TimelineKill): Set<string> => {
	const dead = new Set<string>();
	for (const earlier of round.kills) {
		if (earlier === kill) break;
		if (earlier.victim) dead.add(earlier.victim);
	}
	return dead;
};

/** The ability slot a kill's `damageItem` names, matching `AgentAsset.abilities` keys. */
export const abilitySlot = (damageItem: string) => {
	const item = damageItem.toLowerCase();
	if (item === "grenadeability") return "grenade";
	return item;
};
