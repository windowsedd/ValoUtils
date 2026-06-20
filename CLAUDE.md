# ValoUtils — Claude Code Guide

## Project Overview

ValoUtils is a Windows desktop app (Electron + React + Vite + TypeScript) that lets Valorant players save, load, and share full settings profiles. It reads auth tokens directly from the local Riot Client lockfile and calls Riot's private `Ares.PlayerSettings` API. No login or cloud account required.

## Tech Stack

- **Electron 42** — main process, IPC, native APIs
- **React 19 + Vite 8** — renderer (SPA)
- **TypeScript 6**
- **Tailwind CSS v4 + HeroUI v3** — UI components
- **SWR** — data fetching in the renderer
- **electron-updater** — auto-update via GitHub Releases
- **Aptabase** — anonymous analytics (`@aptabase/electron`)
- **electron-builder** — packaging (NSIS installer + portable `.exe`)

## Project Structure

```
electron/          Main process (Node.js context)
  main.ts          App entry, IPC handlers, auto-updater
  preload.ts       Context bridge — exposes window.Main to renderer
  modules/
    profiles/      Profile CRUD + IPC handlers (settings:profile:*)
  util/
    riot-client.ts Reads lockfile, calls Riot Client HTTP API
    riot/
      settings.ts  getPreferences() / loadSettings() — Riot settings API
      entitlements.ts
    settings-decoder.ts  Decodes base64 + raw-deflate settings blob
    share.ts       saveData() / getData() — share code backend
    store.ts       Simple JSON file store (electron-store style)

src/               Renderer (browser context)
  main.tsx         React entry
  pages/
    App.tsx        Root layout, router
    SettingsProfiles.tsx  Main profiles page
    About.tsx
  components/
    parsed-settings-viewer.tsx  Tabbed settings inspector
    settings-diff-viewer.tsx    Side-by-side profile diff
    crosshair-svg-generator.tsx Live crosshair SVG preview
    dynamic-modal.tsx           Global modal provider
    button.tsx                  CustomButton (wraps HeroUI, adds onClickLoading)
    alert-container.tsx         Toast alerts
    router.tsx
  util/
    riot-client.ts  Renderer-side helpers (calls via window.Main IPC)
    settings-parser.ts
    crosshair-mapper.ts
    persistent-state.ts
    axios.ts        httpsAgent (accepts Riot's self-signed cert)
  types/           Shared TypeScript types
```

## IPC Architecture

All Electron ↔ renderer communication goes through `window.Main` (defined in `electron/preload.ts`). The pattern is:

```ts
// renderer sends
window.Main.send("settings:profile:load", profileName);
// renderer listens for reply
window.Main.on("settings:profile:load", (message: string) => {
  const data = JSON.parse(message);
  // handle data.error or data.success
  window.Main.removeAllListeners("settings:profile:load");
});
```

Always call `removeAllListeners` after handling a response to avoid listener leaks.

### IPC Channels

| Channel | Direction | Description |
|---|---|---|
| `settings:profile:list` | send/receive | Fetch all saved profiles |
| `settings:profile:add` | send/receive | Add profile (`"current"` from account, `"clipboard"` from share code) |
| `settings:profile:remove` | send/receive | Delete profile by name |
| `settings:profile:rename` | send/receive | Rename profile |
| `settings:profile:duplicate` | send/receive | Duplicate profile |
| `settings:profile:load` | send/receive | Apply profile to Valorant account |
| `settings:profile:view` | send/receive | Decode and return parsed settings + crosshairs |
| `settings:profile:share` | send/receive | Upload profile data, get 10-char share code |
| `tokens:get` | send/receive | Get cached Riot auth tokens |
| `tokens:refresh` | send/receive | Force-refresh tokens |
| `clipboard:get/set` | send/receive | Clipboard access |
| `analytics:track` | send | Fire an Aptabase event |
| `update:check` | send | Trigger update check |
| `open_url` | send | Open URL in system browser |
| `alert:info` | receive | Show toast in renderer |

## Data Flow

1. **Lockfile** — `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile` gives port + password
2. **Riot Client HTTP API** — authenticated with `Basic riot:<password>` over localhost HTTPS (self-signed cert)
3. **Settings blob** — base64-encoded, raw-deflate-compressed JSON fetched from `Ares.PlayerSettings`
4. **Decode** — `settings-decoder.ts` inflates + parses the blob into structured settings
5. **Profiles stored** — as-is (encoded blob) in a local JSON file via `Store` (app data dir)

## Development Commands

Use **Bun** for package management and script execution in this repo. Prefer
`bun install` and `bun run ...`; avoid npm-only commands unless the user explicitly
asks for them.

