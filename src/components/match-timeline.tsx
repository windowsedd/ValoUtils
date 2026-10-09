import { invoke } from "@tauri-apps/api/core";
import type { GamePoint, MatchPlayer, MatchTimeline, MatchTimelineResponse, TimelineKill, TimelinePosition, TimelineRound } from "@/types/matches";
import { abilitySlot, formatRoundTime, minimapPoint, onMinimap } from "@/util/match-minimap";
import { parseRoundTime, replayEvents, replayPositions, snapshotAt, type ReplayEvent } from "@/util/match-replay";
import { rateLimitedSeconds } from "@/util/rate-limit";
import { getWeapons, localize, type MinimapAsset, type WeaponAsset } from "@/util/valorant-assets";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuBomb, LuChevronDown, LuClock, LuPause, LuPlay, LuShieldCheck, LuSkull, LuX } from "react-icons/lu";
import { teamColor, type MatchAssets } from "./match-scoreboard";

type Translate = ReturnType<typeof useTranslation>["t"];

/** Loaded timelines, kept for the session: matches never change once played. */
const timelineCache = new Map<string, MatchTimeline>();

const resultLabel = (result: string, t: Translate) => {
	switch (result) {
		case "Eliminated": return t("matches.timeline.eliminated");
		case "Bomb detonated": return t("matches.timeline.detonated");
		case "Bomb defused": return t("matches.timeline.defused");
		case "Round timer expired": return t("matches.timeline.timeExpired");
		case "Surrendered": return t("matches.timeline.surrendered");
		default: return result;
	}
};

const ResultIcon = ({ result }: { result: string }) => {
	const className = "h-3 w-3";
	switch (result) {
		case "Bomb detonated": return <LuBomb aria-hidden="true" className={className} />;
		case "Bomb defused": return <LuShieldCheck aria-hidden="true" className={className} />;
		case "Round timer expired": return <LuClock aria-hidden="true" className={className} />;
		default: return <LuSkull aria-hidden="true" className={className} />;
	}
};

const AgentIcon = ({ player, assets, size = "h-5 w-5" }: { player?: MatchPlayer; assets: MatchAssets; size?: string }) => {
	const agent = player ? assets.agents.get(player.characterId.toLowerCase()) : undefined;
	return agent?.icon ? (
		<img src={agent.icon} alt="" className={`${size} shrink-0 rounded`} />
	) : (
		<span className={`${size} shrink-0 rounded bg-(--control)`} />
	);
};

const PlayerName = ({ player, highlighted }: { player?: MatchPlayer; highlighted: boolean }) => (
	<span
		className={`min-w-0 truncate ${highlighted ? "font-semibold text-(--text-primary)" : "text-(--text-secondary)"}`}
		style={player ? { color: highlighted ? undefined : teamColor(player.teamId) } : undefined}
	>
		{player?.gameName || "—"}
	</span>
);

/** What finished the kill: a weapon's kill-feed icon, an ability name, or the spike. */
const KillCause = ({ kill, killer, assets, weapons }: {
	kill: TimelineKill;
	killer?: MatchPlayer;
	assets: MatchAssets;
	weapons: Map<string, WeaponAsset>;
}) => {
	const { t } = useTranslation();
	const weapon = weapons.get(kill.damageItem);
	if (weapon && (kill.damageType === "Weapon" || kill.damageType === "Melee")) {
		const name = localize(weapon.name);
		return weapon.killIcon ? (
			<img src={weapon.killIcon} alt={name} title={name} className="h-4 w-12 shrink-0 object-contain opacity-80" />
		) : (
			<span className="shrink-0 text-[10px] text-(--text-muted)">{name}</span>
		);
	}
	let label: string;
	switch (kill.damageType) {
		case "Ability": {
			const agent = killer ? assets.agents.get(killer.characterId.toLowerCase()) : undefined;
			label = localize(agent?.abilities?.[abilitySlot(kill.damageItem)]?.name) || t("matches.timeline.ability");
			break;
		}
		case "Bomb": label = t("matches.timeline.spike"); break;
		case "Melee": label = t("matches.timeline.melee"); break;
		case "Fall": label = t("matches.timeline.fall"); break;
		default: label = kill.damageType || "—";
	}
	return <span className="w-12 shrink-0 truncate text-center text-[10px] text-(--text-muted)" title={label}>{label}</span>;
};

