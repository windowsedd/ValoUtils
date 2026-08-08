import { useEffect, useMemo, useState } from "react";
import { FaUsers, FaCrosshairs } from "react-icons/fa6";
import { useTranslation } from "react-i18next";
import { tierColor, tierName } from "@/util/valorant-ranks";
import {
	getAgents,
	getPlayerCard,
	getSeasonLabels,
	getTiers,
	getWeaponSkin,
	localize,
	weaponSkinKey,
	type AgentAsset,
	type CardAsset,
	type SkinAsset,
	type TierAsset,
} from "@/util/valorant-assets";
import type { LiveGameResponse, LivePlayer, LiveState, WeaponSkin } from "@/types/live-game";

const POLL_MS = 5000;

type Resolved = {
	agents: Map<string, AgentAsset>;
	tiers: Map<number, TierAsset>;
	seasons: Map<string, string>;
	skins: Map<string, SkinAsset | null>;
	cards: Map<string, CardAsset | null>;
};

const stateLabelKey: Record<Exclude<LiveState, "idle">, string> = {
	coregame: "liveGame.stateCoregame",
	pregame: "liveGame.statePregame",
	party: "liveGame.stateParty",
};

// Distinct colours per detected party so premades are easy to spot at a glance.
const PARTY_COLORS = ["#22d3ee", "#f59e0b", "#a78bfa", "#34d399", "#fb7185"];
const partyStyle = (label: string) => {
	const n = parseInt(label.replace(/\D/g, ""), 10) || 1;
	const color = PARTY_COLORS[(n - 1) % PARTY_COLORS.length];
	return { color, background: `${color}1a` };
};

// Run at most `concurrency` promises at a time.
async function pooled<T>(tasks: (() => Promise<T>)[], concurrency = 4): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const i = next++;
			results[i] = await tasks[i]();
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
	return results;
}

// Resolve agent icons, rank icons, weapon-skin variants and season labels for
// the current roster. Assets are cached at module scope so this is cheap.
const useAssets = (players: LivePlayer[]): Resolved => {
	const [agents, setAgents] = useState<Map<string, AgentAsset>>(new Map());
	const [tiers, setTiers] = useState<Map<number, TierAsset>>(new Map());
	const [seasons, setSeasons] = useState<Map<string, string>>(new Map());
	const [skins, setSkins] = useState<Map<string, SkinAsset | null>>(new Map());
	const [cards, setCards] = useState<Map<string, CardAsset | null>>(new Map());

	useEffect(() => {
		let cancelled = false;
		getAgents().then((m) => !cancelled && setAgents(m));
		getTiers().then((m) => !cancelled && setTiers(m));
		getSeasonLabels().then((m) => !cancelled && setSeasons(m));
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		let cancelled = false;
		const weapons: WeaponSkin[] = [];
		for (const p of players) {
			for (const w of [p.loadout?.vandal, p.loadout?.phantom, p.loadout?.knife]) {
				if (w?.skinId) weapons.push(w);
			}
		}
		pooled(weapons.map((w) => () => getWeaponSkin(w).then((asset) => [weaponSkinKey(w)!, asset] as const))).then((entries) => {
			if (cancelled) return;
			setSkins((prev) => {
				const next = new Map(prev);
				for (const [key, asset] of entries) next.set(key, asset);
				return next;
			});
		});

		const cardIds = [...new Set(players.map((p) => p.cardId).filter(Boolean) as string[])];
		pooled(cardIds.map((id) => () => getPlayerCard(id).then((asset) => [id.toLowerCase(), asset] as const))).then((entries) => {
			if (cancelled) return;
			setCards((prev) => {
				const next = new Map(prev);
				for (const [key, asset] of entries) next.set(key, asset);
				return next;
			});
		});
		return () => { cancelled = true; };
	}, [players]);

	return { agents, tiers, seasons, skins, cards };
};

const SkinThumb = ({ weapon, skins, label }: { weapon: WeaponSkin; skins: Map<string, SkinAsset | null>; label: string }) => {
	const key = weaponSkinKey(weapon);
	const asset = key ? skins.get(key) : null;
	const name = asset ? localize(asset.name) : "";
	return (
		<div className="flex flex-col items-center w-20 shrink-0" title={name || label}>
			{asset?.icon ? (
				<img src={asset.icon} alt={name} className="h-6 w-full object-contain" />
			) : (
				<div className="h-6 w-full flex items-center justify-center text-gray-700">
					<FaCrosshairs className="text-xs" />
				</div>
			)}
			<span className="text-[9px] uppercase tracking-wider text-gray-600 mt-0.5">{label}</span>
		</div>
	);
};

