# AI Agent Guide — ValoUtils

Guidelines for AI agents (Claude Code or similar) working in this codebase.

## What This App Does

ValoUtils is a Windows Electron app. It reads the Riot Client lockfile to get auth credentials, then uses Riot's private HTTP API to fetch/push Valorant settings. Settings are stored locally as base64+deflate-compressed blobs. Users can save, load, rename, duplicate, share, and compare profiles.

## Where to Find Things

- **IPC channel definitions** — `electron/modules/profiles/index.ts` (profile operations), `electron/main.ts` (everything else)
- **Riot Client auth + API calls** — `electron/util/riot-client.ts`
- **Settings fetch/push** — `electron/util/riot/settings.ts`
- **Settings blob decode** — `electron/util/settings-decoder.ts`
- **Share code encode/decode** — `electron/util/share.ts`
- **Profile storage** — `electron/util/store.ts` (JSON file in app data)
- **Main profiles UI** — `src/pages/SettingsProfiles.tsx`
- **Settings inspector UI** — `src/components/parsed-settings-viewer.tsx`
- **Diff viewer** — `src/components/settings-diff-viewer.tsx`
- **Crosshair preview** — `src/components/crosshair-svg-generator.tsx`
- **IPC bridge** — `electron/preload.ts` → `window.Main` in renderer

## IPC Pattern

Every main-process handler sends a JSON reply on the same channel name:

```ts
// Main process
ipcMain.on("settings:profile:list", (event) => {
  event.sender.send("settings:profile:list", JSON.stringify({ profiles, success: true }));
});

// Renderer — always remove listeners after handling
window.Main.on("settings:profile:list", (msg) => {
  const { profiles } = JSON.parse(msg);
  window.Main.removeAllListeners("settings:profile:list");
});
```

Forgetting `removeAllListeners` causes duplicate callbacks. All error payloads include `{ error: string }`.

## Common Tasks

### Add a new IPC channel
1. Add handler in `electron/modules/profiles/index.ts` (for profile ops) or `electron/main.ts`
2. Call from renderer via `window.Main.send(...)` + `window.Main.on(...)`
3. Always return `{ success: true, ... }` or `{ error: string }`

### Add a new profile action button
- Follow the pattern in `src/pages/SettingsProfiles.tsx`
- Use `CustomButton` with `onClickLoading` returning a `Promise<void>` — reject with a string to show an error toast

### Add a new settings tab in the viewer
- Edit `src/components/parsed-settings-viewer.tsx`
- Settings are available as decoded JSON from `decodeProfileData()` in `electron/util/settings-decoder.ts`

### Decode settings
- `decodeProfileData(base64String)` → parsed settings object
- `extractCrosshairProfiles(settings)` → array of crosshair profiles

## Gotchas

- The Riot Client lockfile may not exist if Riot Client is not running. `getRiotClientInfo()` throws in that case — handle it.
- Riot's localhost HTTPS uses a self-signed cert. The custom `httpsAgent` in `src/util/axios.ts` rejects certificate verification — this is intentional.
- Profile names are used as unique keys. Duplicate name detection is done in `settings:profile:rename`.
- Share codes are 10 characters and expire after 90 days.
- Settings blobs must be at least ~2500 characters of valid base64 to be accepted as a profile (validation in `SettingsProfiles.tsx`).
- Analytics events (`analytics:track`) fire on every user action — keep them when adding new features.
- `window.Main` is only available in the renderer context (after preload). Never call it from the main process.

## Testing

This repo uses **Bun** as the package/script runner. Prefer `bun install` and
`bun run ...` commands; do not introduce npm-only workflows unless the user asks.

There is no full app test suite. To test:
1. `bun run dev` — starts Electron with hot-reload
2. Riot Client must be running for profile save/load; it can be closed to test UI-only flows
3. `config.openDevTools: true` in the app data `config.json` opens DevTools on launch

Replay parser/debug helpers:
- `bun run debug:replay -- <path-to-replay.vrf>` — print replay header, map, movement, and export stats
- `bun --cwd package/ts-replay-parser test` — run parser parity/unit tests
- `bun --cwd package/ts-replay-parser run build` — rebuild parser `dist/`

