// Standalone sidecar binary (compiled via `bun build --compile`) that runs the
// CPU-heavy, byte-exact replay parsing pipeline out of process from the Tauri
// Rust backend. This logic previously ran in an Electron utilityProcess
// (electron/replay-worker.ts); the parsing/decompression code itself
// (@windowsedd/valo-replay-parser) and the extract/abilities logic are kept
// completely unchanged on purpose — a from-scratch Rust port of Oodle Kraken
// decompression + Unreal replication parsing (~4k lines, byte-exact) carries
// far higher correctness risk than reusing the already-working TS parser.
//
// Usage: replay-parser <vrfPath> <outDir>
// Emits newline-delimited JSON to stdout:
//   {"type":"progress","status":"parsing"|"extracting"|"abilities","message":"..."}
//   {"type":"done"}
//   {"type":"error","error":"..."}
import fs from "node:fs";
import path from "node:path";
import { parseReplayForApp } from "@windowsedd/valo-replay-parser";
import { extractRecords } from "./replay/extract.ts";
import { buildAbilities } from "./replay/abilities.ts";

type OutMessage = { type: "progress"; status: string; message: string } | { type: "done" } | { type: "error"; error: string };

function post(msg: OutMessage) {
    console.log(JSON.stringify(msg));
}

function runParser(vrfPath: string, channelsDestPath: string) {
    const bytes = fs.readFileSync(vrfPath);
    const result = parseReplayForApp(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const mapUrl = result.replay.Header.LevelNamesAndTimes.find(([level]: [string, unknown]) => level.startsWith("/Game/Maps/"))?.[0] ?? "";
    const mapName = mapUrl.split("/").filter(Boolean).pop() ?? "";

    const channelLines = result.channelOpens.map((o: unknown) => JSON.stringify(o)).join("\n");
    fs.writeFileSync(channelsDestPath, channelLines);

    return { records: result.exportRecords, hasChannels: result.channelOpens.length > 0, mapUrl, mapName };
}

async function processReplay(vrfPath: string, outDir: string) {
    fs.mkdirSync(outDir, { recursive: true });
    const channelsPath = path.join(outDir, "channels.jsonl");
    const positionsPath = path.join(outDir, "positions.json");
    const abilitiesPath = path.join(outDir, "abilities.json");

    post({ type: "progress", status: "parsing", message: "Parsing replay..." });
    const { records, hasChannels, mapUrl, mapName } = runParser(vrfPath, channelsPath);

    post({ type: "progress", status: "extracting", message: "Extracting positions..." });
    extractRecords(records, outDir, path.basename(vrfPath), mapName, mapUrl);

    if (hasChannels) {
        post({ type: "progress", status: "abilities", message: "Building abilities..." });
        await buildAbilities(channelsPath, positionsPath, abilitiesPath);
    } else {
        fs.writeFileSync(abilitiesPath, "[]");
    }

    post({ type: "done" });
}

const [, , vrfPath, outDir] = process.argv;
if (!vrfPath || !outDir) {
    post({ type: "error", error: "Usage: replay-parser <vrfPath> <outDir>" });
    process.exit(1);
}

processReplay(vrfPath, outDir).catch((error: unknown) => {
    post({ type: "error", error: (error as Error).message });
    process.exit(1);
});
