import { ipcMain, IpcMainEvent, dialog } from 'electron';
import { API, local } from '@windowsed1225/valorant-api';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractStream } from '../../util/replay/extract.ts';
import { buildAbilities } from '../../util/replay/abilities.ts';
import { getParserExePath, validateParser, prepareOutputDir, isAlreadyProcessed, getOutputDir } from '../../util/replay/setup.ts';
import { getRegionLocale } from '../../util/riot-client.ts';

const { LocalRiotClientAPI } = local;

const DEMOS_DIR = path.join(
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? 'C:\\Users\\Default', 'AppData', 'Local'),
    'VALORANT', 'Saved', 'Demos'
);

const REGION_TO_SHARD: Record<string, string> = {
    NA: 'na', LATAM: 'latam', BR: 'br',
    EU: 'eu', AP: 'ap', KR: 'kr',
    TW2: 'ap', SG2: 'ap', JP: 'ap',
    VN2: 'ap', PBE: 'na',
};

function sendProgress(event: IpcMainEvent, vrfPath: string, status: string, message: string) {
    event.sender.send('replay:progress', JSON.stringify({ path: vrfPath, status, message }));
}

async function createApi(): Promise<API> {
    const localClient = LocalRiotClientAPI.initFromLockFile();
    const { data } = await localClient.getEntitlementsToken();
    const locale = await getRegionLocale();
    const region = REGION_TO_SHARD[(locale.region ?? '').toUpperCase()]
        ?? (locale.region ?? 'na').toLowerCase();
    const api = new API();
    await api.init({
        accessToken: data.accessToken,
        entitlementsToken: data.token,
        puuid: data.subject,
        region,
    });
    return api;
}

async function readOrFetchMatchDetails(vrfPath: string, outDir: string) {
    const matchDetailsPath = path.join(outDir, 'match-details.json');
    if (fs.existsSync(matchDetailsPath)) {
        try { return JSON.parse(fs.readFileSync(matchDetailsPath, 'utf8')); } catch { /* refetch */ }
    }

    const matchId = path.basename(vrfPath, path.extname(vrfPath));
    if (!/^[0-9a-f-]{36}$/i.test(matchId)) return null;

    try {
        const api = await createApi();
        const details = await api.matches.getDetails(matchId);
        fs.writeFileSync(matchDetailsPath, JSON.stringify(details));
        return details;
    } catch (error) {
        console.warn(`[replay] match details unavailable for ${matchId}:`, (error as Error).message);
        return null;
    }
}

function runParser(vrfPath: string, decodePath: string, channelsDestPath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const parserPath = getParserExePath();
        const parserDir = path.dirname(parserPath);
        const parserChannelsPath = path.join(parserDir, 'channels.jsonl');
        const vrfDir = path.dirname(vrfPath);

        try { fs.unlinkSync(parserChannelsPath); } catch { /* best effort */ }

        const proc = spawn(parserPath, [vrfPath, '--verbose', '--full'], { cwd: parserDir });

        const decodeStream = fs.createWriteStream(decodePath);
        const stderrChunks: Buffer[] = [];

        proc.stdout.pipe(decodeStream);
        proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        proc.on('close', (code) => {
            decodeStream.close(() => {
                const stderrText = Buffer.concat(stderrChunks).toString().trim();
                if (code !== 0 && code !== null) {
                    const detail = stderrText ? `\n\nParser stderr:\n${stderrText}` : '';
                    reject(new Error(`Parser exited with code ${code}${detail}`)); return;
                }
                // Check all candidate locations for channels.jsonl
                const candidates = [
                    path.join(vrfDir, 'channels.jsonl'),
                    parserChannelsPath,
                ];
                const found = candidates.find(p => fs.existsSync(p));
                if (found) {
                    fs.copyFileSync(found, channelsDestPath);
                    try { fs.unlinkSync(found); } catch { /* best effort */ }
                } else {
                    resolve(false);
                    return;
                }
                resolve(true);
            });
        });

        proc.on('error', (err) => reject(new Error(`Failed to start parser: ${err.message}`)));
    });
}

