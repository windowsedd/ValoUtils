import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// Replays are now parsed fully in-process by @valoutils/ts-replay-parser, so the
// external ValorantReplayParser.exe (and its validation) is no longer needed.

export function getOutputDir(vrfPath: string) {
    const name = path.basename(vrfPath, path.extname(vrfPath));
    return path.join(app.getPath('userData'), 'replay-output', name);
}

export function prepareOutputDir(vrfPath: string): {
    outDir: string;
    channelsPath: string;
    positionsPath: string;
    abilitiesPath: string;
} {
    const outDir = getOutputDir(vrfPath);
    fs.mkdirSync(outDir, { recursive: true });
    return {
        outDir,
        channelsPath: path.join(outDir, 'channels.jsonl'),
        positionsPath: path.join(outDir, 'positions.json'),
        abilitiesPath: path.join(outDir, 'abilities.json'),
    };
}

export function isAlreadyProcessed(outDir: string): boolean {
    if (!['positions.json', 'events.json', 'meta.json', 'abilities.json']
        .every(f => fs.existsSync(path.join(outDir, f)))) {
        return false;
    }

    try {
        const positions = JSON.parse(fs.readFileSync(path.join(outDir, 'positions.json'), 'utf8')) as {
            samples?: unknown[];
        };
        const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8')) as {
            mapUrl?: unknown;
        };
        return Array.isArray(positions.samples)
            && positions.samples.length > 0
            && typeof meta.mapUrl === 'string'
            && meta.mapUrl.length > 0;
    } catch {
        return false;
    }
}
