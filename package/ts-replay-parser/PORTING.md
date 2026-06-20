# Porting progress

Bottom-up port of the C# source. Each layer must typecheck and (where applicable) pass unit tests before the next begins.

| Layer | C# source | TS target | Status |
|---|---|---|---|
| Seeded payload transform | `ValorantReplayParser/ValorantSeededPayloadTransform.cs` | `src/transform/` | ✅ ported + tested (205/205 parity vectors) |
| Bit-stream readers | `Unreal.Core/{FArchive,BinaryReader,BitReader,NetBitReader}.cs` | `src/io/` | ✅ ported + tested (12/12 parity vectors) |
| Oodle/Kraken | `OozSharp/*` | `src/ooz/` | ✅ ported + tested (2/2 byte-exact fixtures) |
| Unreal replication core | `Unreal.Core/*` | `src/unreal/` | ✅ ported (NetGuidCache, NetFieldParser, ReplayReader) |
| Valorant models + reader | `ValorantReplayParser/*` | `src/valorant/` | ✅ ported (36 models, registry-driven) |
| Entry point / example | `ValorantReplayParser/Program.cs` | `src/valorant/replay-reader.ts` | ✅ `ValorantReplayReader.readReplay()` |

**End-to-end verified:** both sample `.vrf` replays (release-12.10 + 12.11) parse to byte-identical
replay-info, export-type counts (693 and 1680), and Full-mode movement (8907 / 3001 moves with
matching positions) vs. the C# reference. 236/236 tests pass.

**Integrated into ValoUtils:** the Electron app (`electron/modules/replays/`) now parses replays
in-process via `parseReplayForApp()` — no external `ValorantReplayParser.exe` download required.
The app builds (`vite build`) with the parser bundled into `dist-electron/main.js`.

> Known PoC limitation (inherited from upstream): only the local player's character movement is
> decoded — both this port and the C# original yield a single character GUID per replay.

## Correctness anchors

- The payload transform has both **V12_10** and **V12_11** variants, selected by the replay branch string (`release-12.10` vs `release-12.11`). Default is V12_10.
- 64-bit operations use `BigInt` masked with `& 0xFFFF...` constants defined in `src/transform/uint.ts`.
- **Reflection → registry:** C# discovered models via `[NetFieldExportGroup]` attributes + reflection. The TS port has each model self-register a descriptor (`src/unreal/registry.ts`); importing `src/valorant/models.ts` populates the registry.
- **`ReplayHeaderFlags`** are real bit flags: `HasStreamingFixes = 1<<1`, not `1<<0`.
- **Array fields** only build element objects when the element type is the group type or its base (mirrors C# `ReadArrayField` `isGroupType`); otherwise the array is consumed but assigned null.