type Marker = {
	key: string;
	at: GamePoint;
	player?: MatchPlayer;
	kind: "victim" | "killer" | "alive" | "death" | "spike";
	label?: string;
	view?: number;
};

const MinimapMarker = ({ marker, minimap, assets }: { marker: Marker; minimap: MinimapAsset; assets: MatchAssets }) => {
	const point = minimapPoint(minimap, marker.at);
	if (!onMinimap(point)) return null;
	const color = marker.player ? teamColor(marker.player.teamId) : "#facc15";
	const style = { left: `${point.x * 100}%`, top: `${point.y * 100}%` };

	if (marker.kind === "spike") {
		return (
			<span className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/70 p-0.5 text-[#facc15]" style={style} title={marker.label}>
				<LuBomb aria-hidden="true" className="h-3 w-3" />
			</span>
		);
	}
	if (marker.kind === "death" || marker.kind === "victim") {
		return (
			<span
				className={`absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 ${marker.kind === "victim" ? "h-5 w-5" : "h-4 w-4"}`}
				style={{ ...style, color }}
				title={marker.label}
			>
				<LuX aria-hidden="true" strokeWidth={3} className={marker.kind === "victim" ? "h-3.5 w-3.5" : "h-3 w-3"} />
			</span>
		);
	}
	// `viewRadians` is an angle in game axes; push its unit vector through the
	// same (axis-swapping) projection as the position to get the on-map angle.
	const degrees = marker.view === undefined
		? undefined
		: (Math.atan2(Math.cos(marker.view) * minimap.yMultiplier, Math.sin(marker.view) * minimap.xMultiplier) * 180) / Math.PI;
	return (
		<span className="absolute -translate-x-1/2 -translate-y-1/2" style={style} title={marker.label}>
			{degrees !== undefined && (
				<span
					className="absolute top-1/2 left-1/2 h-0.5 w-4 origin-left -translate-y-1/2"
					style={{ background: color, transform: `rotate(${degrees}deg)` }}
					aria-hidden="true"
				/>
			)}
			<span
				className={`relative block overflow-hidden rounded-full ${marker.kind === "killer" ? "h-6 w-6" : "h-5 w-5"}`}
				style={{ boxShadow: `0 0 0 2px ${color}` }}
			>
				<AgentIcon player={marker.player} assets={assets} size="h-full w-full" />
			</span>
		</span>
	);
};

/**
 * Rounds & kills for a finished match: a strip of rounds, the selected round's
 * kill feed with spike plant/defuse, and a minimap. With no kill selected the
 * map shows where everyone died that round; playback estimates movement
 * between the recorded kill, plant and defuse positions.
 */
export const MatchTimelinePanel = ({ matchId, mapId, players, assets, highlightPuuid }: {
	matchId: string;
	mapId: string;
	players: MatchPlayer[];
	assets: MatchAssets;
	highlightPuuid?: string;
}) => {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [timeline, setTimeline] = useState<MatchTimeline | undefined>(() => timelineCache.get(matchId));
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [weapons, setWeapons] = useState<Map<string, WeaponAsset>>(new Map());
	const [roundIndex, setRoundIndex] = useState(0);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		getWeapons().then((loaded) => !cancelled && setWeapons(loaded));
		if (timeline) return () => { cancelled = true; };
		setLoading(true);
		setError(undefined);
		invoke<MatchTimelineResponse>("match_timeline", { args: [matchId] })
			.then((reply) => {
				if (cancelled) return;
				if (reply.success) {
					timelineCache.set(matchId, reply.timeline);
					setTimeline(reply.timeline);
					return;
				}
				const throttled = rateLimitedSeconds(reply);
				setError(throttled === null ? reply.error ?? t("matches.timeline.failed") : t("common.rateLimited", { seconds: throttled }));
			})
			.catch((reason) => !cancelled && setError(String(reason)))
			.finally(() => !cancelled && setLoading(false));
		return () => { cancelled = true; };
	}, [open, matchId, timeline, t]);

	const bySubject = useMemo(() => new Map(players.map((player) => [player.subject.toLowerCase(), player])), [players]);
	const highlight = highlightPuuid?.toLowerCase() ?? players.find((player) => player.isSelf)?.subject.toLowerCase();

	return (
		<div className="@container rounded-[8px] border border-(--line) bg-(--surface)">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-(--text-secondary) hover:bg-(--surface-hover)"
			>
				{t("matches.timeline.title")}
				<LuChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
			</button>
			{open && (
				<div className="border-t border-(--line) px-3 pt-2 pb-3">
					{loading && <p className="py-2 text-[11px] text-(--text-muted)">{t("matches.timeline.loading")}</p>}
					{error && <p className="py-2 text-[11px] text-(--signal-neg)">{error}</p>}
					{timeline && (
						<TimelineBody
							key={`${matchId}:${roundIndex}`}
							timeline={timeline}
							mapId={mapId}
							bySubject={bySubject}
							highlight={highlight}
							assets={assets}
							weapons={weapons}
							roundIndex={Math.min(roundIndex, Math.max(0, timeline.rounds.length - 1))}
							onRound={setRoundIndex}
						/>
					)}
				</div>
			)}
		</div>
	);
};

