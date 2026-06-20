/**
 * Movement example: parse a replay and read player position samples.
 *
 *   npx tsx examples/movement.ts <path-to.vrf>
 *
 * Note: only the local player's movement is decoded (upstream PoC limitation).
 */
import { readFileSync } from "node:fs";
import { parseReplayForApp } from "../src/index.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: movement.ts <path-to.vrf>");
  process.exit(1);
}

// parseReplayForApp uses ParseMode.Full by default, so `movement` is populated.
const { replay, movement } = parseReplayForApp(new Uint8Array(readFileSync(file)));

console.log("replay length   :", replay.Info.LengthInMs, "ms");
console.log("position samples:", movement.length);
console.log("first 3         :", movement.slice(0, 3));
