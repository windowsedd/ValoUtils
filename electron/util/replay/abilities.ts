import fs from 'node:fs';

// TypeScript port of build-abilities.mjs from ValorantWebReplayer
// Reads channels.jsonl + positions.json, fetches agent data, writes abilities.json

interface AgentAbility {
    slot: string;
    displayName: string;
    displayIcon: string;
}
interface AgentData {
    developerName?: string;
    displayName: string;
    displayIcon: string;
    backgroundGradientColors?: string[];
    abilities?: AgentAbility[];
}
interface AgentEntry {
    displayName: string;
    icon: string;
    sigColor: string;
    abilitiesBySlot: Record<string, { displayName: string; icon: string }>;
}

const ABILITY_CLASSES: [string[], string[], string, number, number, number | null][] = [
    [['FlameWall_ThroughWall'], ['Grenade'], 'wall-cast', 3, 80, null],
    [['Phoenix_E_FlareCurve_Synced_Right', 'FlareCurve_Synced_Right'], ['Ability2'], 'flash-proj-right', 2, 400, null],
    [['Phoenix_E_FlareCurve', 'FlareCurve'], ['Ability2'], 'flash-proj-left', 2, 400, null],
    [['Projectile_Phoenix_4_Molotov'], ['Ability1'], 'grenade', 3, 100, null],
    [['Patch_Phoenix_MolotovFire', 'MolotovFire'], ['Ability1'], 'molly', 6, 280, null],
    [['Smoke', 'NewSmoke', 'DarkCover', 'Ruse'], ['Ability2', 'Grenade'], 'smoke', 19, 600, 750],
    [['Wall_Fortifying'], ['Grenade', 'Ability2'], 'wall', 30, 100, null],
    [['Wall_Segment'], ['Grenade', 'Ability2'], 'wall-seg', 30, 75, null],
    [['SlowField', 'Slow'], ['Ability1'], 'slow', 7, 270, null],
    [['Molly', 'Burn', 'Incendiary'], ['Ability1', 'Grenade'], 'molly', 7, 320, null],
    [['Satchel_Arming', 'Satchel_Production'], ['Ability1'], 'satchel', 5, 50, null],
    [['Satchel_Explosion', 'Q_Explosion'], ['Ability1'], 'satchel-boom', 1, 350, 700],
    [['BoomBot', 'Projectile_Secondary', 'PaintShells'], ['Ability2', 'Grenade'], 'grenade', 3, 350, 700],
    [['Trailblazer', 'PossessableScout', 'ScoutAbilities'], ['Ability1', 'Grenade'], 'drone', 10, 50, null],
    [['Drone', 'OwlDrone'], ['Grenade'], 'drone', 10, 50, null],
    [['HawkFlash_FlashSource', 'FlashSource'], ['Ability2', 'Ability1'], 'flash-src', 3, 1500, null],
    [['HawkFlash_C', 'Projectile_Guide_E_HawkFlash'], ['Ability2', 'Ability1'], 'flash-proj', 2, 100, null],
    [['GuidingLight'], ['Ability2'], 'flash-src', 3, 1500, null],
    [['Flash'], ['Ability2', 'Ability1'], 'flash', 2, 600, null],
    [['LoSReveal', 'Reveal', 'Haunt', 'Spycam'], ['Ability2'], 'reveal', 5, 600, null],
    [['NearsightAOE', 'Leer'], ['Grenade'], 'leer', 4, 200, null],
    [['CyberCage'], ['Ability1'], 'smoke', 12, 250, null],
    [['Phoenix_Q_FireballWall', 'FireballWall', 'FlameWall'], ['Grenade'], 'wall', 8, 80, null],
    [['Phoenix_X_SelfRes', 'SelfRes', 'ResTarget'], ['Ultimate'], 'postdeath', 3, 100, null],
    [['Heal_HealPool', 'HealPool'], ['Ability1'], 'heal-pool', 6, 150, null],
    [['PostDeath_PC', 'PostDeath_ReactiveResStart', 'ReactiveResStart'], ['Grenade', 'Ultimate'], 'postdeath', 3, 100, null],
];

