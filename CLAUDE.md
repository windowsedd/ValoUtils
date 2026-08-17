# ValoUtils — Claude Code Guide

## Project Overview

ValoUtils is a Windows desktop app (Tauri 2 + React + Vite + TypeScript, Rust backend) that lets Valorant players save, load, and share full settings profiles. It reads auth tokens directly from the local Riot Client lockfile and calls Riot's private `Ares.PlayerSettings` API. No login or cloud account required.

> Migrated from Electron to Tauri (2026-07). The Rust backend in `src-tauri/` replaces the old Electron main process.

## Tech Stack

- **Tauri 2** — Rust backend, native APIs, IPC via commands/events
- **React 19 + Vite 8** — frontend (SPA in the system WebView2)
- **TypeScript 6** (frontend) / **Rust** (backend)
- **Tailwind CSS v4 + HeroUI v3** — UI components
- **SWR** — data fetching in the frontend
- **tauri-plugin-updater** — auto-update via GitHub Releases (`latest.json`, minisign-signed)
- **Aptabase** — anonymous analytics (hand-rolled HTTP ingest in `src-tauri/src/aptabase.rs`)

## Project Structure

```
src-tauri/         Rust backend (Tauri)
  src/
    lib.rs         App entry: plugins, managed state, command registry, hourly update check
    commands/      One module per feature — all #[tauri::command] handlers
      app.rs       open_url, version, clipboard, config store, analytics, update_check
      riot.rs      client_info, tokens, userinfo, swagger
      profiles.rs  settings:profile:* CRUD + share_get_data
      career.rs    career_get (MMR + competitive history)
      battlepass.rs battlepass_get (contracts XP/level + premium entitlements)
      store.rs     store_get (storefront + wallet, flattened into four shops)
      live.rs      live_game_fetch/dump (with adaptive cache)
      chat.rs      chat_get/send/translate/friend_action/disconnect
    riot/
      client.rs    Lockfile read + local Riot Client HTTPS API (cert bypass)
      api.rs       pd/glz game-API client (RiotApiClient)
      settings.rs  get_preferences / load_settings — Riot settings API
    xmpp/          Hand-rolled XMPP client for Riot chat (TLS to <affinity>.chat.si.riotgames.com:5223)
    settings_decoder.rs  base64 + raw-deflate blob decode (flate2)
    share.rs       pastes.dev share-code backend
    store.rs       JSON file store (same %APPDATA%\ValoUtils\*.json files as before)
    translate.rs   Google web endpoint + DeepL
    updater.rs     Update check/download/install, emits update:* events
  tauri.conf.json  Window, bundle (NSIS), updater pubkey/endpoint
  capabilities/default.json  Permission grants (dialog, clipboard, opener, updater)
  valoutils.key    Updater signing private key (gitignored — NEVER commit)

src/               Frontend (WebView context)
  main.tsx         React entry (imports util/tauri-bridge first)
  pages/           SettingsProfiles, PlayerCareer, LiveGame, Chat, Store, BattlePass, Settings, About
  components/      parsed-settings-viewer, settings-diff-viewer, crosshair-svg-generator,
                   dynamic-modal, button (CustomButton), alert-container, router
  util/
    tauri-bridge.ts  window.Main compatibility shim over invoke()/listen() — see IPC below
    riot-client.ts   Frontend helpers (via window.Main)
    share.ts         getData(code) → share_get_data command
  types/           Shared TypeScript types
```

## IPC Architecture

The frontend still uses the Electron-era `window.Main.send/on/removeAllListeners` API everywhere. It's provided by the shim in [src/util/tauri-bridge.ts](src/util/tauri-bridge.ts), which maps:

- `send("settings:profile:load", name)` → `invoke("settings_profile_load", { args: [name] })` — channel names have `:` and `-` replaced with `_` to form the Rust command name
- The command's returned JSON string is delivered to callbacks registered with `on(channel, cb)`
- `on` also subscribes to a same-named **Tauri event**, so Rust-side pushes (`app.emit("alert:info", ...)`, `update:*`) reach the same callbacks

```ts
// frontend sends
window.Main.send("settings:profile:load", profileName);
// frontend listens for reply
window.Main.on("settings:profile:load", (message: string) => {
  const data = JSON.parse(message);
  // handle data.error or data.success
  window.Main.removeAllListeners("settings:profile:load");
});
```

Rust command conventions (see any file in `src-tauri/src/commands/`):

