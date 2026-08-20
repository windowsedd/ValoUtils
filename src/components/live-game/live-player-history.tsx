import type { RecentMatchSummary } from "@/types/live-game";
import { localize } from "@/util/valorant-assets";
import { mapIcon, mapName } from "@/util/valorant-maps";
import { useTranslation } from "react-i18next";
import type { LiveGameAssets } from "./use-live-game-assets";

export const LivePlayerHistory = ({ history, assets }: { history: RecentMatchSummary[]; assets: LiveGameAssets }) => {
	const { t, i18n } = useTranslation();
	const rows = [...history].sort((a, b) => b.startMillis - a.startMillis).slice(0, 5);
	const formatDate = (millis: number) => millis > 0
		? new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(millis))
		: t("liveGame.unavailable");
	return (
		<div className="lg:col-span-2 rounded-xl border border-white/6 bg-white/2 overflow-hidden">
			<div className="px-3 py-2 border-b border-white/6"><p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">{t("liveGame.recentHistory")}</p></div>
			{rows.length === 0 ? <p className="px-3 py-5 text-center text-xs text-gray-600">{t("liveGame.noHistory")}</p> : rows.map((match) => {
				const map = mapName(match.mapId, assets.maps) || t("liveGame.unavailable");
				const thumb = mapIcon(match.mapId, assets.maps);
				const agent = assets.agents.get(match.agentId.toLowerCase());
				const agentName = agent ? localize(agent.name) : t("liveGame.unavailable");
				return (
					<div key={match.matchId || `${match.startMillis}-${match.agentId}`} className="min-h-12 grid grid-cols-[58px_minmax(110px,1fr)_88px] sm:grid-cols-[58px_minmax(120px,1fr)_64px_88px] md:grid-cols-[58px_minmax(120px,1fr)_64px_100px_88px] lg:grid-cols-[58px_minmax(130px,1fr)_64px_100px_88px_62px_62px] xl:grid-cols-[58px_minmax(130px,1fr)_64px_100px_88px_62px_62px_120px] items-center gap-2 px-3 py-2 border-b border-white/5 last:border-0">
						<span className={`text-[10px] font-bold uppercase tracking-wider ${match.won ? "text-emerald-300" : "text-red-300"}`}>{t(match.won ? "liveGame.win" : "liveGame.loss")}</span>
						<div className="flex items-center gap-2 min-w-0">
							{thumb ? <img src={thumb} alt="" className="hidden sm:block w-12 h-7 rounded object-cover shrink-0" /> : <span className="hidden sm:block w-12 h-7 rounded bg-white/5 shrink-0" />}
							<span className="text-xs font-semibold text-white truncate" title={map}>{map}</span>
						</div>
						<span className="hidden sm:block text-xs tabular-nums text-gray-400">{match.allyRounds} - {match.enemyRounds}</span>
						<div className="hidden md:flex items-center gap-1.5 min-w-0">{agent?.icon && <img src={agent.icon} alt="" className="w-6 h-6 rounded shrink-0" />}<span className="text-[10px] text-gray-500 truncate">{agentName}</span></div>
						<span className="text-xs tabular-nums text-gray-200">{match.kills} / {match.deaths} / {match.assists}</span>
						<span className="hidden lg:block text-xs tabular-nums text-gray-400">{t("liveGame.acs")} {match.acs.toFixed(0)}</span>
						<span className="hidden lg:block text-xs tabular-nums text-gray-400">{t("liveGame.dpr")} {(match.dpr ?? 0).toFixed(0)}</span>
						<span className="hidden xl:block text-[10px] text-gray-600 text-right">{formatDate(match.startMillis)}</span>
					</div>
				);
			})}
		</div>
	);
};
