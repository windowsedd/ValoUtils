import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ValorantReplayReader, type ExportRecord } from "./replay-reader.js";
import { ParseMode } from "../unreal/enums.js";
import type { ComponentDataStream, MovementMove } from "./models.js";

interface MovementRef {
  file: string;
  version: string;
  totalMoves: number;
  movesWithPosition: number;
  hasSection: number;
  validMagic: number;
  firstPositions: { x: number; y: number; ts: number }[];
}

const refsPath = fileURLToPath(new URL("./__movement_refs__.json", import.meta.url));
const refs: MovementRef[] = JSON.parse(
  readFileSync(refsPath, "utf8").replace(/^﻿/, ""),
);

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))),
  );
}

/** Collect every ComponentDataStream movement object from a Full-mode parse. */
class MovementCollector extends ValorantReplayReader {
  streams: ComponentDataStream[] = [];

  protected override onExportRead(channelIndex: number, exportGroup: object | null): void {
    super.onExportRead(channelIndex, exportGroup);
    if (exportGroup == null) return;
    this.walk(exportGroup, 0);
  }

  private walk(obj: unknown, depth: number): void {
    if (obj == null || depth > 4) return;
    if (this.isStream(obj)) {
      this.streams.push(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) this.walk(item, depth + 1);
      return;
    }
    if (typeof obj === "object") {
      for (const v of Object.values(obj)) {
        if (v != null && (Array.isArray(v) || typeof v === "object")) {
          this.walk(v, depth + 1);
        }
      }
    }
  }

  private isStream(o: unknown): o is ComponentDataStream {
    return (
      typeof o === "object" &&
      o !== null &&
      "HasMovementSection" in o &&
      "Moves" in o
    );
  }
}

describe("ComponentDataStream movement parity with C# (Full mode)", () => {
  for (const ref of refs) {
    describe(`${ref.file} (${ref.version})`, () => {
      const reader = new MovementCollector(ref.version, ParseMode.Full);
      reader.readReplay(fixture(ref.file));

      const moves: MovementMove[] = [];
      let withPos = 0;
      let hasSection = 0;
      let validMagic = 0;
      for (const s of reader.streams) {
        if (s.HasMovementSection) hasSection++;
        if (s.HasValidMovementMagic) validMagic++;
        for (const m of s.Moves) {
          moves.push(m);
          if (m.Position) withPos++;
        }
      }

      it("decodes the same number of movement sections", () => {
        expect(hasSection).toBe(ref.hasSection);
        expect(validMagic).toBe(ref.validMagic);
      });

      it("decodes the same total move count", () => {
        expect(moves.length).toBe(ref.totalMoves);
        expect(withPos).toBe(ref.movesWithPosition);
      });

      it("decodes matching positions for the first moves", () => {
        const firstWithPos = moves.filter((m) => m.Position).slice(0, ref.firstPositions.length);
        const got = firstWithPos.map((m) => ({
          x: Math.round(m.Position!.X * 10) / 10,
          y: Math.round(m.Position!.Y * 10) / 10,
          ts: m.Timestamp,
        }));
        expect(got).toEqual(ref.firstPositions);
      });
    });
  }
});
