import type { TeamMatchup } from "./live-game-metrics";
import { useTranslation } from "react-i18next";

type Metric = "kd" | "winRate" | "acs";

const formatMetric = (metric: Metric, value: number) => {
	if (metric === "kd") return value.toFixed(2);
	if (metric === "winRate") return `${value.toFixed(0)}%`;
	return value.toFixed(0);
};

const MetricValue = ({ value, metric, side }: { value: number | null; metric: Metric; side: "ally" | "enemy" }) => (
	value == null ? (
		<span className="h-7 w-14 rounded bg-white/8 animate-pulse motion-reduce:animate-none" />
	) : (
		<span className={`min-w-14 px-2 py-1 text-center text-sm font-bold tabular-nums text-white ${side === "ally" ? "bg-cyan-600/80" : "bg-red-500/70"}`}>
			{formatMetric(metric, value)}
		</span>
	)
);

export const LiveTeamMatchup = ({ matchup }: { matchup: TeamMatchup }) => {
	const { t } = useTranslation();
	const metrics: Array<{ field: Metric; label: string }> = [
		{ field: "kd", label: t("liveGame.averageKd") },
		{ field: "winRate", label: t("liveGame.averageWinRate") },
		{ field: "acs", label: t("liveGame.averageAcs") },
	];
	return (
		<div className="border-t border-white/6 px-4 py-3 bg-black/10">
			<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
				<div><p className="text-[10px] font-bold uppercase tracking-widest text-white">{t("liveGame.matchup")}</p><p className="text-[9px] uppercase tracking-wider text-gray-600">{t("liveGame.recentFive")}</p></div>
				<p className="text-[10px] text-gray-500">
					<span className="text-cyan-300">{t("liveGame.ally")}: {matchup.ally.players}</span>
					<span className="mx-2 text-gray-700">/</span>
					<span className="text-red-300">{t("liveGame.enemy")}: {matchup.enemy.players}</span>
				</p>
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
				{metrics.map(({ field, label }) => {
					const ready = matchup.ally[field] != null && matchup.enemy[field] != null;
					return (
						<div key={field} className="min-w-0 flex items-center justify-center gap-2 rounded-lg border border-white/6 bg-white/2 px-2 py-2">
							<MetricValue value={ready ? matchup.ally[field] : null} metric={field} side="ally" />
							<span className="min-w-0 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</span>
							<MetricValue value={ready ? matchup.enemy[field] : null} metric={field} side="enemy" />
						</div>
					);
				})}
			</div>
		</div>
	);
};
