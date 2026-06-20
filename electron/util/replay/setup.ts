import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export function getParserExePath(): string {
    const appPath = app.getAppPath();

    if (app.isPackaged) {
        const packagedCandidates = [
            path.join(process.resourcesPath, 'ValorantReplayParser.exe'),
            path.join(process.resourcesPath, 'bin', 'ValorantReplayParser.exe'),
        ];
        return packagedCandidates.find(candidate => fs.existsSync(candidate)) ?? packagedCandidates[0];
    }

    const devCandidates = [
        path.join(appPath, 'resource', 'ValorantReplayParser.exe'),
        path.join(appPath, 'resources', 'ValorantReplayParser.exe'),
        path.join(appPath, 'resources', 'bin', 'ValorantReplayParser.exe'),
    ];
    return devCandidates.find(candidate => fs.existsSync(candidate)) ?? devCandidates[0];
}

export function validateParser(): { ok: boolean; error?: string } {
    const exePath = getParserExePath();
    if (!fs.existsSync(exePath)) {
        return { ok: false, error: `ValorantReplayParser.exe not found.\nExpected: ${exePath}\n\nDownload from github.com/talhakoek/ValorantWebReplayer/releases and place it there.` };
    }
    const bytes = fs.readFileSync(exePath);
    const hardcodedPath = 'C:\\Users\\Barrage\\replay-work\\channels.jsonl';
    if (bytes.includes(Buffer.from(hardcodedPath, 'utf8')) || bytes.includes(Buffer.from(hardcodedPath, 'utf16le'))) {
        return { ok: false, error: `ValorantReplayParser.exe still contains the hardcoded output path ${hardcodedPath}. Run npm run build:parser to rebuild the patched parser.` };
    }
    return { ok: true };
}

export function getOutputDir(vrfPath: string) {
    const name = path.basename(vrfPath, path.extname(vrfPath));
    return path.join(app.getPath('userData'), 'replay-output', name);
}

export function prepareOutputDir(vrfPath: string): {
    outDir: string;
    decodePath: string;
    channelsPath: string;
    positionsPath: string;
    abilitiesPath: string;
} {
    const outDir = getOutputDir(vrfPath);
    fs.mkdirSync(outDir, { recursive: true });
    return {
        outDir,
        decodePath: path.join(outDir, 'decode-full.txt'),
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
        return Array.isArray(positions.samples) && positions.samples.length > 0;
    } catch {
        return false;
    }
}