```bash
bun run dev          # Vite dev server + Electron with hot-reload
bun run build        # tsc + vite build + electron-builder (local, no publish)
bun run release      # build + publish to GitHub Releases (needs GH_TOKEN)
bun run lint         # ESLint, zero warnings allowed
bun run debug:replay -- <path-to-replay.vrf>  # inspect replay parser output
```

## Build / Release

- CI: GitHub Actions builds on every push
- Tagged commits (`v*`) trigger a release build
- `electron-builder` produces NSIS installer + portable `.exe` (x64 only)
- Auto-updater (`electron-updater`) checks on launch and every hour

## Valorant / Riot API Reference

Community docs: **https://valdocs.prometheuz.me/** (unofficial, not Riot-supported)

### Base URLs

| Server | Base URL | Used for |
|---|---|---|
| Local (Riot Client) | `https://127.0.0.1:<lockfile-port>` | Auth tokens, user info, friends, presence, chat |
| Player Data | `https://pd.<region>.a.pvp.net` | MMR, match history, store, loadouts, XP |
| Game (GLZ) | `https://glz-<region>-1.a.pvp.net` | Party, matchmaking, pre-game, current game |

### Auth

Local endpoints use `Basic riot:<lockfile-password>` (base64). Remote endpoints use:
- `Authorization: Bearer <accessToken>` (from `/entitlements/v1/token`)
- `X-Riot-Entitlements-JWT: <token>` (from same response)

Both tokens come from `getTokens()` / the `tokens:get` IPC channel.

### Key Endpoint Groups

**Local (Riot Client API — `127.0.0.1:<port>`)**
| Endpoint | Method | Description |
|---|---|---|
| `/entitlements/v1/token` | GET | Access token + entitlement token + subject (PUUID) |
| `/riot-client-auth/v1/userinfo` | GET | Game name, tag line, country |
| `/chat/v4/friends` | GET | Friends list |
| `/chat/v2/presences` | GET | Online presence of friends |
| `/chat/v6/messages` | GET/POST | Chat history / send message |
| `/riotclient/region-locale` | GET | Client region + locale |
| `/rso-auth/v1/authorization/userinfo` | GET | RSO user info |

**Player Data (`pd.<region>.a.pvp.net`)**
| Endpoint | Method | Description |
|---|---|---|
| `/playerdata/v1/config` | GET | Game config |
| `/mmr/v1/players/<puuid>` | GET | MMR / rank |
| `/mmr/v1/players/<puuid>/competitiveupdates` | GET | Recent rank changes |
| `/mmr/v1/leaderboards/affinity/<region>/queue/competitive/season/<id>` | GET | Leaderboard |
| `/match-history/v1/history/<puuid>` | GET | Match history |
| `/match-details/v1/matches/<matchId>` | GET | Full match details |
| `/store/v2/storefront/<puuid>` | GET | Daily/weekly store |
| `/store/v1/wallet/<puuid>` | GET | VP / Radianite balance |
| `/store/v1/entitlements/<puuid>/<itemTypeId>` | GET | Owned items |
| `/personalization/v2/players/<puuid>/playerloadout` | GET/PUT | Cosmetic loadout |
| `/restrictions/v3/penalties` | GET | Account penalties |
| `/contracts/v1/contracts/<puuid>` | GET | Battle pass / contracts |
| `/nameservice/v2/players` | PUT | Resolve PUUIDs → names |

**Game (`glz-<region>-1.a.pvp.net`)**
| Endpoint | Method | Description |
|---|---|---|
| `/session/v1/sessions/<puuid>` | GET | Client session state |
| `/parties/v1/players/<puuid>` | GET | Player's current party |
| `/parties/v1/parties/<partyId>` | GET | Party details |
| `/parties/v1/parties/<partyId>/matchmaking/join` | POST | Enter queue |
| `/parties/v1/parties/<partyId>/matchmaking/leave` | POST | Leave queue |
| `/pregame/v1/players/<puuid>` | GET | Pre-game match ID |
| `/pregame/v1/matches/<matchId>` | GET | Pre-game state |
| `/pregame/v1/matches/<matchId>/select/<agentId>` | POST | Hover agent |
| `/pregame/v1/matches/<matchId>/lock/<agentId>` | POST | Lock agent |
| `/core-game/v1/players/<puuid>` | GET | In-game match ID |
| `/core-game/v1/matches/<matchId>` | GET | Live match state |

### Settings API (currently used)

`Ares.PlayerSettings` is fetched/pushed via the Riot Client auth session. The blob is base64 + raw-deflate compressed JSON. See `electron/util/riot/settings.ts` for the exact request.

## Key Constraints

- **Windows only** — relies on `%LOCALAPPDATA%` and Riot Client lockfile
- **Riot Client must be running** to save/load profiles (lockfile must exist)
- **Valorant must be closed** when loading a profile (Riot Client applies settings on next launch)
- No cloud sync — profiles are local JSON in the app data folder
- Riot's API is private/unofficial — no guarantees of stability