export const initReplaysIpc = () => {
    ipcMain.on('replay:export-json', async (event: IpcMainEvent, jsonStr: string, defaultName: string) => {
        const result = await dialog.showSaveDialog({
            title: 'Export Replay JSON',
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) {
            event.sender.send('replay:export-json', JSON.stringify({ success: false, canceled: true }));
            return;
        }
        try {
            fs.writeFileSync(result.filePath, jsonStr, 'utf-8');
            event.sender.send('replay:export-json', JSON.stringify({ success: true }));
        } catch (error) {
            event.sender.send('replay:export-json', JSON.stringify({ success: false, error: (error as Error).message }));
        }
    });

    ipcMain.on('replay:export-raw', async (event: IpcMainEvent, vrfPath: string) => {
        const outDir = getOutputDir(vrfPath);
        if (!isAlreadyProcessed(outDir)) {
            event.sender.send('replay:export-raw', JSON.stringify({ success: false, error: 'Replay not processed yet — watch it first to generate the cache.' }));
            return;
        }
        try {
            const read = (name: string, fallback: unknown = null) => {
                const p = path.join(outDir, name);
                return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
            };
            const baseName = path.basename(vrfPath, path.extname(vrfPath));
            const data = {
                id: baseName,
                meta: read('meta.json'),
                positions: read('positions.json'),
                events: read('events.json'),
                abilities: read('abilities.json', []),
                matchDetails: read('match-details.json'),
            };
            const result = await dialog.showSaveDialog({
                title: 'Export Replay JSON',
                defaultPath: `${baseName}.json`,
                filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (result.canceled || !result.filePath) {
                event.sender.send('replay:export-raw', JSON.stringify({ success: false, canceled: true }));
                return;
            }
            fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
            event.sender.send('replay:export-raw', JSON.stringify({ success: true }));
        } catch (error) {
            event.sender.send('replay:export-raw', JSON.stringify({ success: false, error: (error as Error).message }));
        }
    });

    ipcMain.on('replay:delete', (event: IpcMainEvent, vrfPath: string) => {
        try {
            if (fs.existsSync(vrfPath)) fs.unlinkSync(vrfPath);
            const outDir = getOutputDir(vrfPath);
            if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
            event.sender.send('replay:delete', JSON.stringify({ success: true, path: vrfPath }));
        } catch (error) {
            event.sender.send('replay:delete', JSON.stringify({ success: false, error: (error as Error).message }));
        }
    });

    ipcMain.on('replay:list', (event: IpcMainEvent) => {
        try {
            if (!fs.existsSync(DEMOS_DIR)) {
                event.sender.send('replay:list', JSON.stringify({ success: true, files: [], demosDir: DEMOS_DIR }));
                return;
            }
            const entries = fs.readdirSync(DEMOS_DIR, { withFileTypes: true });
            const files = entries
                .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.vrf'))
                .map(e => {
                    const fullPath = path.join(DEMOS_DIR, e.name);
                    const stat = fs.statSync(fullPath);
                    const outDir = getOutputDir(fullPath);
                    return { name: e.name, path: fullPath, size: stat.size, modified: stat.mtimeMs, processed: isAlreadyProcessed(outDir) };
                })
                .sort((a, b) => b.modified - a.modified);
            event.sender.send('replay:list', JSON.stringify({ success: true, files, demosDir: DEMOS_DIR }));
        } catch (error) {
            event.sender.send('replay:list', JSON.stringify({ success: false, error: (error as Error).message }));
        }
    });

    ipcMain.on('replay:process', async (event: IpcMainEvent, vrfPath: string) => {
        try {
            const outDir = getOutputDir(vrfPath);

            if (!isAlreadyProcessed(outDir)) {
                const check = validateParser();
                if (!check.ok) {
                    event.sender.send('replay:process', JSON.stringify({ success: false, path: vrfPath, error: check.error }));
                    return;
                }

                const paths = prepareOutputDir(vrfPath);

                sendProgress(event, vrfPath, 'parsing', 'Parsing replay (this may take a minute)...');
                const hasChannels = await runParser(vrfPath, paths.decodePath, paths.channelsPath);

                sendProgress(event, vrfPath, 'extracting', 'Extracting positions...');
                await extractStream(paths.decodePath, paths.outDir);

                if (hasChannels) {
                    sendProgress(event, vrfPath, 'abilities', 'Building abilities...');
                    await buildAbilities(paths.channelsPath, paths.positionsPath, paths.abilitiesPath);
                } else {
                    fs.writeFileSync(paths.abilitiesPath, '[]');
                }

                try { fs.unlinkSync(paths.decodePath); } catch { /* best effort */ }
            }

            const positions = JSON.parse(fs.readFileSync(path.join(outDir, 'positions.json'), 'utf8'));
            const events = JSON.parse(fs.readFileSync(path.join(outDir, 'events.json'), 'utf8'));
            const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
            const abilitiesFile = path.join(outDir, 'abilities.json');
            const abilities = fs.existsSync(abilitiesFile) ? JSON.parse(fs.readFileSync(abilitiesFile, 'utf8')) : [];
            const matchDetails = await readOrFetchMatchDetails(vrfPath, outDir);

            event.sender.send('replay:process', JSON.stringify({ success: true, path: vrfPath, positions, events, meta, abilities, matchDetails }));
        } catch (error) {
            event.sender.send('replay:process', JSON.stringify({ success: false, path: vrfPath, error: (error as Error).message }));
        }
    });
};
