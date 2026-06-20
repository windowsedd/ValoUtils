import { useEffect, useState } from "react";
import { FaArrowUp, FaArrowDown, FaMinus, FaTrophy } from "react-icons/fa6";
import { useTranslation } from "react-i18next";

const TIER_NAMES: Record<number, string> = {
	0: "Unranked", 1: "Unranked", 2: "Unranked",
	3: "Iron 1", 4: "Iron 2", 5: "Iron 3",
	6: "Bronze 1", 7: "Bronze 2", 8: "Bronze 3",
	9: "Silver 1", 10: "Silver 2", 11: "Silver 3",
	12: "Gold 1", 13: "Gold 2", 14: "Gold 3",
	15: "Platinum 1", 16: "Platinum 2", 17: "Platinum 3",
	18: "Diamond 1", 19: "Diamond 2", 20: "Diamond 3",
	21: "Ascendant 1", 22: "Ascendant 2", 23: "Ascendant 3",
	24: "Immortal 1", 25: "Immortal 2", 26: "Immortal 3",
	27: "Radiant",
};

const TIER_COLOR: Record<number, string> = {
	0: "#9ca3af", 1: "#9ca3af", 2: "#9ca3af",
	3: "#cbd5e1", 4: "#cbd5e1", 5: "#cbd5e1",
	6: "#b45309", 7: "#b45309", 8: "#b45309",
	9: "#9ca3af", 10: "#9ca3af", 11: "#9ca3af",
	12: "#eab308", 13: "#eab308", 14: "#eab308",
	15: "#67e8f9", 16: "#67e8f9", 17: "#67e8f9",
	18: "#60a5fa", 19: "#60a5fa", 20: "#60a5fa",
	21: "#4ade80", 22: "#4ade80", 23: "#4ade80",
	24: "#f87171", 25: "#f87171", 26: "#f87171",
	27: "#fde68a",
};

const MAP_NAMES: Record<string, string> = {
	Ascent: "Ascent", Bonsai: "Split", Canyon: "Fracture",
	Duality: "Bind", Foxtrot: "Breeze", Jam: "Lotus",
	Juliett: "Sunset", Pitt: "Pearl", Port: "Icebox",
	Range: "The Range", Triad: "Haven", Abyss: "Abyss",
	HURM_Bowl: "Colosseum", HURM_Alley: "Drift", HURM_Helix: "District",
};

const getMapName = (mapId: string) => MAP_NAMES[mapId.split("/").pop() ?? ""] ?? (mapId.split("/").pop() ?? "Unknown");
const tierName = (t: number) => TIER_NAMES[t] ?? "Unknown";
const tierColor = (t: number) => TIER_COLOR[t] ?? "#9ca3af";

type CareerData = { mmr: any; competitiveUpdates: any };