- Signature: `pub async fn foo(args: Vec<Value>, ...) -> Result<String, ()>` — positional string args, returns a JSON **string**
- Reply shape: `{ success: true, ... }` or `{ error: string, success: false }` — never reject the invoke for expected failures
- Push-style channels use `app.emit(channel, payload)`: `alert:info`, `update:checking/available/not-available/error/download-progress/downloaded`, and `settings:profile:list` (re-emitted after every profile mutation)

### IPC Channels

| Channel | Rust command | Description |
|---|---|---|
| `settings:profile:list` | `settings_profile_list` | Fetch all saved profiles (also pushed after mutations) |
| `settings:profile:add` | `settings_profile_add` | Add profile (`"current"` from account, `"clipboard"`, or raw blob) |
| `settings:profile:remove/rename/duplicate` | `settings_profile_*` | Profile CRUD |
| `settings:profile:load` | `settings_profile_load` | Apply profile to Valorant account |
| `settings:profile:view` / `settings:current:view` | `settings_*_view` | Decode settings + crosshairs |
| `settings:profile:share` | `settings_profile_share` | Upload profile, get share code |
| `tokens:get` / `tokens:refresh` | `tokens_get/refresh` | Riot auth tokens |
| `client_info:get` / `userinfo:get` | `client_info_get` / `userinfo_get` | Lockfile info / account info |
| `career:get` | `career_get` | MMR + competitive history |
| `tools:player:resolve` | `tools_player_resolve` | Resolve `GameName#Tag` or PUUID to a canonical Riot ID |
| `friend:profile:get` | `friend_profile_get` | Player profile used by Friends and Tools (rank + matches) |
| `store:get` | `store_get` | Storefront (daily, bundle, Night Market, accessories) + wallet |
| `battlepass:get` | `battlepass_get` | Act battle pass XP/level + owned premium contract ids |
| `chat:command` | `chat_command` | Runs a `.`-prefixed command typed in the Chat composer; the raw line is never posted |
| `live-game:fetch` / `live-game:dump` | `live_game_fetch/dump` | Live match state (polled ~5s) |
| `chat:get/send/translate/friend-action/disconnect` | `chat_*` | Chat (REST + XMPP) |
| `clipboard:get/set` | `clipboard_get/set` | Clipboard access |
| `analytics:track` | `analytics_track` | Fire an Aptabase event |
| `update:check` | `update_check` | Trigger update check |
| `open_url` | `open_url` | Open URL in system browser |
| `alert:info` | *(event only)* | Push: show toast in frontend |

## Data Flow

1. **Lockfile** — `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile` gives port + password
2. **Riot Client HTTP API** — `Basic riot:<password>` over localhost HTTPS (self-signed cert; reqwest with `danger_accept_invalid_certs(true)` in `riot/client.rs`)
3. **Settings blob** — base64-encoded, raw-deflate-compressed JSON fetched from `Ares.PlayerSettings`
4. **Decode** — `settings_decoder.rs` inflates + parses the blob
5. **Profiles stored** — as-is (encoded blob) in `%APPDATA%\ValoUtils\profiles.json` via `store.rs` (same file the Electron version used — existing user data carries over)

## Development Commands

Use **Bun** for package management and script execution in this repo. Prefer
`bun install` and `bun run ...`; avoid npm-only commands unless the user explicitly
asks for them. Rust toolchain (stable, MSVC) required for the backend.

```bash
bun run dev          # tauri dev: Vite dev server + cargo run with hot-reload
bun run build        # tsc + vite build + tauri build (NSIS installer)

bun test             # frontend + integration tests (bun:test)
cargo check          # (in src-tauri/) fast Rust typecheck
cargo clippy         # (in src-tauri/) Rust lints
cargo test --lib     # (in src-tauri/) Rust unit tests
```

`bun run lint` runs Oxlint against the React and TypeScript frontend in `src/`.

## Build / Release

- CI: GitHub Actions (`.github/workflows/build.yml`) builds on every push; tagged commits (`v*`) trigger `tauri-apps/tauri-action`, which builds, signs, and publishes a **draft** GitHub Release with the NSIS installer + `latest.json` update manifest
- Signing: minisign keypair. Public key is embedded in `tauri.conf.json`; the private key (`src-tauri/valoutils.key`, gitignored) must be set as the `TAURI_SIGNING_PRIVATE_KEY` repo secret for CI signing
- Auto-updater checks on launch and hourly (gated by the `autoUpdate` config flag), endpoint: `releases/latest/download/latest.json`
- No portable `.exe` target (electron-builder-only feature); NSIS installer only

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

