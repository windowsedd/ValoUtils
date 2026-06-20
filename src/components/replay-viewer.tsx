import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaArrowLeft, FaBug, FaDownload, FaMagic, FaPause, FaPlay, FaStepBackward, FaStepForward } from "react-icons/fa";

// ── Types ────────────────────────────────────────────────────────────────────

interface BombState { t: number; sampleIdx: number }
interface PositionsMeta {
    uniqueGuids: string[];
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
}
interface PositionsData {
    meta: PositionsMeta;
    samples: [number, string, number, number, number][];   // [ueTs, guid, x, y, rotZ]
    bombStates: BombState[];
}
interface RoundEvent { g: string; t: number }   // t = ms relative to recording start
interface MetaData { mapUrl: string; mapName: string }
interface AbilityEntry {
    t: number;
    x: number;
    y: number;
    type: string;
    life: number;
    radius: number;
    outerRadius?: number | null;
    team: number;
    ownerActor?: number;
    agent?: string;
    ability?: string;
    icon?: string;
}
interface MatchDetailsPlayer {
    subject: string;
    characterId: string;
    teamId: string;
}
interface MatchDetailsKill {
    gameTime: number;
    victim?: string;
    playerLocations?: {
        subject?: string;
        location?: { x: number; y: number };
    }[];
}
interface MatchDetailsData {
    players?: MatchDetailsPlayer[];
    kills?: MatchDetailsKill[];
}
interface AgentMeta {
    name: string;
    icon: string | null;
}
interface MapInfo {
    mapUrl: string;
    displayName: string;
    displayIcon: string;
    xMultiplier: number;
    yMultiplier: number;
    xScalarToAdd: number;
    yScalarToAdd: number;
}
interface ImageBounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface ReplayViewerProps {
    replayId?: string;
    positions: PositionsData;
    events: RoundEvent[];
    meta: MetaData;
    abilities: AbilityEntry[];
    matchDetails?: MatchDetailsData | null;
    onClose: () => void;
}

// ── Actor index ───────────────────────────────────────────────────────────────
// Builds per-actor arrays indexed by their position in the global samples array.
// We do NOT use UE timestamps as a time axis — we use global sample index,
// which we convert from wall-clock time via bombStates.

interface ActorIndex {
    sampleIdxs: Uint32Array[];   // sampleIdxs[actor] = sorted global sample indices
    xs: Float32Array[];
    ys: Float32Array[];
    playerIdxs: number[];        // top actors by movement-weighted score
    teamOf: number[];            // 0 = team A, 1 = team B
    counts: number[];
    playerBounds: PositionsMeta["bounds"]; // bounds computed from selected players only
}

function buildActorIndex(posData: PositionsData, maxActors = 14): ActorIndex {
    const N = posData.samples.length;
    const guidIdx = new Map(posData.meta.uniqueGuids.map((g, i) => [g, i]));
    const numActors = posData.meta.uniqueGuids.length;

    const counts = new Array<number>(numActors).fill(0);
    for (let s = 0; s < N; s++) {
        const ai = guidIdx.get(posData.samples[s][1]);
        if (ai !== undefined) counts[ai]++;
    }

    const sampleIdxs = counts.map(c => new Uint32Array(c));
    const xs = counts.map(c => new Float32Array(c));
    const ys = counts.map(c => new Float32Array(c));
    const w = new Array<number>(numActors).fill(0);

    for (let s = 0; s < N; s++) {
        const ai = guidIdx.get(posData.samples[s][1]);
        if (ai === undefined) continue;
        const i = w[ai]++;
        sampleIdxs[ai][i] = s;
        xs[ai][i] = posData.samples[s][2];
        ys[ai][i] = posData.samples[s][3];
    }

    // Exclude completely static entities (spawn pads, cameras) by requiring a
    // minimum movement span. 200 UE units (~2 m) is tiny — any real player
    // exceeds this in seconds; fixed objects never move at all (span = 0).
    const playerIdxs = Array.from({ length: numActors }, (_, i) => i)
        .filter(ai => {
            const len = xs[ai].length;
            if (len === 0) return false;
            let minX = xs[ai][0], maxX = xs[ai][0], minY = ys[ai][0], maxY = ys[ai][0];
            for (let i = 1; i < len; i++) {
                if (xs[ai][i] < minX) minX = xs[ai][i];
                if (xs[ai][i] > maxX) maxX = xs[ai][i];
                if (ys[ai][i] < minY) minY = ys[ai][i];
                if (ys[ai][i] > maxY) maxY = ys[ai][i];
            }
            return (maxX - minX) + (maxY - minY) > 200;
        })
        .sort((a, b) => counts[b] - counts[a])
        .slice(0, maxActors);

    // Compute bounds from selected players only so fallback projection
    // isn't skewed by outlier non-player entities in the full dataset.
    let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
    for (const ai of playerIdxs) {
        for (let i = 0; i < xs[ai].length; i++) {
            if (xs[ai][i] < pMinX) pMinX = xs[ai][i];
            if (xs[ai][i] > pMaxX) pMaxX = xs[ai][i];
            if (ys[ai][i] < pMinY) pMinY = ys[ai][i];
            if (ys[ai][i] > pMaxY) pMaxY = ys[ai][i];
        }
    }
    const playerBounds = {
        minX: isFinite(pMinX) ? pMinX : posData.meta.bounds.minX,
        maxX: isFinite(pMaxX) ? pMaxX : posData.meta.bounds.maxX,
        minY: isFinite(pMinY) ? pMinY : posData.meta.bounds.minY,
        maxY: isFinite(pMaxY) ? pMaxY : posData.meta.bounds.maxY,
    };

    // Team split: lower half by initial Y = team 0, upper half = team 1.
    const half = Math.ceil(playerIdxs.length / 2);
    const sorted = [...playerIdxs].sort((a, b) => (ys[a][0] ?? 0) - (ys[b][0] ?? 0));
    const teamOf = new Array<number>(numActors).fill(-1);
    sorted.slice(0, half).forEach(ai => { teamOf[ai] = 0; });
    sorted.slice(half).forEach(ai => { teamOf[ai] = 1; });

    return { sampleIdxs, xs, ys, playerIdxs, teamOf, counts, playerBounds };
}

