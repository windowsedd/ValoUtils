import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyTransform } from "./index.js";

interface Vector {
  branch: string;
  seed: number;
  bits: number;
  input: string; // uppercase hex
  output: string; // uppercase hex
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0").toUpperCase();
  return s;
}

const vectorsPath = fileURLToPath(
  new URL("./__vectors__.json", import.meta.url),
);
const vectors: Vector[] = JSON.parse(
  readFileSync(vectorsPath, "utf8").replace(/^﻿/, ""),
);

describe("ValorantSeededPayloadTransform parity with C# reference", () => {
  it("has reference vectors loaded", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const v of vectors) {
    it(`${v.branch} seed=${v.seed >>> 0} bits=${v.bits}`, () => {
      const input = hexToBytes(v.input);
      const result = applyTransform(input, v.bits, v.seed >>> 0, v.branch);
      expect(bytesToHex(result)).toBe(v.output);
    });
  }
});
