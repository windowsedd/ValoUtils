/**
 * Basic example: parse a .vrf replay and print its info + export-type counts.
 *
 *   npx tsx examples/basic.ts <path-to.vrf>
 */
import { readFileSync } from "node:fs";
import { ValorantReplayReader, ParseMode } from "../src/index.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: basic.ts <path-to.vrf>");
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(file));

// version omitted -> auto-detected from the replay header branch.
const reader = new ValorantReplayReader(null, ParseMode.Normal);
const replay = reader.readReplay(bytes);

console.log("=== Replay Info ===");
console.log("friendlyName :", replay.Info.FriendlyName);
console.log("lengthInMs   :", replay.Info.LengthInMs);
console.log("branch       :", replay.Header.Branch);
console.log("compressed   :", replay.Info.IsCompressed);
console.log("exports      :", replay.exports.length);

const counts = new Map<string, number>();
for (const e of replay.exports) {
  counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
}

console.log("\n=== Export types ===");
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${type}`);
}