// ── Time conversion ───────────────────────────────────────────────────────────
// events[i].t  = ms relative to recording start (wall-clock)
// bombStates[i].t = absolute bomb-game-clock seconds; .sampleIdx = position in samples[]
// wallZero = bombStates[0].t * 1000 (ms), the bomb clock at sample 0

function wallMsToSampleIdx(wallMs: number, bombStates: BombState[], wallZeroMs: number): number {
    if (bombStates.length === 0) return 0;
    const absSec = (wallMs + wallZeroMs) / 1000;
    let lo = 0, hi = bombStates.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bombStates[mid].t < absSec) lo = mid + 1; else hi = mid;
    }
    const next = bombStates[lo];
    const prev = lo > 0 ? bombStates[lo - 1] : null;
    if (!prev) return next.sampleIdx;
    const span = next.t - prev.t;
    const a = span > 0 ? Math.max(0, Math.min(1, (absSec - prev.t) / span)) : 0;
    return Math.round(prev.sampleIdx + (next.sampleIdx - prev.sampleIdx) * a);
}

function getPosAt(ai: number, targetSampleIdx: number, idx: ActorIndex): { x: number; y: number } | null {
    const arr = idx.sampleIdxs[ai];
    if (!arr || arr.length === 0) return null;
    if (targetSampleIdx < arr[0]) return { x: idx.xs[ai][0], y: idx.ys[ai][0] };
    if (targetSampleIdx >= arr[arr.length - 1]) {
        const last = arr.length - 1;
        return { x: idx.xs[ai][last], y: idx.ys[ai][last] };
    }
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= targetSampleIdx) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(0, lo - 1);
    // Lerp to next sample for smooth movement
    if (i + 1 < arr.length) {
        const t0 = arr[i], t1 = arr[i + 1];
        const alpha = t1 > t0 ? (targetSampleIdx - t0) / (t1 - t0) : 0;
        return {
            x: idx.xs[ai][i] + (idx.xs[ai][i + 1] - idx.xs[ai][i]) * alpha,
            y: idx.ys[ai][i] + (idx.ys[ai][i + 1] - idx.ys[ai][i]) * alpha,
        };
    }
    return { x: idx.xs[ai][i], y: idx.ys[ai][i] };
}

function getFacingAt(ai: number, targetSampleIdx: number, idx: ActorIndex): number | null {
    const arr = idx.sampleIdxs[ai];
    if (!arr || arr.length < 2) return null;

    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= targetSampleIdx) lo = mid + 1; else hi = mid;
    }

    const hereIdx = Math.max(1, Math.min(arr.length - 1, lo));
    const hereSample = arr[hereIdx];
    let prevIdx = hereIdx - 1;
    while (prevIdx > 0 && hereSample - arr[prevIdx] < 18) prevIdx--;

    const dx = idx.xs[ai][hereIdx] - idx.xs[ai][prevIdx];
    const dy = idx.ys[ai][hereIdx] - idx.ys[ai][prevIdx];
    return Math.hypot(dx, dy) > 8 ? Math.atan2(dy, dx) : null;
}

function buildClockBySample(posData: PositionsData) {
    const clockBySample = new Float64Array(posData.samples.length);
    const bombStates = posData.bombStates ?? [];
    let bsi = 0;
    for (let s = 0; s < posData.samples.length; s++) {
        while (bsi < bombStates.length && bombStates[bsi].sampleIdx <= s) bsi++;
        const prev = bsi > 0 ? bombStates[bsi - 1] : null;
        const next = bsi < bombStates.length ? bombStates[bsi] : null;
        if (prev && next) {
            const span = next.sampleIdx - prev.sampleIdx;
            clockBySample[s] = prev.t + (next.t - prev.t) * (span > 0 ? (s - prev.sampleIdx) / span : 0);
        } else if (prev) clockBySample[s] = prev.t;
        else if (next) clockBySample[s] = next.t;
    }
    return clockBySample;
}

