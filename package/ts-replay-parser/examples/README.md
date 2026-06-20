# Examples

Runnable usage examples for `@valoutils/ts-replay-parser`.

Each example reads a `.vrf` file you pass on the command line. Two sample replays
ship with the package under `../src/valorant/__fixtures__/`.

## Running

From the package root, after `npm install`:

```bash
# with tsx (no build step)
npx tsx examples/basic.ts ./src/valorant/__fixtures__/9f8b32c5-c243-41ec-bbbb-832582edf652.vrf

# or build first, then run with node
npm run build
node --experimental-strip-types examples/basic.ts <path-to.vrf>
```

| Example | Shows |
|---|---|
| [basic.ts](./basic.ts) | Parse a replay, print info + export-type counts |
| [movement.ts](./movement.ts) | Full-mode parse → extract player position samples |
| [low-level.ts](./low-level.ts) | Use the transform and Oodle decompressor directly |

> Examples import from `../src/index.js` so they run against the source. In your own
> project you'd `import { ValorantReplayReader } from "@valoutils/ts-replay-parser"`.
