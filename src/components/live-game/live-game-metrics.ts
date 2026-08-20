import type { LivePlayer, RecentStatsState } from "@/types/live-game";

export type TeamMetricSide = {
	teamId: string;
	players: number;
	kd: number | null;
	winRate: number | null;
	acs: number | null;
	dpr: number | null;
};

export type TeamMatchup = {
	ally: TeamMetricSide;
	enemy: TeamMetricSide;
};

const averageSide = (
	teamId: string,
	players: LivePlayer[],
	recent: Record<string, RecentStatsState>,
): TeamMetricSide => {
	const ready = players
		.map((player) => recent[player.puuid])
		.filter((state): state is Extract<RecentStatsState, { status: "ready" }> => state?.status === "ready");
	if (ready.length === 0) return { teamId, players: 0, kd: null, winRate: null, acs: null, dpr: null };
	const average = (field: "kd" | "winRate" | "acs" | "dpr") =>
		ready.reduce((sum, state) => sum + (state.stats[field] ?? 0), 0) / ready.length;
	return {
		teamId,
		players: ready.length,
		kd: average("kd"),
		winRate: average("winRate"),
		acs: average("acs"),
		dpr: average("dpr"),
	};
};

export const buildTeamMatchup = (
	players: LivePlayer[],
	recent: Record<string, RecentStatsState>,
): TeamMatchup | null => {
	const self = players.find((player) => player.isSelf && player.teamId);
	if (!self?.teamId) return null;
	const enemy = players.find((player) => player.teamId && player.teamId !== self.teamId);
	if (!enemy?.teamId) return null;
	return {
		ally: averageSide(self.teamId, players.filter((player) => player.teamId === self.teamId), recent),
		enemy: averageSide(enemy.teamId, players.filter((player) => player.teamId === enemy.teamId), recent),
	};
};