function sampleIdxForBombSec(clockBySample: Float64Array, targetBombSec: number) {
    if (clockBySample.length === 0) return 0;
    let lo = 0, hi = clockBySample.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (clockBySample[mid] < targetBombSec) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function bridgeMatchPlayers(matchDetails: MatchDetailsData | null | undefined, idx: ActorIndex, clockBySample: Float64Array) {
    const voteByPuuid: Record<string, Record<number, number>> = {};
    for (const kill of matchDetails?.kills ?? []) {
        const sIdx = sampleIdxForBombSec(clockBySample, kill.gameTime / 1000);
        const snap = idx.playerIdxs
            .map(ai => {
                const pos = getPosAt(ai, sIdx, idx);
                return pos ? { ai, x: pos.x, y: pos.y } : null;
            })
            .filter((v): v is { ai: number; x: number; y: number } => v !== null);
        if (snap.length === 0) continue;

        for (const loc of kill.playerLocations ?? []) {
            if (!loc.subject || !loc.location) continue;
            let bestActor = -1;
            let bestD = Infinity;
            for (const candidate of snap) {
                const d = (candidate.x - loc.location.x) ** 2 + (candidate.y - loc.location.y) ** 2;
                if (d < bestD) {
                    bestD = d;
                    bestActor = candidate.ai;
                }
            }
            if (bestActor === -1) continue;
            voteByPuuid[loc.subject] ??= {};
            voteByPuuid[loc.subject][bestActor] = (voteByPuuid[loc.subject][bestActor] ?? 0) + 1;
        }
    }

    const candidates: { puuid: string; ai: number; votes: number }[] = [];
    for (const [puuid, votes] of Object.entries(voteByPuuid)) {
        for (const [ai, count] of Object.entries(votes)) {
            candidates.push({ puuid, ai: Number(ai), votes: count });
        }
    }
    candidates.sort((a, b) => b.votes - a.votes);

    const actorToPuuid = new Map<number, string>();
    const usedPuuids = new Set<string>();
    for (const candidate of candidates) {
        if (usedPuuids.has(candidate.puuid) || actorToPuuid.has(candidate.ai)) continue;
        usedPuuids.add(candidate.puuid);
        actorToPuuid.set(candidate.ai, candidate.puuid);
    }
    return actorToPuuid;
}

function useImageCache(urls: string[]) {
    const [, forceRender] = useState(0);
    return useMemo(() => {
        const cache: Record<string, HTMLImageElement> = {};
        for (const url of [...new Set(urls.filter(Boolean))]) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => forceRender(v => v + 1);
            img.src = url;
            cache[url] = img;
        }
        return cache;
    }, [urls.join('|')]);
}

// ── Coordinate projection ─────────────────────────────────────────────────────

function worldToCanvas(wx: number, wy: number, m: MapInfo, W: number, H: number) {
    return { x: (m.xMultiplier * wy + m.xScalarToAdd) * W, y: (m.yMultiplier * wx + m.yScalarToAdd) * H };
}

function worldToCanvasFallback(wx: number, wy: number, b: PositionsMeta["bounds"], W: number, H: number) {
    const nx = (wx - b.minX) / (b.maxX - b.minX || 1);
    const ny = 1 - (wy - b.minY) / (b.maxY - b.minY || 1);
    return { x: nx * W, y: ny * H };
}

function worldToCanvasBounds(wx: number, wy: number, b: PositionsMeta["bounds"], W: number, H: number, imageBounds: ImageBounds | null) {
    const cp = worldToCanvasFallback(wx, wy, b, W, H);
    if (!imageBounds) return cp;
    const nx = cp.x / W;
    const ny = cp.y / H;
    return {
        x: (imageBounds.left + nx * (imageBounds.right - imageBounds.left)) * W,
        y: (imageBounds.top + ny * (imageBounds.bottom - imageBounds.top)) * H,
    };
}

function worldToCanvasSafe(
    wx: number,
    wy: number,
    map: MapInfo | null,
    bounds: PositionsMeta["bounds"],
    W: number,
    H: number,
    imageBounds: ImageBounds | null,
) {
    if (map && hasMapTransform(map)) {
        return worldToCanvas(wx, wy, map, W, H);
    }
    return worldToCanvasBounds(wx, wy, bounds, W, H, imageBounds);
}

function getImageBounds(img: HTMLImageElement): ImageBounds | null {
    const scratch = document.createElement('canvas');
    scratch.width = img.naturalWidth;
    scratch.height = img.naturalHeight;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, scratch.width, scratch.height);
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const alpha = data[(y * width + x) * 4 + 3];
            if (alpha < 20) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < minX || maxY < minY) return null;
    return {
        left: minX / width,
        top: minY / height,
        right: maxX / width,
        bottom: maxY / height,
    };
}

function hasMapTransform(map: MapInfo) {
    return Number.isFinite(map.xMultiplier)
        && Number.isFinite(map.yMultiplier)
        && Number.isFinite(map.xScalarToAdd)
        && Number.isFinite(map.yScalarToAdd);
}

function getMapSlug(mapUrl: string) {
    return mapUrl.toLowerCase().split('/').filter(Boolean).pop() ?? '';
}