const PlayerCareer = () => {
	const [data, setData] = useState<CareerData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const { t } = useTranslation();

	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("career:get", (message: string) => {
			window.Main.removeAllListeners("career:get");
			const res = JSON.parse(message);
			if (!res.success) { setError(res.error ?? t("career.failedToLoad")); setLoading(false); return; }
			setData({ mmr: res.mmr, competitiveUpdates: res.competitiveUpdates });
			setLoading(false);
		});
		window.Main.send("career:get");
		return () => { window.Main.removeAllListeners("career:get"); };
	}, []);

	const matches: any[] = data?.competitiveUpdates?.Matches ?? [];
	const latest = matches[0];
	const currentTier: number = latest?.TierAfterUpdate ?? 0;
	const currentRR: number = latest?.RankedRatingAfterUpdate ?? 0;
	const color = tierColor(currentTier);

	return (
		<div className="px-6 py-6 h-full flex flex-col gap-4 animate-fade-in">

			{/* Header */}
			<div className="glass-strong px-6 py-4 shrink-0 flex items-center justify-between">
				<h1 className="text-5xl font-bold gradient-text">{t("career.title")}</h1>
				{!loading && !error && currentTier > 0 && (
					<span className="text-sm font-semibold px-3 py-1 rounded-full glass" style={{ color }}>
						{tierName(currentTier)}
					</span>
				)}
			</div>

			{loading && (
				<div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
					{t("career.loading")}
				</div>
			)}

			{error && (
				<div className="flex-1 flex items-center justify-center">
					<div className="glass p-6 text-center max-w-md">
						<p className="text-red-400 font-semibold mb-1">{t("career.failedToLoad")}</p>
						<p className="text-gray-500 text-sm">{error}</p>
					</div>
				</div>
			)}

			{!loading && !error && (
				<>
					{/* Rank card */}
					<div className="glass-strong shrink-0 rounded-2xl px-6 py-5 relative overflow-hidden">
						<div
							className="absolute inset-0 opacity-[0.06] pointer-events-none"
							style={{ background: `radial-gradient(ellipse at 80% 50%, ${color} 0%, transparent 70%)` }}
						/>
						<p className="text-xs uppercase tracking-widest text-gray-500 mb-2">{t("career.currentRank")}</p>
						{currentTier === 0 ? (
							<p className="text-3xl font-bold text-gray-400">{t("career.unranked")}</p>
						) : (
							<>
								<div className="flex items-end gap-4 mb-3">
									<p className="text-4xl font-bold" style={{ color }}>{tierName(currentTier)}</p>
									<p className="text-xl text-gray-300 mb-0.5">{currentRR} RR</p>
								</div>
								{/* RR progress bar */}
								<div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
									<div
										className="h-full rounded-full transition-all duration-700"
										style={{ width: `${currentRR}%`, background: color }}
									/>
								</div>
								<p className="text-xs text-gray-600 mt-1">{t("career.rrToNext", { rr: currentRR })}</p>
							</>
						)}
					</div>

					{/* Match history */}
					<div className="glass-strong rounded-2xl flex-1 flex flex-col min-h-0 overflow-hidden">
						<p className="text-xs uppercase tracking-widest text-gray-500 px-5 py-4 shrink-0 border-b border-white/5">
							{t("career.recentMatches")}
						</p>

						{matches.length === 0 ? (
							<div className="flex-1 flex flex-col items-center justify-center text-gray-500 gap-2">
								<FaTrophy className="text-4xl text-gray-700" />
								<p className="text-sm">{t("career.noMatches")}</p>
							</div>
						) : (
							<div className="overflow-y-auto flex-1">
								{matches.map((match: any, i: number) => {
									const rr: number = match.RankedRatingEarned ?? 0;
									const tierAfter: number = match.TierAfterUpdate ?? 0;
									const tierBefore: number = match.TierBeforeUpdate ?? 0;
									const promoted = tierAfter > tierBefore;
									const demoted = tierAfter < tierBefore;
									const rrPositive = rr > 0;
									const mapName = getMapName(match.MapID ?? "");
									const date = match.MatchStartTime
										? new Date(match.MatchStartTime).toLocaleDateString()
										: "—";
									const col = tierColor(tierAfter);

									return (
										<div
											key={i}
											className="flex items-center gap-4 px-5 py-3.5 border-b border-white/5 last:border-0 hover:bg-white/3 transition-colors"
										>
											{/* RR stripe */}
											<div
												className="w-1 self-stretch rounded-full shrink-0"
												style={{ background: rr > 0 ? "#4ade80" : rr < 0 ? "#f87171" : "#6b7280" }}
											/>

											{/* Map + date */}
											<div className="flex-1 min-w-0">
												<p className="font-semibold text-white truncate">{mapName}</p>
												<p className="text-xs text-gray-500">{date}</p>
											</div>

											{/* Tier change badge */}
											{(promoted || demoted) && (
												<span
													className="text-xs font-semibold flex items-center gap-1 px-2 py-0.5 rounded-full"
													style={{
														color: promoted ? "#4ade80" : "#f87171",
														background: promoted ? "rgba(74,222,128,0.1)" : "rgba(248,113,113,0.1)",
													}}
												>
													{promoted ? <FaArrowUp className="text-[10px]" /> : <FaArrowDown className="text-[10px]" />}
													{promoted ? t("career.promoted") : t("career.demoted")}
												</span>
											)}

											{/* Rank */}
											<p className="text-sm font-semibold w-24 text-right" style={{ color: col }}>
												{tierName(tierAfter)}
											</p>

											{/* RR */}
											<div className="flex items-center gap-1 w-16 justify-end">
												{rr === 0
													? <FaMinus className="text-gray-500 text-xs" />
													: <span
														className="font-bold text-sm"
														style={{ color: rrPositive ? "#4ade80" : "#f87171" }}
													>
														{rrPositive ? "+" : ""}{rr} RR
													</span>
												}
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
};

export default PlayerCareer;