## Valorant API Reference

Unofficial community docs: <https://valdocs.prometheuz.me/>

### Base URLs

| Server | Base URL | Purpose |
| --- | --- | --- |
| Local (Riot Client) | `https://127.0.0.1:<lockfile-port>` | Auth, user info, friends, presence, chat |
| Player Data | `https://pd.<region>.a.pvp.net` | MMR, match history, store, loadouts, XP |
| Game (GLZ) | `https://glz-<region>-1.a.pvp.net` | Party, matchmaking, pre-game, in-game |

### Authentication

- **Local endpoints** — `Authorization: Basic <base64("riot:<lockfile-password>")>`
- **Remote endpoints** — `Authorization: Bearer <accessToken>` + `X-Riot-Entitlements-JWT: <token>`

Both tokens come from `GET /entitlements/v1/token` on the local Riot Client.
In this codebase: use `getTokens()` (`electron/util/riot-client.ts`) or the `tokens:get` IPC channel.

### Local Endpoints (`127.0.0.1:<port>`)

| Path | Method | Returns |
| --- | --- | --- |
| `/entitlements/v1/token` | GET | `accessToken`, entitlement `token`, `subject` (PUUID) |
| `/riot-client-auth/v1/userinfo` | GET | `acct.game_name`, `acct.tag_line`, country |
| `/riotclient/region-locale` | GET | Region + locale |
| `/chat/v4/friends` | GET | Friends list |
| `/chat/v2/presences` | GET | Friend presence/online status |
| `/chat/v6/messages` | GET/POST | Chat history / send message |
| `/rso-auth/v1/authorization/userinfo` | GET | RSO user info |

### Player Data Endpoints (`pd.<region>.a.pvp.net`)

| Path | Method | Returns |
| --- | --- | --- |
| `/playerdata/v1/config` | GET | Game config |
| `/mmr/v1/players/<puuid>` | GET | MMR / rank data |
| `/mmr/v1/players/<puuid>/competitiveupdates` | GET | Recent rank changes |
| `/match-history/v1/history/<puuid>` | GET | Match history list |
| `/match-details/v1/matches/<matchId>` | GET | Full match details |
| `/store/v2/storefront/<puuid>` | GET | Daily/weekly store |
| `/store/v1/wallet/<puuid>` | GET | VP / Radianite balance |
| `/store/v1/entitlements/<puuid>/<itemTypeId>` | GET | Owned items by type |
| `/personalization/v2/players/<puuid>/playerloadout` | GET/PUT | Cosmetic loadout |
| `/contracts/v1/contracts/<puuid>` | GET | Battle pass / contracts |
| `/nameservice/v2/players` | PUT | Resolve PUUIDs to display names |
| `/restrictions/v3/penalties` | GET | Account penalties |

### Game Endpoints (`glz-<region>-1.a.pvp.net`)

| Path | Method | Returns |
| --- | --- | --- |
| `/session/v1/sessions/<puuid>` | GET | Client session state |
| `/parties/v1/players/<puuid>` | GET | Player's current party ID |
| `/parties/v1/parties/<partyId>` | GET | Full party details |
| `/parties/v1/parties/<partyId>/matchmaking/join` | POST | Enter queue |
| `/parties/v1/parties/<partyId>/matchmaking/leave` | POST | Leave queue |
| `/pregame/v1/players/<puuid>` | GET | Pre-game match ID |
| `/pregame/v1/matches/<matchId>` | GET | Pre-game state (agent select) |
| `/pregame/v1/matches/<matchId>/select/<agentId>` | POST | Hover an agent |
| `/pregame/v1/matches/<matchId>/lock/<agentId>` | POST | Lock an agent |
| `/core-game/v1/players/<puuid>` | GET | Current in-game match ID |
| `/core-game/v1/matches/<matchId>` | GET | Live match state |

## Stack Versions

Electron 42, React 19, Vite 8, TypeScript 6, Tailwind CSS v4, HeroUI v3