const RankChip = ({ tier, rr, label, tiers }: { tier: number; rr?: number; label?: string; tiers: Map<number, TierAsset> }) => {
	const color = tierColor(tier);
	const icon = tiers.get(tier)?.icon;
	return (
		<div className="flex flex-col items-end gap-0.5">
			{label && <span className="text-[9px] uppercase tracking-widest text-gray-600">{label}</span>}
			<div className="flex items-center gap-1.5">
				{tier > 0 && icon && <img src={icon} alt="" className="w-5 h-5 object-contain shrink-0" />}
				<span className="text-sm font-semibold" style={{ color }}>
					{tier > 0 ? tierName(tier) : "—"}
					{typeof rr === "number" && tier > 0 ? <span className="text-gray-400 font-normal"> · {rr} RR</span> : null}
				</span>
			</div>
		</div>
	);
};

const PlayerRow = ({ player, assets }: { player: LivePlayer; assets: Resolved }) => {
	const { t } = useTranslation();
	const agent = player.characterId ? assets.agents.get(player.characterId.toLowerCase()) : undefined;
	const agentName = agent ? localize(agent.name) : "";
	const card = player.cardId ? assets.cards.get(player.cardId.toLowerCase()) : undefined;
	const avatarIcon = agent?.icon ?? card?.icon;
	const peakLabel = player.peakSeasonId ? assets.seasons.get(player.peakSeasonId.toLowerCase()) : undefined;
	const displayName = player.incognito || !player.gameName
		? t("liveGame.hidden")
		: `${player.gameName}#${player.tagLine}`;

	const party = player.party ? partyStyle(player.party) : null;

	return (
		<div className="relative flex items-center gap-3 pl-5 pr-4 py-2.5 border-b border-white/5 last:border-0 hover:bg-white/3 transition-colors">
			{/* Party stripe (tracker.gg style) — same colour = same party */}
			{party && <span className="absolute left-0 top-0 bottom-0 w-1.5" style={{ background: party.color }} />}

			{/* Avatar: agent in a match, player card in the lobby */}
			<div className="relative w-9 h-9 rounded-md bg-white/5 shrink-0 overflow-hidden flex items-center justify-center">
				{avatarIcon ? <img src={avatarIcon} alt={agentName} className="w-full h-full object-cover" /> : null}
				{player.level != null && (
					<span className="absolute bottom-0 inset-x-0 text-[8px] leading-tight font-semibold text-center text-white bg-black/60">
						{player.level}
					</span>
				)}
			</div>

			{/* Name + party */}
			<div className="flex-1 min-w-0">
				<p className="font-semibold text-white truncate">{displayName}</p>
				<div className="flex items-center gap-2 h-4">
					{agentName && <span className="text-xs text-gray-500 truncate">{agentName}</span>}
					{party && (
						<span className="text-[10px] font-semibold px-1.5 rounded-full" style={party}>
							{player.party}
						</span>
					)}
				</div>
			</div>

			{/* Skins */}
			{player.loadout && (
				<div className="hidden sm:flex items-center gap-1">
					<SkinThumb weapon={player.loadout.vandal} skins={assets.skins} label={t("liveGame.vandal")} />
					<SkinThumb weapon={player.loadout.phantom} skins={assets.skins} label={t("liveGame.phantom")} />
					<SkinThumb weapon={player.loadout.knife} skins={assets.skins} label={t("liveGame.knife")} />
				</div>
			)}

			{/* Ranks */}
			<div className="flex items-center gap-4 shrink-0">
				<RankChip tier={player.peakTier} label={`${t("liveGame.peak")}${peakLabel ? ` ${peakLabel}` : ""}`} tiers={assets.tiers} />
				<RankChip tier={player.currentTier} rr={player.currentRR} label={t("liveGame.current")} tiers={assets.tiers} />
			</div>
		</div>
	);
};

const TeamSection = ({ title, color, players, assets }: { title: string; color: string; players: LivePlayer[]; assets: Resolved }) => (
	<>
		<div className="px-4 py-2 flex items-center gap-2 border-b border-white/5">
			<span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
			<span className="text-xs uppercase tracking-widest text-gray-400 font-semibold">{title}</span>
			<span className="text-xs text-gray-600 ml-auto">{players.length}</span>
		</div>
		{players.map((p) => <PlayerRow key={p.puuid} player={p} assets={assets} />)}
	</>
);