const TimelineBody = ({ timeline, mapId, bySubject, highlight, assets, weapons, roundIndex, onRound }: {
	timeline: MatchTimeline;
	mapId: string;
	bySubject: Map<string, MatchPlayer>;
	highlight?: string;
	assets: MatchAssets;
	weapons: Map<string, WeaponAsset>;
	roundIndex: number;
	onRound: (index: number) => void;
}) => {
	const { t } = useTranslation();
	const round = timeline.rounds[roundIndex];
	const events = useMemo(() => round ? replayEvents(round) : [], [round]);
	const end = events[events.length - 1]?.time ?? 0;
	const firstTime = events[0]?.time ?? 0;
	const [time, setTime] = useState<number | null>(null);
	const [selectedEvent, setSelectedEvent] = useState<ReplayEvent>();
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [timeText, setTimeText] = useState("0:00");
	const [invalidTime, setInvalidTime] = useState(false);
	useEffect(() => { setTimeText(formatRoundTime(time ?? 0)); }, [time]);
	useEffect(() => {
		if (!playing) return;
		let last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			const delta = (now - last) * speed;
			last = now;
			setTime(value => Math.min(end, (value ?? 0) + delta));
		}, 100);
		return () => clearInterval(timer);
	}, [playing, speed, end]);
	useEffect(() => { if (time !== null && time >= end) setPlaying(false); }, [time, end]);
	const seek = (value: number | null, event?: ReplayEvent) => {
		setPlaying(false);
		setInvalidTime(false);
		setTime(value);
		setSelectedEvent(event);
	};
	const commitTime = () => {
		const value = parseRoundTime(timeText);
		if (value === null || value > end) { setInvalidTime(true); return; }
		seek(value);
	};
	if (!round) return <p className="py-2 text-[11px] text-(--text-muted)">{t("matches.timeline.noRounds")}</p>;
	const myTeam = highlight ? bySubject.get(highlight)?.teamId : undefined;
	const selected = time === null ? undefined : snapshotAt(events, time, selectedEvent);
	const positions = time === null ? [] : selectedEvent === selected && selected ? selected.positions : replayPositions(events, time);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label={t("matches.rounds")}>
				{timeline.rounds.map((entry, index) => {
					const won = myTeam ? entry.winningTeam === myTeam : undefined;
					const active = index === roundIndex;
					return (
						<button
							key={entry.round}
							type="button"
							role="tab"
							aria-selected={active}
							onClick={() => onRound(index)}
							title={`${t("matches.timeline.round", { number: index + 1 })} · ${resultLabel(entry.result, t)}`}
							className={`flex w-8 shrink-0 flex-col items-center gap-0.5 rounded-[5px] border py-1 text-[10px] tabular-nums transition-colors ${
								active ? "border-(--accent) bg-(--accent-soft) text-(--text-primary)" : "border-(--line) text-(--text-muted) hover:bg-(--surface-hover)"
							}`}
							style={{ borderBottom: `2px solid ${won === undefined ? teamColor(entry.winningTeam) : won ? "var(--signal-pos)" : "var(--signal-neg)"}` }}
						>
							{index + 1}
							<ResultIcon result={entry.result} />
						</button>
					);
				})}
			</div>

			<div className="flex flex-wrap items-center gap-2 text-[11px] text-(--text-secondary)">
				<button type="button" disabled={!end} aria-label={t(playing ? "matches.timeline.pause" : "matches.timeline.play")}
					onClick={() => { if (playing) setPlaying(false); else { setSelectedEvent(undefined); setInvalidTime(false); setTime(value => value === null || value >= end ? firstTime : value); setPlaying(true); } }}
					className="flex items-center gap-1 rounded border border-(--line) px-2 py-1 hover:bg-(--surface-hover) disabled:opacity-40">
					{playing ? <LuPause aria-hidden="true" /> : <LuPlay aria-hidden="true" />}
					{t(playing ? "matches.timeline.pause" : "matches.timeline.play")}
				</button>
				<label className="flex items-center gap-1">
					<span className="sr-only">{t("matches.timeline.elapsed")}</span>
					<input type="text" inputMode="text" value={timeText} aria-invalid={invalidTime} aria-label={t("matches.timeline.elapsed")}
						onFocus={() => setPlaying(false)} onChange={event => { setTimeText(event.target.value); setInvalidTime(false); }}
						onBlur={commitTime} onKeyDown={event => { if (event.key === "Enter") commitTime(); }}
						className="w-14 rounded border border-(--line) bg-(--control) px-1.5 py-1 text-center tabular-nums" />
				</label>
				<span className="tabular-nums">/ {formatRoundTime(end)}</span>
				<input type="range" min={0} max={end || 1} step={1} value={time ?? 0} disabled={!end} aria-label={t("matches.timeline.seek")}
					onChange={event => seek(Number(event.target.value))} className="min-w-20 flex-1 accent-(--accent)" />
				<select value={speed} onChange={event => setSpeed(Number(event.target.value))} aria-label={t("matches.timeline.speed")} className="rounded border border-(--line) bg-(--control) px-1 py-1">
					{[1, 2, 4].map(value => <option key={value} value={value}>{value}×</option>)}
				</select>
			</div>
			{invalidTime && <p role="alert" className="text-[11px] text-(--signal-neg)">{t("matches.timeline.invalidTime", { end: formatRoundTime(end) })}</p>}
			<p className="text-[10px] text-(--text-muted)">{t("matches.timeline.snapshots")}</p>
			<div className="grid grid-cols-1 gap-3 @min-[40rem]:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
				<RoundMinimap mapId={mapId} round={round} selected={selected} positions={positions} time={time} firstTime={firstTime} bySubject={bySubject} assets={assets} t={t} />
				<div className="flex min-w-0 flex-col gap-0.5">
					<p className="flex items-center gap-2 pb-1 text-[10px] uppercase tracking-widest text-(--text-muted)">
						{t("matches.timeline.round", { number: roundIndex + 1 })} · {resultLabel(round.result, t)}
						{time !== null && (
							<button type="button" onClick={() => seek(null)} className="ml-auto normal-case tracking-normal text-(--accent) hover:underline">
								{t("matches.timeline.allDeaths")}
							</button>
						)}
					</p>
					{round.kills.length === 0 && !round.plant && (
						<p className="text-[11px] text-(--text-muted)">{t("matches.timeline.noKills")}</p>
					)}
					{events.map((entry) => {
						if (entry.kind !== "kill") {
							const player = bySubject.get(entry.player);
							return (
								<button type="button" key={entry.kind} onClick={() => seek(entry.time, entry)} aria-pressed={selected === entry} className="flex items-center gap-2 rounded-[5px] px-2 py-1 text-left text-[11px] text-[#facc15] hover:bg-(--surface-hover)">
									<span className="w-8 shrink-0 tabular-nums text-(--text-muted)">{formatRoundTime(entry.time)}</span>
									{entry.kind === "plant" ? <LuBomb aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <LuShieldCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
									<AgentIcon player={player} assets={assets} />
									<PlayerName player={player} highlighted={entry.player === highlight} />
									<span className="shrink-0">
										{entry.kind === "plant"
											? t("matches.timeline.planted", { site: round.plantSite || "?" })
											: t("matches.timeline.defusedBy")}
									</span>
								</button>
							);
						}
						const { kill, index } = entry;
						const killer = bySubject.get(kill.killer);
						const victim = bySubject.get(kill.victim);
						const active = selected === entry;
						return (
							<button
								key={`kill-${index}`}
								type="button"
								onClick={() => seek(active ? null : kill.time, active ? undefined : entry)}
								aria-pressed={active}
								className={`flex w-full min-w-0 items-center gap-2 rounded-[5px] px-2 py-1 text-left text-[11px] transition-colors ${
									active ? "bg-(--accent-soft)" : kill.killer === highlight || kill.victim === highlight ? "bg-white/3 hover:bg-(--surface-hover)" : "hover:bg-(--surface-hover)"
								}`}
							>
								<span className="w-8 shrink-0 tabular-nums text-(--text-muted)">{formatRoundTime(kill.time)}</span>
								<span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
									<PlayerName player={killer} highlighted={kill.killer === highlight} />
									<AgentIcon player={killer} assets={assets} />
								</span>
								<KillCause kill={kill} killer={killer} assets={assets} weapons={weapons} />
								<span className="flex min-w-0 flex-1 items-center gap-1.5">
									<AgentIcon player={victim} assets={assets} />
									<PlayerName player={victim} highlighted={kill.victim === highlight} />
								</span>
								{kill.assistants.length > 0 && (
									<span className="shrink-0 text-[10px] text-(--text-muted)" title={kill.assistants.map((id) => bySubject.get(id)?.gameName ?? "—").join(", ")}>
										+{kill.assistants.length}
									</span>
								)}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
};

const RoundMinimap = ({ mapId, round, selected, positions, time, firstTime, bySubject, assets, t }: {
	mapId: string;
	round: TimelineRound;
	selected?: ReplayEvent;
	positions: TimelinePosition[];
	time: number | null;
	firstTime: number;
	bySubject: Map<string, MatchPlayer>;
	assets: MatchAssets;
	t: Translate;
}) => {
	const leaf = mapId.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
	const minimap = (assets.maps.get(mapId.toLowerCase()) ?? assets.maps.get(leaf))?.minimap;
	if (!minimap) {
		return <p className="self-start rounded-[8px] border border-(--line) px-3 py-6 text-center text-[11px] text-(--text-muted)">{t("matches.timeline.noMinimap")}</p>;
	}

	const markers: Marker[] = [];
	const name = (subject: string) => bySubject.get(subject)?.gameName || "—";
	if (time !== null) {
		const kill = selected?.kind === "kill" ? selected.kill : undefined;
		const addPosition = (position: TimelinePosition) => {
			if (position.subject === kill?.victim) return;
			markers.push({
				key: position.subject,
				at: position,
				view: position.view,
				player: bySubject.get(position.subject),
				kind: position.subject === kill?.killer ? "killer" : "alive",
				label: name(position.subject),
			});
		};
		positions.forEach(addPosition);
		if (kill?.victimLocation) {
			markers.push({ key: "victim", at: kill.victimLocation, player: bySubject.get(kill.victim), kind: "victim", label: name(kill.victim) });
		}
	} else {
		round.kills.forEach((kill, index) => {
			if (!kill.victimLocation) return;
			markers.push({
				key: `death-${index}`,
				at: kill.victimLocation,
				player: bySubject.get(kill.victim),
				kind: "death",
				label: `${formatRoundTime(kill.time)} ${name(kill.killer)} → ${name(kill.victim)}`,
			});
		});
	}
	const plant = round.plant && (time === null || round.plant.time <= time) ? round.plant : null;
	if (plant?.location) {
		markers.push({ key: "spike", at: plant.location, kind: "spike", label: t("matches.timeline.planted", { site: round.plantSite || "?" }) });
	}

	return (
		<div className="relative aspect-square w-full self-start overflow-hidden rounded-[8px] border border-(--line) bg-black/40">
			<img src={minimap.image} alt="" className="absolute inset-0 h-full w-full object-contain opacity-80" />
			{time !== null && !selected && <p className="absolute inset-x-2 bottom-2 rounded bg-black/80 p-2 text-center text-[10px] text-(--text-secondary)">{t("matches.timeline.noSnapshot", { time: formatRoundTime(firstTime) })}</p>}
			{markers.map((marker) => (
				<MinimapMarker key={marker.key} marker={marker} minimap={minimap} assets={assets} />
			))}
		</div>
	);
};