function classifyAbility(cls: string, agent: AgentEntry) {
    for (const [keywords, slotOrder, type, life, radius, outerRadius] of ABILITY_CLASSES) {
        if (!keywords.some(k => cls.includes(k))) continue;
        let info: { displayName: string; icon: string } | null = null;
        for (const s of slotOrder) {
            if (agent.abilitiesBySlot[s]) { info = agent.abilitiesBySlot[s]; break; }
        }
        return { type, life, radius, outerRadius, ability: info?.displayName ?? type, icon: info?.icon ?? '' };
    }
    return null;
}

function parseClass(cls: string, agentByDev: Record<string, AgentEntry>) {
    const m = cls.match(/^(?:GameObject|Projectile|Ability|Patch|FXC)_(\w+?)_/);
    if (!m) return null;
    const devName = m[1].toLowerCase();
    const agent = agentByDev[devName];
    if (!agent) return null;
    return { devName, agent };
}

interface PositionsData {
    meta: { uniqueGuids: string[] };
    samples: [number, string, number, number, number][];
    bombStates: { t: number; sampleIdx: number }[];
}

export async function buildAbilities(channelsPath: string, positionsPath: string, abilitiesPath: string) {
    const agentsRes = await fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true');
    const agentsJson = await agentsRes.json() as { data: AgentData[] };
    const agents = agentsJson.data;

    const agentByDev: Record<string, AgentEntry> = {};
    for (const a of agents) {
        const dev = (a.developerName ?? '').toLowerCase();
        if (!dev) continue;
        let sigColor = '#888';
        for (const c of (a.backgroundGradientColors ?? [])) {
            if (!c) continue;
            const hex = c.slice(0, 6);
            const luma = parseInt(hex.slice(0, 2), 16) + parseInt(hex.slice(2, 4), 16) + parseInt(hex.slice(4, 6), 16);
            if (luma > 120) { sigColor = '#' + hex; break; }
        }
        agentByDev[dev] = { displayName: a.displayName, icon: a.displayIcon, sigColor, abilitiesBySlot: {} };
        for (const ab of (a.abilities ?? [])) {
            if (ab.displayIcon) agentByDev[dev].abilitiesBySlot[ab.slot] = { displayName: ab.displayName, icon: ab.displayIcon };
        }
    }

    const posData = JSON.parse(fs.readFileSync(positionsPath, 'utf8')) as PositionsData;
    const N = posData.samples.length;
    const bombStates = posData.bombStates ?? [];

    const clockBySample = new Float64Array(N);
    {
        let bsi = 0;
        for (let s = 0; s < N; s++) {
            while (bsi < bombStates.length && bombStates[bsi].sampleIdx <= s) bsi++;
            const prev = bsi > 0 ? bombStates[bsi - 1] : null;
            const next = bsi < bombStates.length ? bombStates[bsi] : null;
            if (prev && next) {
                const span = next.sampleIdx - prev.sampleIdx;
                clockBySample[s] = prev.t + (next.t - prev.t) * (span > 0 ? (s - prev.sampleIdx) / span : 0);
            } else if (prev) clockBySample[s] = prev.t;
            else if (next) clockBySample[s] = next.t;
        }
    }

    const guidIdx = new Map(posData.meta.uniqueGuids.map((g, i) => [g, i]));
    const numActors = posData.meta.uniqueGuids.length;
    const sampleCountByGuid = new Uint32Array(numActors);
    for (let s = 0; s < N; s++) {
        const ai = guidIdx.get(posData.samples[s][1]);
        if (ai !== undefined) sampleCountByGuid[ai]++;
    }

    const actorStream = new Array<Uint32Array>(numActors);
    const actorX = new Array<Float32Array>(numActors);
    const actorY = new Array<Float32Array>(numActors);
    for (let ai = 0; ai < numActors; ai++) {
        actorStream[ai] = new Uint32Array(sampleCountByGuid[ai]);
        actorX[ai] = new Float32Array(sampleCountByGuid[ai]);
        actorY[ai] = new Float32Array(sampleCountByGuid[ai]);
    }
    const w = new Uint32Array(numActors);
    for (let s = 0; s < N; s++) {
        const ai = guidIdx.get(posData.samples[s][1]);
        if (ai === undefined) continue;
        actorStream[ai][w[ai]] = s;
        actorX[ai][w[ai]] = posData.samples[s][2];
        actorY[ai][w[ai]] = posData.samples[s][3];
        w[ai]++;
    }

    const playerIdxs = Array.from({ length: numActors }, (_, i) => i)
        .sort((a, b) => sampleCountByGuid[b] - sampleCountByGuid[a]).slice(0, 10);

    const spawn = playerIdxs.map(ai => ({ ai, y: actorY[ai][0] ?? 0 })).sort((a, b) => a.y - b.y);
    const teamOfActor = new Int8Array(numActors).fill(-1);
    spawn.slice(0, 5).forEach(p => { teamOfActor[p.ai] = 0; });
    spawn.slice(5, 10).forEach(p => { teamOfActor[p.ai] = 1; });

    function actorPosAt(ai: number, sIdx: number) {
        const arr = actorStream[ai];
        if (arr.length === 0 || sIdx < arr[0]) return null;
        const last = arr.length - 1;
        if (sIdx >= arr[last]) return { x: actorX[ai][last], y: actorY[ai][last] };
        let lo = 0, hi = last;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < sIdx) lo = mid + 1; else hi = mid; }
        return { x: actorX[ai][Math.max(0, lo - 1)], y: actorY[ai][Math.max(0, lo - 1)] };
    }

    function streamIdxForBombSec(t: number) {
        let lo = 0, hi = N - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (clockBySample[mid] < t) lo = mid + 1; else hi = mid; }
        return lo;
    }

    function nearestPlayerActor(x: number, y: number, t: number) {
        const sIdx = streamIdxForBombSec(t);
        let best = -1, bestD = Infinity;
        for (const ai of playerIdxs) {
            const p = actorPosAt(ai, sIdx); if (!p) continue;
            const d = (p.x - x) ** 2 + (p.y - y) ** 2;
            if (d < bestD) { bestD = d; best = ai; }
        }
        return best;
    }

    interface ChannelEvent {
        ev: string;
        t: number;
        x: number;
        y: number;
        cls: string;
    }

    const out: unknown[] = [];
    let skipped = 0, unknownAgent = 0, unknownCls = 0;
    const lines = fs.readFileSync(channelsPath, 'utf8').split('\n');
    for (const line of lines) {
        if (!line.startsWith('{"ev":"open"')) continue;
        const o = JSON.parse(line) as ChannelEvent;
        if (o.t === 0) { skipped++; continue; }
        if (o.x === 0 && o.y === 0) { skipped++; continue; }
        const parsed = parseClass(o.cls, agentByDev);
        if (!parsed) { unknownAgent++; continue; }
        const cls = classifyAbility(o.cls, parsed.agent);
        if (!cls) { unknownCls++; continue; }
        const ownerActor = nearestPlayerActor(o.x, o.y, o.t);
        const team = ownerActor !== -1 ? teamOfActor[ownerActor] : -1;
        out.push({
            t: o.t, x: o.x, y: o.y,
            cls: o.cls,
            agent: parsed.agent.displayName,
            ability: cls.ability,
            type: cls.type,
            life: cls.life,
            radius: cls.radius,
            outerRadius: cls.outerRadius,
            icon: cls.icon,
            team,
            ownerActor,
        });
    }

    fs.writeFileSync(abilitiesPath, JSON.stringify(out));
    console.log(`[replay] abilities: ${out.length} entries (skipped=${skipped} unknownAgent=${unknownAgent} unknownCls=${unknownCls})`);
}
