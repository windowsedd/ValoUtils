import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { decompressReplayData } from "./index.js";

interface Ref {
  file: string;
  size: number;
  length: number;
  sha256: string;
}

const refsPath = fileURLToPath(new URL("./__decompress_refs__.json", import.meta.url));
const refs: Ref[] = JSON.parse(readFileSync(refsPath, "utf8").replace(/^﻿/, ""));

function fixture(name: string): Uint8Array {
  const p = fileURLToPath(new URL(`../../test-fixtures/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(p));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

describe("Kraken/Mermaid decompressor parity with C# OozSharp", () => {
  for (const ref of refs) {
    it(`${ref.file} decompresses byte-for-byte (${ref.size} bytes)`, () => {
      const compressed = fixture(ref.file);
      const out = decompressReplayData(compressed, ref.size);
      expect(out.length).toBe(ref.length);
      expect(sha256(out)).toBe(ref.sha256);
    });
  }
});