function inferMapFromPositions(maps: MapInfo[], posData: PositionsData, idx: ActorIndex): MapInfo | null {
    const points: { x: number; y: number }[] = [];
    const maxPerActor = 180;

    for (const ai of idx.playerIdxs) {
        const len = idx.xs[ai]?.length ?? 0;
        if (len === 0) continue;
        const step = Math.max(1, Math.floor(len / maxPerActor));
        for (let i = 0; i < len; i += step) {
            points.push({ x: idx.xs[ai][i], y: idx.ys[ai][i] });
        }
    }

    if (points.length === 0) {
        const sampleStep = Math.max(1, Math.floor(posData.samples.length / 1000));
        for (let i = 0; i < posData.samples.length; i += sampleStep) {
            points.push({ x: posData.samples[i][2], y: posData.samples[i][3] });
        }
    }

    let best: { map: MapInfo; score: number } | null = null;
    for (const map of maps) {
        if (!map.displayIcon || !hasMapTransform(map)) continue;
        let inside = 0;
        let near = 0;
        for (const p of points) {
            const x = map.xMultiplier * p.y + map.xScalarToAdd;
            const y = map.yMultiplier * p.x + map.yScalarToAdd;
            if (x >= 0 && x <= 1 && y >= 0 && y <= 1) inside++;
            if (x >= -0.1 && x <= 1.1 && y >= -0.1 && y <= 1.1) near++;
        }
        const score = inside / points.length + (near / points.length) * 0.15;
        if (!best || score > best.score) best = { map, score };
    }

    return best && best.score >= 0.8 ? best.map : null;
}

// ── Component ─────────────────────────────────────────────────────────────────

const TEAM_COLORS = ['#5ac8fa', '#ff5252'];
const TEAM_RGBA = [
    (a: number) => `rgba(90,200,250,${a})`,
    (a: number) => `rgba(255,82,82,${a})`,
];

function teamColor(team: number, alpha: number) {
    return team === 0 || team === 1 ? TEAM_RGBA[team](alpha) : `rgba(200,200,210,${alpha})`;
}