const LiveGame = () => {
	const [state, setState] = useState<LiveState>("idle");
	const [players, setPlayers] = useState<LivePlayer[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const { t } = useTranslation();

	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("live-game:fetch", (message: string) => {
			const res = JSON.parse(message) as LiveGameResponse;
			setLoading(false);
			if (!res.success) {
				if ("code" in res && res.code === "loginRequired") {
					setLoginRequired(true);
					setError(null);
					return;
				}
				setError(("error" in res && res.error) || t("liveGame.failedToLoad"));
				return;
			}
			setLoginRequired(false);
			setError(null);
			setState(res.state);
			setPlayers(res.players);
		});

		window.Main.send("live-game:fetch");
		const interval = setInterval(() => window.Main.send("live-game:fetch"), POLL_MS);
		return () => {
			clearInterval(interval);
			window.Main.removeAllListeners("live-game:fetch");
		};
	}, []);

	const assets = useAssets(players);

	const teams = useMemo(() => {
		const groups = new Map<string, LivePlayer[]>();
		for (const p of players) {
			const key = p.teamId ?? "all";
			(groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
		}
		return groups;
	}, [players]);

	const teamMeta = (key: string): { title: string; color: string } => {
		switch (key) {
			case "Blue": return { title: t("liveGame.teamBlue"), color: "#60a5fa" };
			case "Red": return { title: t("liveGame.teamRed"), color: "#f87171" };
			case "Ally": return { title: t("liveGame.teamAlly"), color: "#4ade80" };
			case "Enemy": return { title: t("liveGame.teamEnemy"), color: "#f87171" };
			default: return { title: t("liveGame.players"), color: "#22d3ee" };
		}
	};

	return (
		<div className="px-6 py-6 h-full flex flex-col gap-4 animate-fade-in">
			{/* Header */}
			<div className="glass-strong px-6 py-4 shrink-0 flex items-center justify-between">
				<h1 className="text-5xl font-bold gradient-text">{t("liveGame.title")}</h1>
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={() => window.Main.send("live-game:dump")}
						className="text-xs font-semibold px-2.5 py-1 rounded-full glass text-gray-400 hover:text-white transition-colors"
						title="Dump raw pregame/coregame/party data to a JSON file"
					>
						⤓ Dump
					</button>
					{!loading && !error && !loginRequired && state !== "idle" && (
						<span className="flex items-center gap-2 text-sm font-semibold px-3 py-1 rounded-full glass text-cyan-300">
							<span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
							{t(stateLabelKey[state])}
						</span>
					)}
				</div>
			</div>

			{loading && (
				<div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
					{t("liveGame.loading")}
				</div>
			)}

			{!loading && loginRequired && (
				<div className="flex-1 flex items-center justify-center">
					<div className="glass p-6 text-center max-w-md flex flex-col items-center gap-2">
						<FaUsers className="text-3xl text-gray-700 mb-1" />
						<p className="text-white font-semibold">{t("liveGame.loginRequired")}</p>
						<p className="text-gray-500 text-sm">{t("liveGame.loginRequiredDesc")}</p>
					</div>
				</div>
			)}

			{!loading && error && !loginRequired && (
				<div className="flex-1 flex items-center justify-center">
					<div className="glass p-6 text-center max-w-md">
						<p className="text-red-400 font-semibold mb-1">{t("liveGame.failedToLoad")}</p>
						<p className="text-gray-500 text-sm">{error}</p>
					</div>
				</div>
			)}

			{!loading && !error && !loginRequired && state === "idle" && (
				<div className="flex-1 flex items-center justify-center">
					<div className="glass p-6 text-center max-w-md flex flex-col items-center gap-2">
						<FaUsers className="text-3xl text-gray-700 mb-1" />
						<p className="text-white font-semibold">{t("liveGame.idle")}</p>
						<p className="text-gray-500 text-sm">{t("liveGame.idleDesc")}</p>
					</div>
				</div>
			)}

			{!loading && !error && !loginRequired && state !== "idle" && (
				<div className="flex-1 min-h-0 glass-strong rounded-2xl overflow-y-auto">
					{[...teams.entries()].map(([key, group]) => {
						const meta = teamMeta(key);
						return <TeamSection key={key} title={meta.title} color={meta.color} players={group} assets={assets} />;
					})}
				</div>
			)}
		</div>
	);
};

export default LiveGame;