Both tokens come from `riot::client::get_tokens()` / the `tokens:get` IPC channel.

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
| `/match-history/v1/history/<puuid>` | GET | Match history (`?startIndex=&endIndex=`) |
| `/match-details/v1/matches/<matchId>` | GET | Full match details |
| `/store/v3/storefront/<puuid>` | POST | Daily/weekly store (empty JSON body; `riot/api.rs` falls back to `GET /store/v2/...`) |
| `/store/v1/wallet/<puuid>` | GET | VP / Radianite / Kingdom Credit balances |
| `/store/v1/entitlements/<puuid>/<itemTypeId>` | GET | Owned items (battle pass premium uses the Contracts type id) |
| `/personalization/v2/players/<puuid>/playerloadout` | GET/PUT | Cosmetic loadout |
| `/restrictions/v3/penalties` | GET | Account penalties |
| `/contracts/v1/contracts/<puuid>` | GET | Battle pass / contract XP |
| `/name-service/v2/players` | PUT | Resolve PUUIDs → names (note the hyphen; `/nameservice/...` 503s) |

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

`Ares.PlayerSettings` is fetched/pushed via the Riot Client auth session. The blob is base64 + raw-deflate compressed JSON. See `src-tauri/src/riot/settings.rs` for the exact request.

### XMPP Chat

Riot chat is XMPP over raw TLS to `<affinity>.chat.si.riotgames.com:5223`, with a custom `X-Riot-RSO-PAS` SASL mechanism (access token + PAS token from `riot-geo.pas.si.riotgames.com/pas/v1/service/chat`). Implemented in `src-tauri/src/xmpp/` — handshake sequence, region table, and MUC join/leave/send mirror the old `@windowsedd/valorant-api` client.

## Common Tasks

### Add a new IPC channel

1. Add a `#[tauri::command]` in the matching `src-tauri/src/commands/*.rs` module (signature: `args: Vec<Value>` in, JSON `String` out)
2. Register it in the `generate_handler![]` list in `src-tauri/src/lib.rs`
3. Call it from the frontend via `window.Main.send("my:channel", ...)` — the bridge converts the name to `my_channel` automatically. Reply with `{ success: true, ... }` or `{ error: string }`
4. For backend-initiated pushes, use `app.emit("my:event", payload)` and `window.Main.on("my:event", ...)` — no command needed

### Add a new profile action button

- Follow the pattern in `src/pages/SettingsProfiles.tsx`
- Use `CustomButton` with `onClickLoading` returning a `Promise<void>` — reject with a string to show an error toast

### Add a new settings tab in the viewer

- Edit `src/components/parsed-settings-viewer.tsx`
- Settings come from `settings:profile:view` / `settings:current:view` (decoded in `src-tauri/src/settings_decoder.rs`); the reply includes `settings` and `crosshairs`

## Gotchas

- The Riot Client lockfile may not exist if Riot Client is not running — `get_riot_client_info()` returns `Err` in that case; commands surface it as `{ error }` JSON.
- Riot's localhost HTTPS uses a self-signed cert. `riot/client.rs` uses a reqwest client with `danger_accept_invalid_certs(true)` — this is intentional and must stay scoped to the local client only.
- Tauri command names can't contain `:` or `-` — the bridge maps channel `settings:profile:list` → command `settings_profile_list`. Keep them in sync.
- Rust commands should return expected failures as `Ok(json with error field)`, not `Err` — the bridge logs `Err` to console and drops it.
- Profile names are unique keys; duplicate-name detection happens in `settings_profile_rename`.
- Share codes are 10 characters and expire after 90 days.
- Settings blobs must be at least ~2500 chars of valid base64 to be accepted as a profile (validation in `SettingsProfiles.tsx`).
- Analytics events (`analytics:track`) fire on every user action — keep them when adding new features.
- Never commit `src-tauri/valoutils.key` (updater signing private key, gitignored).
- The chat XMPP client (`src-tauri/src/xmpp/`) is a from-scratch Rust port — it can only be truly verified against Riot's live chat server with a signed-in account.

## Key Constraints

- **Windows only** — relies on `%LOCALAPPDATA%`, WebView2, and the Riot Client lockfile
- **Riot Client must be running** to save/load profiles (lockfile must exist)
- **Valorant must be closed** when loading a profile (Riot Client applies settings on next launch)
- No cloud sync — profiles are local JSON in `%APPDATA%\ValoUtils`
- Riot's API is private/unofficial — no guarantees of stability