export default function ReplayViewer({ replayId, positions, events, meta, abilities, matchDetails, onClose }: ReplayViewerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [mapInfo, setMapInfo] = useState<MapInfo | null>(null);
    const [mapImg, setMapImg] = useState<HTMLImageElement | null>(null);
    const [mapImgBounds, setMapImgBounds] = useState<ImageBounds | null>(null);
    const [round, setRound] = useState(0);
    const [timeMs, setTimeMs] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [debug, setDebug] = useState(false);
    const [showAbilities, setShowAbilities] = useState(true);
    const [speed, setSpeed] = useState(1);
    const speedRef = useRef(1);

    const actorIdx = useMemo(
        () => buildActorIndex(positions, matchDetails?.players?.length ?? 14),
        [positions, matchDetails]
    );
    const clockBySample = useMemo(() => buildClockBySample(positions), [positions]);
    const actorToPuuid = useMemo(() => bridgeMatchPlayers(matchDetails, actorIdx, clockBySample), [matchDetails, actorIdx, clockBySample]);
    const playerByPuuid = useMemo(() => new Map((matchDetails?.players ?? []).map(p => [p.subject, p])), [matchDetails]);
    const [agentByUuid, setAgentByUuid] = useState<Record<string, AgentMeta>>({});
    const teamOfActor = useMemo(() => {
        const teams = [...actorIdx.teamOf];
        for (const [ai, puuid] of actorToPuuid.entries()) {
            const player = playerByPuuid.get(puuid);
            if (!player) continue;
            teams[ai] = player.teamId === 'Blue' ? 0 : player.teamId === 'Red' ? 1 : teams[ai];
        }
        return teams;
    }, [actorIdx, actorToPuuid, playerByPuuid]);
    useEffect(() => { speedRef.current = speed; }, [speed]);

    const animRef = useRef(0);
    const lastTickRef = useRef(0);
    const lastUiUpdateRef = useRef(0);
    const timeMsRef = useRef(0);
    const zoomRef = useRef(1);
    const panRef = useRef({ x: 0, y: 0 });
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
    const [zoom, setZoom] = useState(1);

    const roundStarts = useMemo(() => events.filter(e => e.g === 'roundStarted').map(e => e.t), [events]);
    const roundCount = roundStarts.length;
    const wallZeroMs = positions.bombStates.length > 0 ? positions.bombStates[0].t * 1000 : 0;

    const roundStartSamples = useMemo(() =>
        roundStarts.map(t => wallMsToSampleIdx(t, positions.bombStates, wallZeroMs)),
        [roundStarts, positions.bombStates, wallZeroMs]
    );

    const deathsByActor = useMemo(() => {
        const map = new Map<number, number[]>();
        for (const kill of matchDetails?.kills ?? []) {
            if (!kill.victim) continue;
            let actorAi = -1;
            for (const [ai, puuid] of actorToPuuid.entries()) {
                if (puuid === kill.victim) { actorAi = ai; break; }
            }
            if (actorAi === -1) continue;
            const sIdx = sampleIdxForBombSec(clockBySample, kill.gameTime / 1000);
            if (!map.has(actorAi)) map.set(actorAi, []);
            map.get(actorAi)!.push(sIdx);
        }
        return map;
    }, [matchDetails, actorToPuuid, clockBySample]);

    const roundDurationMs = (() => {
        const next = roundStarts[round + 1];
        const cur = roundStarts[round] ?? 0;
        return next !== undefined ? Math.min(next - cur, 130_000) : 130_000;
    })();

    const abilityIconCache = useImageCache(abilities.map(ab => ab.icon ?? ''));
    const agentIconCache = useImageCache(
        [...new Set((matchDetails?.players ?? []).map(p => p.characterId))]
            .map(characterId => agentByUuid[characterId.toLowerCase()]?.icon ?? '')
    );

    // Fetch map info from valorant-api.com
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('https://valorant-api.com/v1/maps');
                if (!res.ok) return;
                const data = await res.json() as { data: MapInfo[] };
                const mapUrlLower = meta.mapUrl?.toLowerCase() ?? '';

                let match =
                    data.data.find(m => m.mapUrl?.toLowerCase() === mapUrlLower) ??
                    data.data.find(m => mapUrlLower && m.mapUrl && mapUrlLower.includes(getMapSlug(m.mapUrl))) ??
                    data.data.find(m => meta.mapName && m.displayName.toLowerCase().includes(meta.mapName.toLowerCase()));

                // Validate that the URL-matched map's transform actually projects
                // our player positions onto the minimap (fails for TDM maps whose
                // multipliers are null or belong to a different coordinate space).
                if (match && hasMapTransform(match)) {
                    const samplePoints: { x: number; y: number }[] = [];
                    for (const ai of actorIdx.playerIdxs.slice(0, 5)) {
                        const len = Math.min(actorIdx.xs[ai]?.length ?? 0, 30);
                        for (let i = 0; i < len; i++) {
                            samplePoints.push({ x: actorIdx.xs[ai][i], y: actorIdx.ys[ai][i] });
                        }
                    }
                    if (samplePoints.length > 0) {
                        const inside = samplePoints.filter(p => {
                            const cx = match!.xMultiplier * p.y + match!.xScalarToAdd;
                            const cy = match!.yMultiplier * p.x + match!.yScalarToAdd;
                            return cx >= -0.15 && cx <= 1.15 && cy >= -0.15 && cy <= 1.15;
                        }).length;
                        if (inside / samplePoints.length < 0.5) {
                            // Transform is wrong for this data — try position inference instead
                            match = inferMapFromPositions(data.data, positions, actorIdx) ?? match;
                        }
                    }
                } else if (!match) {
                    match = inferMapFromPositions(data.data, positions, actorIdx) ?? undefined;
                }

                if (match) setMapInfo(match);
            } catch { /* offline or blocked */ }
        })();
    }, [meta, positions, actorIdx]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true');
                if (!res.ok) return;
                const json = await res.json() as { data: { uuid: string; displayName: string; displayIcon: string }[] };
                const next: Record<string, AgentMeta> = {};
                for (const agent of json.data ?? []) {
                    next[agent.uuid.toLowerCase()] = { name: agent.displayName, icon: agent.displayIcon };
                }
                setAgentByUuid(next);
            } catch { /* offline or blocked */ }
        })();
    }, []);

    // Load minimap image
    useEffect(() => {
        if (!mapInfo?.displayIcon) return;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            setMapImg(img);
            setMapImgBounds(getImageBounds(img));
        };
        img.onerror = () => {
            setMapImg(null);
            setMapImgBounds(null);
        };
        img.src = mapInfo.displayIcon;
    }, [mapInfo]);

    // Canvas render
    const render = useCallback((renderWallMs = (roundStarts[round] ?? 0) + timeMsRef.current) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const W = canvas.width, H = canvas.height;
        const idx = actorIdx;

        ctx.clearRect(0, 0, W, H);
        if (!mapImg) { ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, W, H); }

        ctx.save();
        ctx.setTransform(zoomRef.current, 0, 0, zoomRef.current, panRef.current.x, panRef.current.y);

        if (mapImg) {
            ctx.drawImage(mapImg, 0, 0, W, H);
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(0, 0, W, H);
        }

        const sampleIdx = wallMsToSampleIdx(renderWallMs, positions.bombStates, wallZeroMs);
        const bounds = positions.meta.bounds;
                const absSec = (renderWallMs + wallZeroMs) / 1000;

        if (showAbilities) {
            for (const ab of abilities) {
                const endSec = ab.t + ab.life;
                if (ab.t > absSec || endSec < absSec) continue;
                const cp = worldToCanvasSafe(ab.x, ab.y, mapInfo, bounds, W, H, mapImgBounds);
                const team = ab.team === -1 && ab.ownerActor !== undefined ? teamOfActor[ab.ownerActor] : ab.team;
                const fade = 1 - (absSec - ab.t) / ab.life;
                const radius = Math.max(8, ab.radius / 55);
                const outerRadius = ab.outerRadius ? Math.max(radius + 4, ab.outerRadius / 55) : 0;
                const icon = ab.icon ? abilityIconCache[ab.icon] : null;

                ctx.save();
                ctx.globalAlpha = Math.max(0.3, fade);

                if (outerRadius > 0) {
                    ctx.strokeStyle = teamColor(team, 0.4);
                    ctx.lineWidth = 1.2;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.arc(cp.x, cp.y, outerRadius, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                if (ab.type === 'smoke') {
                    const gradient = ctx.createRadialGradient(cp.x, cp.y, radius * 0.3, cp.x, cp.y, radius);
                    gradient.addColorStop(0, 'rgba(225,228,235,0.55)');
                    gradient.addColorStop(0.65, 'rgba(190,200,215,0.30)');
                    gradient.addColorStop(1, 'rgba(170,180,200,0)');
                    ctx.fillStyle = gradient;
                    ctx.beginPath();
                    ctx.arc(cp.x, cp.y, radius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = teamColor(team, 0.65);
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(cp.x, cp.y, radius * 0.92, 0, Math.PI * 2);
                    ctx.stroke();
                } else {
                    ctx.fillStyle = teamColor(team, ab.type === 'molly' ? 0.35 : 0.12);
                    ctx.strokeStyle = teamColor(team, 0.8);
                    ctx.lineWidth = 1.5;
                    if (ab.type === 'wall' || ab.type === 'wall-seg') {
                        ctx.fillRect(cp.x - radius * 0.5, cp.y - radius * 0.5, radius, radius);
                        ctx.strokeRect(cp.x - radius * 0.5, cp.y - radius * 0.5, radius, radius);
                    } else {
                        ctx.beginPath();
                        ctx.arc(cp.x, cp.y, radius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                    }
                }

                const iconSize = ab.type === 'smoke' ? 22 : ab.type === 'wall-seg' ? 12 : 18;
                if (icon && icon.complete && icon.naturalWidth > 0) {
                    ctx.fillStyle = team >= 0 ? teamColor(team, 0.85) : 'rgba(10,12,18,0.75)';
                    ctx.beginPath();
                    ctx.arc(cp.x, cp.y, iconSize * 0.62, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.drawImage(icon, cp.x - iconSize / 2, cp.y - iconSize / 2, iconSize, iconSize);
                } else {
                    ctx.fillStyle = teamColor(team, 0.9);
                    ctx.beginPath();
                    ctx.arc(cp.x, cp.y, 3.5, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        }

        // Players
        for (const ai of idx.playerIdxs) {
            const color = teamOfActor[ai] >= 0 ? TEAM_COLORS[teamOfActor[ai]] : '#fff';
            const puuid = actorToPuuid.get(ai);
            const player = puuid ? playerByPuuid.get(puuid) : null;
            const agent = player ? agentByUuid[player.characterId.toLowerCase()] : null;
            const agentIcon = agent?.icon ? agentIconCache[agent.icon] : null;

            // Check if dead — draw ✕ at death spot and skip live rendering
            const deaths = deathsByActor.get(ai);
            if (deaths && deaths.length > 0) {
                let lastDeath = -1;
                for (const d of deaths) {
                    if (d <= sampleIdx && d > lastDeath) lastDeath = d;
                }
                if (lastDeath !== -1) {
                    let nextRoundSample = Infinity;
                    for (const rs of roundStartSamples) {
                        if (rs > lastDeath && rs < nextRoundSample) nextRoundSample = rs;
                    }
                    const respawnSample = nextRoundSample < Infinity ? nextRoundSample : lastDeath + 300;
                    if (sampleIdx < respawnSample) {
                        const deathPos = getPosAt(ai, lastDeath, idx);
                        if (deathPos) {
                            const dc = worldToCanvasSafe(deathPos.x, deathPos.y, mapInfo, bounds, W, H, mapImgBounds);
                            const sz = 6;
                            ctx.save();
                            ctx.globalAlpha = 0.75;
                            ctx.strokeStyle = color;
                            ctx.lineWidth = 2.5;
                            ctx.lineCap = 'round';
                            ctx.beginPath();
                            ctx.moveTo(dc.x - sz, dc.y - sz); ctx.lineTo(dc.x + sz, dc.y + sz);
                            ctx.moveTo(dc.x + sz, dc.y - sz); ctx.lineTo(dc.x - sz, dc.y + sz);
                            ctx.stroke();
                            ctx.restore();
                        }
                        continue;
                    }
                }
            }

            const pos = getPosAt(ai, sampleIdx, idx);
            if (!pos) continue;
            const cp = worldToCanvasSafe(pos.x, pos.y, mapInfo, bounds, W, H, mapImgBounds);
            const dotR = 12;

            // Solid filled dot — no hollow center
            ctx.shadowColor = color;
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, dotR, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.shadowBlur = 0;

            if (agentIcon && agentIcon.complete && agentIcon.naturalWidth > 0) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(cp.x, cp.y, dotR - 1.5, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(agentIcon, cp.x - (dotR - 1.5), cp.y - (dotR - 1.5), (dotR - 1.5) * 2, (dotR - 1.5) * 2);
                ctx.restore();
            }

            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, dotR, 0, Math.PI * 2);
            ctx.stroke();

            const yaw = getFacingAt(ai, sampleIdx, idx);
            if (yaw !== null) {
                const facePoint = worldToCanvasSafe(
                    pos.x + 250 * Math.cos(yaw),
                    pos.y + 250 * Math.sin(yaw),
                    mapInfo,
                    bounds,
                    W,
                    H,
                    mapImgBounds,
                );
                const dx = facePoint.x - cp.x;
                const dy = facePoint.y - cp.y;
                const mag = Math.hypot(dx, dy);
                if (mag > 0.5) {
                    const ux = dx / mag;
                    const uy = dy / mag;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2.5;
                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    ctx.moveTo(cp.x + ux * dotR, cp.y + uy * dotR);
                    ctx.lineTo(cp.x + ux * (dotR + 12), cp.y + uy * (dotR + 12));
                    ctx.stroke();
                    ctx.lineCap = 'butt';
                }
            }
        }

        ctx.restore();

        if (debug) {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(4, 4, 360, 126);
            ctx.fillStyle = '#0f0';
            ctx.font = '11px monospace';
            const sample0 = positions.samples[0];
            const firstPlayer = idx.playerIdxs[0];
            const fp = firstPlayer !== undefined ? getPosAt(firstPlayer, sampleIdx, idx) : null;
            const fpc = fp ? worldToCanvasSafe(fp.x, fp.y, mapInfo, bounds, W, H, mapImgBounds) : null;
            ctx.fillText(`samples: ${positions.samples.length}  guids: ${positions.meta.uniqueGuids.length}`, 10, 20);
            ctx.fillText(`bombStates: ${positions.bombStates.length}  players: ${idx.playerIdxs.length}`, 10, 36);
            ctx.fillText(`wallMs:${renderWallMs.toFixed(0)}  wallZero:${wallZeroMs.toFixed(0)}`, 10, 52);
            ctx.fillText(`sampleIdx:${sampleIdx}  map:${mapInfo?.displayName ?? 'none'}`, 10, 68);
            ctx.fillText(`bounds:${JSON.stringify(bounds).slice(0,42)}`, 10, 84);
            ctx.fillText(`s[0]:[${sample0?.[0]},${sample0?.[1]?.slice(0,8)},${sample0?.[2]},${sample0?.[3]}]`, 10, 100);
            ctx.fillText(`player0: ${fp ? `${fp.x.toFixed(0)},${fp.y.toFixed(0)}` : 'null'} canvas:${fpc ? `${fpc.x.toFixed(0)},${fpc.y.toFixed(0)}` : 'null'}`, 10, 116);
        }
    }, [abilityIconCache, actorToPuuid, agentByUuid, agentIconCache, debug, deathsByActor, mapImg, mapImgBounds, mapInfo, playerByPuuid, positions, abilities, round, roundStartSamples, roundStarts, showAbilities, teamOfActor, wallZeroMs]);

    useEffect(() => { render(); }, [render]);

    // Zoom via mouse wheel (centered on cursor) + pan via drag
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const mx = (e.clientX - rect.left) * scaleX;
            const my = (e.clientY - rect.top) * scaleY;
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const oldZoom = zoomRef.current;
            const newZoom = Math.max(1, Math.min(10, oldZoom * factor));
            if (newZoom === 1) {
                panRef.current = { x: 0, y: 0 };
            } else {
                panRef.current = {
                    x: mx - (mx - panRef.current.x) * (newZoom / oldZoom),
                    y: my - (my - panRef.current.y) * (newZoom / oldZoom),
                };
            }
            zoomRef.current = newZoom;
            setZoom(newZoom);
            render();
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', onWheel);
    }, [render]);

    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        if (zoomRef.current <= 1) return;
        isDraggingRef.current = true;
        const canvas = canvasRef.current;
        const rect = canvas?.getBoundingClientRect();
        const scaleX = canvas && rect ? canvas.width / rect.width : 1;
        const scaleY = canvas && rect ? canvas.height / rect.height : 1;
        dragStartRef.current = {
            x: e.clientX * scaleX, y: e.clientY * scaleY,
            panX: panRef.current.x, panY: panRef.current.y,
        };
    }, []);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!isDraggingRef.current) return;
        const canvas = canvasRef.current;
        const rect = canvas?.getBoundingClientRect();
        const scaleX = canvas && rect ? canvas.width / rect.width : 1;
        const scaleY = canvas && rect ? canvas.height / rect.height : 1;
        panRef.current = {
            x: dragStartRef.current.panX + (e.clientX * scaleX - dragStartRef.current.x),
            y: dragStartRef.current.panY + (e.clientY * scaleY - dragStartRef.current.y),
        };
        render();
    }, [render]);

    const handleMouseUp = useCallback(() => { isDraggingRef.current = false; }, []);

    const resetZoom = useCallback(() => {
        zoomRef.current = 1;
        panRef.current = { x: 0, y: 0 };
        setZoom(1);
        render();
    }, [render]);

    const exportJson = useCallback(() => {
        const data = { id: replayId ?? '', meta, positions, events, abilities, matchDetails };
        const jsonStr = JSON.stringify(data, null, 2);
        const defaultName = `${replayId ?? `replay-${(meta.mapName ?? 'unknown').replace(/\s+/g, '-')}`}.json`;
        window.Main.removeAllListeners('replay:export-json');
        window.Main.on('replay:export-json', () => {
            window.Main.removeAllListeners('replay:export-json');
        });
        window.Main.send('replay:export-json', jsonStr, defaultName);
    }, [positions, events, meta, abilities, matchDetails]);

    // Playback loop: draw every frame, but update React state only occasionally.
    useEffect(() => {
        if (!playing) { cancelAnimationFrame(animRef.current); return; }
        const tick = (now: number) => {
            const delta = lastTickRef.current ? now - lastTickRef.current : 16;
            lastTickRef.current = now;

            const next = Math.min(timeMsRef.current + delta * speedRef.current, roundDurationMs);
            timeMsRef.current = next;
            render((roundStarts[round] ?? 0) + next);

            if (now - lastUiUpdateRef.current > 100 || next >= roundDurationMs) {
                lastUiUpdateRef.current = now;
                setTimeMs(next);
            }
            if (next >= roundDurationMs) {
                setPlaying(false);
                return;
            }
            animRef.current = requestAnimationFrame(tick);
        };
        lastTickRef.current = 0;
        animRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animRef.current);
    }, [playing, roundDurationMs, render, round, roundStarts]);

    const fmt = (ms: number) => {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    return (
        <div className="flex flex-col h-full bg-black">
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
                <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors flex items-center gap-1.5 text-sm">
                    <FaArrowLeft /> Back
                </button>
                <span className="text-white font-medium text-sm">
                    {mapInfo?.displayName ?? meta.mapName ?? 'Replay Viewer'}
                </span>
                {!mapInfo && <span className="text-xs text-gray-600">(no map — using fallback projection)</span>}
                <div className="ml-auto flex items-center gap-3">
                    {zoom !== 1 && (
                        <button onClick={resetZoom} className="text-xs text-gray-400 hover:text-white transition-colors">
                            {Math.round(zoom * 100)}% · Reset
                        </button>
                    )}
                    <button
                        onClick={exportJson}
                        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-cyan-300 transition-colors"
                        title="Export replay data as JSON"
                    >
                        <FaDownload /> Export JSON
                    </button>
                    <button
                        onClick={() => setDebug(v => !v)}
                        className={`flex items-center gap-1.5 text-xs transition-colors ${debug ? 'text-cyan-300' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        <FaBug /> Debug
                    </button>
                </div>
            </div>

            {/* Canvas */}
            <div className="flex-1 relative overflow-hidden flex items-center justify-center bg-black min-h-0">
                <canvas
                    ref={canvasRef}
                    width={600}
                    height={600}
                    className="max-w-full max-h-full"
                    style={{ imageRendering: 'pixelated', cursor: isDraggingRef.current ? 'grabbing' : zoom > 1 ? 'grab' : 'default' }}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                />
                <div className="absolute top-2 right-2 flex flex-col gap-1 text-xs bg-black/60 rounded px-2 py-1.5">
                    {TEAM_COLORS.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: c }} />
                            <span className="text-gray-300">Team {i === 0 ? 'A' : 'B'}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Controls */}
            <div className="shrink-0 px-4 pb-3 pt-2 border-t border-white/10 flex flex-col gap-2">
                {/* Round tabs */}
                {roundCount > 1 && (
                    <div className="flex gap-1 overflow-x-auto pb-0.5">
                        {Array.from({ length: roundCount }, (_, i) => (
                            <button
                                key={i}
                                onClick={() => { timeMsRef.current = 0; setRound(i); setTimeMs(0); setPlaying(false); render(roundStarts[i] ?? 0); }}
                                className={`shrink-0 px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                                    round === i ? 'bg-cyan-500 text-black font-bold' : 'bg-white/10 text-gray-400 hover:bg-white/20'
                                }`}
                            >
                                R{i + 1}
                            </button>
                        ))}
                    </div>
                )}

                {/* Scrubber */}
                <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-gray-400 w-10 shrink-0">{fmt(timeMs)}</span>
                    <input
                        type="range" min={0} max={roundDurationMs} value={timeMs}
                        onChange={e => {
                            const next = +e.target.value;
                            timeMsRef.current = next;
                            setTimeMs(next);
                            setPlaying(false);
                            render((roundStarts[round] ?? 0) + next);
                        }}
                        className="flex-1 accent-cyan-400 h-1"
                    />
                    <span className="text-xs font-mono text-gray-500 w-10 shrink-0 text-right">{fmt(roundDurationMs)}</span>
                </div>

                {/* Playback */}
                <div className="flex items-center justify-center gap-3">
                    <button onClick={() => {
                        const nextRound = Math.max(0, round - 1);
                        timeMsRef.current = 0;
                        setRound(nextRound);
                        setTimeMs(0);
                        setPlaying(false);
                        render(roundStarts[nextRound] ?? 0);
                    }}
                        disabled={round === 0} className="text-gray-400 hover:text-white disabled:opacity-30 p-1">
                        <FaStepBackward />
                    </button>
                    <button onClick={() => setPlaying(p => !p)}
                        className="w-9 h-9 rounded-full bg-cyan-500 text-black flex items-center justify-center hover:bg-cyan-400 transition-colors">
                        {playing ? <FaPause className="text-sm" /> : <FaPlay className="text-sm" />}
                    </button>
                    <button onClick={() => {
                        const nextRound = Math.min(roundCount - 1, round + 1);
                        timeMsRef.current = 0;
                        setRound(nextRound);
                        setTimeMs(0);
                        setPlaying(false);
                        render(roundStarts[nextRound] ?? 0);
                    }}
                        disabled={round >= roundCount - 1} className="text-gray-400 hover:text-white disabled:opacity-30 p-1">
                        <FaStepForward />
                    </button>
                </div>

                <div className="flex items-center justify-center gap-2 text-xs flex-wrap">
                    <button
                        onClick={() => setShowAbilities(v => !v)}
                        className={`flex items-center gap-1.5 rounded px-2 py-1 transition-colors ${
                            showAbilities ? 'bg-cyan-500/20 text-cyan-300' : 'bg-white/10 text-gray-500'
                        }`}
                    >
                        <FaMagic />
                        Abilities
                    </button>
                    <span className="text-gray-500">
                        {abilities.length > 0 ? `${abilities.length} loaded` : 'none loaded'}
                    </span>
                    <span className="text-gray-700 select-none">|</span>
                    {([0.5, 1, 2, 4] as const).map(s => (
                        <button
                            key={s}
                            onClick={() => setSpeed(s)}
                            className={`px-2 py-0.5 rounded transition-colors ${
                                speed === s
                                    ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/40'
                                    : 'bg-white/10 text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            {s}×
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
