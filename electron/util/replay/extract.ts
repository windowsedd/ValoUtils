import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

interface ParsedField {
    Name: string;
    Value: unknown;
}

type ParsedLine = {
    ch: number;
    type: string;
    fields: ParsedField[];
};

const MOVEMENT_TYPE = 'ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getProp(obj: unknown, ...names: string[]): unknown {
    if (!isRecord(obj)) return undefined;
    for (const name of names) {
        if (name in obj) return obj[name];
        const match = Object.keys(obj).find(k => k.toLowerCase() === name.toLowerCase());
        if (match) return obj[match];
    }
    return undefined;
}

function unwrapValue(value: unknown): unknown {
    let current = value;
    while (isRecord(current) && 'Value' in current && Object.keys(current).length <= 2) {
        current = current.Value;
    }
    return current;
}

function getField(fields: ParsedField[], ...names: string[]): unknown {
    const field = fields.find(f => names.some(name => f.Name.toLowerCase() === name.toLowerCase()));
    return field ? unwrapValue(field.Value) : undefined;
}

function toNumber(value: unknown): number | null {
    const unwrapped = unwrapValue(value);
    if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return unwrapped;
    if (typeof unwrapped === 'string' && unwrapped.trim() !== '') {
        const parsed = Number(unwrapped);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toPosition(value: unknown): { X: number; Y: number } | null {
    const unwrapped = unwrapValue(value);
    const x = toNumber(getProp(unwrapped, 'X', 'x'));
    const y = toNumber(getProp(unwrapped, 'Y', 'y'));
    return x === null || y === null ? null : { X: x, Y: y };
}

function toRotationZ(value: unknown): number {
    const unwrapped = unwrapValue(value);
    return toNumber(getProp(unwrapped, 'Z', 'z')) ?? 0;
}

function toArray(value: unknown): unknown[] {
    const unwrapped = unwrapValue(value);
    return Array.isArray(unwrapped) ? unwrapped : [];
}

function parseLine(line: string): ParsedLine | null {
    const m = line.match(/^Chindex=(\d+)\s+Type=([^\s]+)\s+Fields=(\[.*\])$/);
    if (m) {
        try {
            return { ch: +m[1], type: m[2], fields: JSON.parse(m[3]) as ParsedField[] };
        } catch {
            return null;
        }
    }

    try {
        const obj = JSON.parse(line) as unknown;
        if (!isRecord(obj)) return null;
        const ch = toNumber(getProp(obj, 'Chindex', 'ChannelIndex', 'ch'));
        const type = unwrapValue(getProp(obj, 'Type', 'type'));
        const fields = unwrapValue(getProp(obj, 'Fields', 'fields'));
        if (ch === null || typeof type !== 'string' || !Array.isArray(fields)) return null;
        return { ch, type, fields: fields as ParsedField[] };
    } catch {
        return null;
    }
}

function getMovementUpdates(fields: ParsedField[]): unknown[] {
    const direct = toArray(getField(fields, 'RemoteCharacterUpdates', 'CharacterUpdates', 'Updates'));
    if (direct.length > 0) return direct;

    const candidates = fields.flatMap(field => toArray(field.Value));
    return candidates.filter(candidate => {
        const guid = getProp(candidate, 'ShooterCharacterNetGuidValue', 'ShooterCharacterNetGuid', 'CharacterNetGuidValue', 'NetGuidValue');
        const stream = getProp(candidate, 'ComponentDataStream', 'ComponentData', 'DataStream');
        return guid !== undefined || getProp(stream, 'Moves', 'moves') !== undefined;
    });
}

function getGuid(update: unknown): string | null {
    const value = unwrapValue(getProp(update, 'ShooterCharacterNetGuidValue', 'ShooterCharacterNetGuid', 'CharacterNetGuidValue', 'NetGuidValue', 'Guid'));
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
    return null;
}

function getMoves(update: unknown): unknown[] {
    const stream = getProp(update, 'ComponentDataStream', 'ComponentData', 'DataStream');
    const moves = getProp(stream, 'Moves', 'moves');
    return toArray(moves);
}

// TypeScript port of extract-stream.mjs from ValorantWebReplayer
// Reads decode-full.txt (parser stdout) and writes positions.json, events.json, meta.json
export function extractStream(decodePath: string, outDir: string, mapHint = ''): Promise<void> {
    return new Promise((resolve, reject) => {
        const samples: [number, string, number, number, number][] = [];
        const playerStateByCh: Record<number, Record<string, unknown>> = {};
        const teamByCh: Record<number, number> = {};
        let mapUrl = '';
        const phaseEvents: { phase: number; sampleIdx: number }[] = [];
        const bombStates: { t: number; sampleIdx: number }[] = [];
        const guidsSeen = new Set<string>();
        let movementLines = 0;
        let movementMoves = 0;

        const rl = readline.createInterface({
            input: fs.createReadStream(decodePath, { encoding: 'utf8' }),
            crlfDelay: Infinity,
        });

        rl.on('line', (line) => {
            const parsed = parseLine(line);
            if (!parsed) {
                const mu = line.match(/^MapUrl=(.+)$/);
                if (mu) mapUrl = mu[1].trim();
                return;
            }
            const { ch, type, fields } = parsed;
            const foundMapUrl = getField(fields, 'MapUrl', 'MapURL', 'MapAssetPath', 'MapName');
            if (!mapUrl && typeof foundMapUrl === 'string') mapUrl = foundMapUrl;

            if (type === MOVEMENT_TYPE || type.includes('RemoteCharacterUpdates')) {
                movementLines++;
                const updates = getMovementUpdates(fields);
                for (const u of updates) {
                    const guid = getGuid(u);
                    if (!guid) continue;
                    const moves = getMoves(u);
                    if (moves.length === 0) continue;
                    guidsSeen.add(guid);
                    for (const mv of moves) {
                        const position = toPosition(getProp(mv, 'Position', 'position'));
                        if (!position) continue;
                        const timestamp = toNumber(getProp(mv, 'Timestamp', 'timestamp')) ?? 0;
                        const rotationZ = toRotationZ(getProp(mv, 'RotationInput', 'rotationInput', 'Rotation', 'rotation'));
                        movementMoves++;
                        samples.push([
                            timestamp | 0,
                            guid,
                            +position.X.toFixed(1),
                            +position.Y.toFixed(1),
                            +rotationZ.toFixed(2),
                        ]);
                    }
                }
            } else if (type === 'BombPlayerState') {
                const obj = playerStateByCh[ch] ?? {};
                for (const f of fields) obj[f.Name] = f.Value;
                playerStateByCh[ch] = obj;
            } else if (type === 'BombTeamComponent') {
                const tf = fields.find(f => f.Name === 'Team');
                if (tf) teamByCh[ch] = tf.Value as number;
            } else if (type === 'ClientGamePhaseEnded') {
                const of_ = fields.find(f => f.Name === 'OldPhase');
                if (of_) phaseEvents.push({ phase: of_.Value as number, sampleIdx: samples.length });
            } else if (type === 'BombGameState') {
                const tf = fields.find(f => f.Name === 'ReplicatedWorldTimeSecondsDouble');
                if (tf) bombStates.push({ t: +(tf.Value as number).toFixed(3), sampleIdx: samples.length });
            }
        });

        rl.on('close', () => {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const s of samples) {
                if (s[2] < minX) minX = s[2]; if (s[2] > maxX) maxX = s[2];
                if (s[3] < minY) minY = s[3]; if (s[3] > maxY) maxY = s[3];
            }

            const players: Record<number, Record<string, unknown> & { team?: number }> = {};
            for (const ch in playerStateByCh) {
                players[+ch] = { ...playerStateByCh[+ch], team: teamByCh[+ch] };
            }

            const positions = {
                meta: {
                    source: path.basename(decodePath),
                    generatedAt: new Date().toISOString(),
                    movementLines, movementMoves,
                    uniqueGuids: [...guidsSeen],
                    bounds: { minX, maxX, minY, maxY },
                    sampleCount: samples.length,
                    phaseEventCount: phaseEvents.length,
                    bombStateCount: bombStates.length,
                },
                players,
                phaseEvents,
                bombStates,
                samples,
            };
            fs.writeFileSync(path.join(outDir, 'positions.json'), JSON.stringify(positions));

            if (samples.length === 0) {
                reject(new Error(`No replay movement samples were extracted from ${path.basename(decodePath)}. Found ${movementLines} movement lines and ${movementMoves} moves.`));
                return;
            }

            // events.json: round starts via OldPhase=2 (buy phase ended = combat start)
            const events: { g: string; t: number }[] = [];
            if (bombStates.length > 0) {
                const sampleToWallMs = (sIdx: number) => {
                    let lo = 0, hi = bombStates.length - 1;
                    while (lo < hi) {
                        const mid = (lo + hi) >> 1;
                        if (bombStates[mid].sampleIdx < sIdx) lo = mid + 1; else hi = mid;
                    }
                    const next = bombStates[lo];
                    const prev = lo > 0 ? bombStates[lo - 1] : null;
                    if (!prev) return next.t * 1000;
                    const span = next.sampleIdx - prev.sampleIdx;
                    const a = span > 0 ? (sIdx - prev.sampleIdx) / span : 0;
                    return (prev.t + (next.t - prev.t) * a) * 1000;
                };
                const wallZero = sampleToWallMs(0);
                const seenStarts = new Set<number>();
                for (const pe of phaseEvents) {
                    if (pe.phase !== 2) continue;
                    if (seenStarts.has(pe.sampleIdx)) continue;
                    seenStarts.add(pe.sampleIdx);
                    events.push({ g: 'roundStarted', t: Math.round(sampleToWallMs(pe.sampleIdx) - wallZero) });
                }
                if (events.length === 0) events.push({ g: 'roundStarted', t: 0 });
            }
            fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(events));

            const meta = { mapUrl: mapUrl || '', mapName: mapHint, generatedAt: new Date().toISOString() };
            fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta));

            console.log(`[replay] extract: ${samples.length} samples, ${guidsSeen.size} guids, ${events.length} rounds`);
            resolve();
        });

        rl.on('error', reject);
    });
}
