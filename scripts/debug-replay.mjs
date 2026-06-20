import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseReplayForApp } from '@valoutils/ts-replay-parser';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const file = args.find((arg) => !arg.startsWith('--'));
const outArg = args.find((arg) => arg.startsWith('--out='));

function usage() {
    console.log('Usage: bun run debug:replay -- <path-to-replay.vrf> [--details] [--game-specific] [--loadouts] [--types] [--json] [--out=debug.json] [--quiet]');
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatMs(ms) {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

function topTypes(records, count = 20) {
    const typeCounts = new Map();
    for (const record of records) {
        typeCounts.set(record.type, (typeCounts.get(record.type) ?? 0) + 1);
    }
    return [...typeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([type, total]) => ({ type, total }));
}

function parseGameSpecificData(entries) {
    return entries.flatMap((entry) => {
        try {
            const parsed = JSON.parse(entry);
            return typeof parsed === 'object' && parsed !== null ? [parsed] : [];
        } catch {
            return [];
        }
    });
}

function extractLoadouts(entries) {
    return parseGameSpecificData(entries)
        .flatMap((entry) => Array.isArray(entry.playerLoadouts) ? entry.playerLoadouts : [])
        .map((loadout) => ({
            subject: loadout.subject,
            characterId: loadout.characterId,
        }))
        .filter((loadout) => typeof loadout.subject === 'string' || typeof loadout.characterId === 'string');
}

function buildDebug(filePath, options) {
    const startedAt = Date.now();
    const bytes = readFileSync(filePath);
    const afterReadAt = Date.now();
    const result = parseReplayForApp(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const parsedAt = Date.now();
    const mapUrl = result.replay.Header.LevelNamesAndTimes.find(([level]) => level.startsWith('/Game/Maps/'))?.[0] ?? '';
    const playerLoadouts = extractLoadouts(result.replay.Header.GameSpecificData);
    const movementRecords = result.exportRecords.filter((record) => record.type.includes('RemoteCharacterUpdates')).length;
    const movementGuids = new Set(result.movement.map((sample) => sample.guid));

    return {
        file: path.resolve(filePath),
        sizeBytes: bytes.byteLength,
        timings: {
            readMs: afterReadAt - startedAt,
            parseMs: parsedAt - afterReadAt,
            totalMs: parsedAt - startedAt,
        },
        parseMs: parsedAt - startedAt,
        replay: {
            friendlyName: result.replay.Info.FriendlyName,
            lengthInMs: result.replay.Info.LengthInMs,
            compressed: result.replay.Info.IsCompressed,
            encrypted: result.replay.Info.IsEncrypted,
        },
        header: {
            branch: result.replay.Header.Branch,
            networkVersion: result.replay.Header.NetworkVersion,
            engineNetworkVersion: result.replay.Header.EngineNetworkVersion,
            gameNetworkProtocolVersion: result.replay.Header.GameNetworkProtocolVersion,
            platform: result.replay.Header.Platform,
            levelNamesAndTimes: result.replay.Header.LevelNamesAndTimes,
            mapUrl,
            mapName: mapUrl.split('/').filter(Boolean).pop() ?? '',
            gameSpecificDataCount: result.replay.Header.GameSpecificData.length,
            playerLoadoutCount: playerLoadouts.length,
            ...(options.includeGameSpecific ? { gameSpecificData: result.replay.Header.GameSpecificData } : {}),
            ...(options.includeLoadouts ? { playerLoadouts } : {}),
        },
        counts: {
            exportRecords: result.exportRecords.length,
            channelOpens: result.channelOpens.length,
            movementSamples: result.movement.length,
            movementRecords,
            uniqueMovementGuids: movementGuids.size,
        },
        firstTypes: result.exportRecords.slice(0, 20).map((record) => record.type),
        ...(options.includeTypes ? { topTypes: topTypes(result.exportRecords, options.includeDetails ? 30 : 20) } : {}),
        ...(options.includeDetails ? {
            details: {
                replayLength: formatMs(result.replay.Info.LengthInMs),
                fileSize: formatBytes(bytes.byteLength),
                movementSamplesPerSecond: result.replay.Info.LengthInMs > 0
                    ? +(result.movement.length / (result.replay.Info.LengthInMs / 1000)).toFixed(2)
                    : 0,
                firstMovementSample: result.movement[0] ?? null,
                lastMovementSample: result.movement.at(-1) ?? null,
                gameSpecificDataSizes: result.replay.Header.GameSpecificData.map((entry) => entry.length),
                exportTypeCount: new Set(result.exportRecords.map((record) => record.type)).size,
            },
        } : {}),
    };
}

function renderProgress(startedAt, filePath, fileSize, phase) {
    const elapsed = Date.now() - startedAt;
    const percent = Math.min(95, Math.floor((1 - Math.exp(-elapsed / 25000)) * 100));
    const width = 24;
    const filled = Math.floor((percent / 100) * width);
    const bar = `${'='.repeat(filled)}${filled < width ? '>' : ''}${'.'.repeat(Math.max(0, width - filled - 1))}`;
    const line = `[${bar}] ${String(percent).padStart(2, ' ')}% ${phase} | ${formatMs(elapsed)} | ${formatBytes(fileSize)} | ${path.basename(filePath)}`;

    if (process.stderr.isTTY) {
        process.stderr.write(`\r${line.slice(0, process.stderr.columns ?? line.length).padEnd(process.stderr.columns ?? 0)}`);
    } else {
        process.stderr.write(`${line}\n`);
    }
}

async function runMain() {
    if (flags.has('--help') || flags.has('-h')) {
        usage();
        process.exit(0);
    }

    if (!file) {
        usage();
        process.exit(1);
    }

    const options = {
        includeDetails: flags.has('--details'),
        includeGameSpecific: flags.has('--game-specific'),
        includeLoadouts: flags.has('--loadouts') || flags.has('--details'),
        includeTypes: flags.has('--types') || flags.has('--details'),
    };

    const startedAt = Date.now();
    const filePath = path.resolve(file);
    const fileSize = statSync(filePath).size;
    const quiet = flags.has('--quiet');
    const worker = new Worker(new URL(import.meta.url), {
        workerData: { filePath, options },
    });

    let phase = 'parsing replay';
    if (!quiet) renderProgress(startedAt, filePath, fileSize, phase);
    const timer = quiet ? null : setInterval(
        () => renderProgress(startedAt, filePath, fileSize, phase),
        process.stderr.isTTY ? 250 : 5000,
    );

    const debug = await new Promise((resolve, reject) => {
        worker.once('message', (message) => {
            if (message.ok) resolve(message.debug);
            else reject(new Error(message.error));
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`Replay debug worker exited with code ${code}`));
        });
    });

    phase = 'writing output';
    if (timer) clearInterval(timer);
    if (!quiet && process.stderr.isTTY) process.stderr.write('\n');

    if (outArg) {
        const outPath = outArg.slice('--out='.length);
        writeFileSync(outPath, JSON.stringify(debug, null, 2), 'utf8');
        console.log(`Wrote ${outPath}`);
    } else if (flags.has('--json')) {
        console.log(JSON.stringify(debug, null, 2));
    } else {
        console.log(JSON.stringify({
            file: debug.file,
            parseMs: debug.parseMs,
            timings: debug.timings,
            replay: debug.replay,
            header: debug.header,
            counts: debug.counts,
            firstTypes: debug.firstTypes,
            ...(debug.topTypes ? { topTypes: debug.topTypes } : {}),
            ...(debug.details ? { details: debug.details } : {}),
        }, null, 2));
    }
}

if (isMainThread) {
    runMain().catch((error) => {
        if (process.stderr.isTTY) process.stderr.write('\n');
        console.error(error.message);
        process.exit(1);
    });
} else {
    try {
        parentPort.postMessage({
            ok: true,
            debug: buildDebug(workerData.filePath, workerData.options),
        });
    } catch (error) {
        parentPort.postMessage({
            ok: false,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
    }
}
