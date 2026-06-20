import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ValorantReplayReader } from "./replay-reader.js";
import { ParseMode } from "../unreal/enums.js";

interface ReplayRef {
  file: string;
  version: string;
  lengthInMs: number;
  friendlyName: string;
  branch: string;
  engineNetworkVersion: number;
  networkVersion: number;
  totalExports: number;
  typeCounts: Record<string, number>;
}

const refsPath = fileURLToPath(new URL("./__replay_refs__.json", import.meta.url));
const refs: ReplayRef[] = JSON.parse(
  readFileSync(refsPath, "utf8").replace(/^﻿/, ""),
);

function fixture(name: string): Uint8Array {
  const p = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(p));
}

describe("ValorantReplayReader end-to-end parity with C#", () => {
  for (const ref of refs) {
    describe(ref.file, () => {
      const reader = new ValorantReplayReader(ref.version, ParseMode.Normal);
      const replay = reader.readReplay(fixture(ref.file));

      const counts: Record<string, number> = {};
      let total = 0;
      for (const e of replay.exports) {
        counts[e.type] = (counts[e.type] ?? 0) + 1;
        total++;
      }

      it("parses replay info", () => {
        expect(replay.Info.LengthInMs).toBe(ref.lengthInMs);
        expect(replay.Info.FriendlyName).toBe(ref.friendlyName);
        expect(replay.Header.Branch).toBe(ref.branch);
        expect(replay.Header.EngineNetworkVersion).toBe(ref.engineNetworkVersion);
        expect(replay.Header.NetworkVersion).toBe(ref.networkVersion);
      });

      it("produces the same export type counts", () => {
        expect(counts).toEqual(ref.typeCounts);
      });

      it("produces the same total export count", () => {
        expect(total).toBe(ref.totalExports);
      });
    });
  }
});
