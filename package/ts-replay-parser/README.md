# @windowsedd/ts-replay-parser

A **TypeScript port** of [michel-giehl/ValorantReplayParserPlayground](https://github.com/michel-giehl/ValorantReplayParserPlayground), which is itself a fork of [FortniteReplayDecompressor](https://github.com/Shiqan/FortniteReplayDecompressor).

> ⚠️ **Research / proof-of-concept only.** Like the upstream project, this is for research. Riot's replay format is undocumented and unstable; do not rely on this in production.

## Status

**Complete and verified.** All layers are ported and tested against the original C# —
both sample replays parse to byte-identical replay info, export-type counts, and
(in `Full` mode) player-movement positions. See [PORTING.md](./PORTING.md) for the
layer-by-layer status and correctness anchors.

## Usage

```ts
import { readFileSync } from "node:fs";
import { ValorantReplayReader, ParseMode } from "@windowsedd/ts-replay-parser";

const bytes = new Uint8Array(readFileSync("match.vrf"));

// version omitted -> auto-detected from the replay header branch.
const reader = new ValorantReplayReader(null, ParseMode.Normal);
const replay = reader.readReplay(bytes);

console.log(replay.Info.FriendlyName, replay.Info.LengthInMs, "ms");
console.log(replay.Header.Branch);          // "++Ares-Core+release-12.10"
console.log(replay.exports.length, "exports");

// Each export: { channelIndex, type, fields }
for (const e of replay.exports) {
  if (e.type === "BombPlayerState") console.log(e.fields);
}
```

### Player movement

`parseReplayForApp` parses in `Full` mode by default and flattens character movement
into a ready-to-use `movement` array:

```ts
import { parseReplayForApp } from "@windowsedd/ts-replay-parser";

const { replay, movement } = parseReplayForApp(bytes);

console.log(replay.Info.LengthInMs, "ms,", movement.length, "samples");
for (const m of movement.slice(0, 3)) {
  console.log(m.t, m.x, m.y, m.z); // timestamp + position; m.guid = character
}
```

> `ParseMode` ordering: `EventsOnly < Minimal < Normal < Full < Debug` (higher parses more).
> `Full` is required for character movement. Pass `{ version: "12.11" }` to skip
> header auto-detection, or `{ mode }` to parse less.

More runnable examples — basic parse, movement extraction, and the low-level
transform/decompressor — are in [examples/](./examples/).

## Layout

```text
src/
  transform/   ValorantSeededPayloadTransform — payload de-obfuscation (BigInt 64-bit math)
  io/          Bit-stream readers (FArchive / BinaryReader / BitReader)
  ooz/         Oodle/Kraken decompressor (port of OozSharp)
  unreal/      Unreal.Core replication graph + net field exports
  valorant/    Valorant-specific models + ValorantReplayReader
  index.ts     Public entry point
```

## Notes on the port

- **64-bit math** — C# `ulong`/`uint` arithmetic is implemented with `BigInt` masked to width, since JS `number` cannot hold 64-bit values. See `transform/`.
- **Byte order** — Unreal archives are little-endian; the bit readers mirror C# `BitConverter` semantics.

## License

MIT, matching upstream.
