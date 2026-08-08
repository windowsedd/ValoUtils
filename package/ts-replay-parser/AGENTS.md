# AGENTS.md

Guidance for AI agents working in `@windowsedd/ts-replay-parser`.

The full guide lives in [CLAUDE.md](./CLAUDE.md) — read it first. Quick summary:

- **What:** TypeScript port of a VALORANT `.vrf` replay parser. Bottom-up layers under
  `src/` (`transform → io/ooz → unreal → valorant`). Imports point downward only.
- **Architecture note:** models self-register descriptors into `src/unreal/registry.ts`
  (replacing C# reflection). Importing `src/valorant/models.ts` populates the registry.
- **Numbers:** 64-bit values are `bigint`; 32-bit unsigned math is masked (`>>> 0`).
- **Correctness:** parity with the original C# is the spec. Tests compare against committed
  reference fixtures (`__*__.json`). Don't change behaviour without re-verifying.
- **Commands:** use Bun: `bun test`, `bun run typecheck`, `bun run build`.
- **Examples:** see [examples/](./examples/).

The repo-wide agent guide is at [../../AGENTS.md](../../AGENTS.md).
