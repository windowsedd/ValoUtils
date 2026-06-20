/**
 * Low-level example: use the building blocks directly, without the full reader.
 *
 *   npx tsx examples/low-level.ts
 *
 * Demonstrates the seeded payload transform and the Oodle/Kraken decompressor —
 * the two pieces that are verified byte-for-byte against the C# original.
 */
import { applyTransform, decompressReplayData } from "../src/index.js";

// --- 1. Seeded payload transform -------------------------------------------
// The transform is its own inverse-shaped de-obfuscation keyed by (bitCount, seed).
// Here we just show it runs deterministically for a given branch.
const payload = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
const bitCount = payload.length * 8;
const seed = bitCount ^ 0xdead;

const out1210 = applyTransform(payload, bitCount, seed >>> 0, "release-12.10");
const out1211 = applyTransform(payload, bitCount, seed >>> 0, "release-12.11");

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

console.log("=== ValorantSeededPayloadTransform ===");
console.log("input        :", hex(payload));
console.log("v12.10 output:", hex(out1210));
console.log("v12.11 output:", hex(out1211));

// --- 2. Oodle / Kraken decompression ---------------------------------------
// decompressReplayData(buffer, uncompressedSize) inflates a Mermaid/Kraken block.
// (A real block comes from a replay's ReplayData chunk; shown here as API usage.)
console.log("\n=== Oodle decompression ===");
console.log("decompressReplayData(buffer, size) -> Uint8Array of length `size`");
console.log("see src/ooz/ for the Mermaid decoder (ported from OozSharp).");

void decompressReplayData; // referenced for the doc above
