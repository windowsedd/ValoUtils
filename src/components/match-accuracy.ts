import type { MatchPlayer } from "@/types/matches";

export type ShotZone = "head" | "body" | "legs";

export type ShotAccuracyZone = {
	zone: ShotZone;
	hits: number;
	percent: number;
};

export type ShotAccuracy = {
	total: number;
	zones: ShotAccuracyZone[];
};

export const shotAccuracy = (
	player: Pick<MatchPlayer, "headshots" | "bodyshots" | "legshots">,
): ShotAccuracy => {
	const zones: ShotAccuracyZone[] = [
		{ zone: "head", hits: player.headshots, percent: 0 },
		{ zone: "body", hits: player.bodyshots, percent: 0 },
		{ zone: "legs", hits: player.legshots, percent: 0 },
	];
	const total = zones.reduce((sum, zone) => sum + zone.hits, 0);
	if (total > 0) {
		for (const zone of zones) zone.percent = (zone.hits / total) * 100;
	}
	return { total, zones };
};

export const formatShotPercent = (percent: number) => `${percent.toFixed(2)}%`;
