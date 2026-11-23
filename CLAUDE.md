# ValoUtils — Claude Code Guide

## Project Overview

ValoUtils is a Windows desktop app (Tauri 2 + React + Vite + TypeScript, Rust backend) that lets Valorant players save, load, and share full settings profiles. It reads auth tokens directly from the local Riot Client lockfile and calls Riot's private `Ares.PlayerSettings` API. No login or cloud account required.

> Migrated from Electron to Tauri (2026-07). The Rust backend in `src-tauri/` replaces the old Electron main process.

## Tech Stack

- **Tauri 2** — Rust backend, native APIs, IPC via commands/events
- **React 19 + Vite 8** — frontend (SPA in the system WebView2)
- **TypeScript 6** (frontend) / **Rust** (backend)
- **Tailwind CSS v4 + shadcn/ui** (Radix primitives via `radix-ui`, `tw-animate-css`) — UI components.
  Components live in `src/components/ui/` (button, dialog, input, label, popover,
  select, switch, tooltip) and
  are styled with the app's own CSS variables (`--control`, `--border`, `--accent`…),
  not shadcn's theme names: `--accent` here is the purple brand colour. `cn()` is in
  `src/lib/utils.ts`; `components.json` lets `bunx shadcn@latest add <name>` add more
  (then restyle them the same way). `CustomButton` (`src/components/button.tsx`) wraps
  the shadcn Button and keeps its `color`/`size`/`isDisabled`/`onPress` props.
  `SelectMenu` wraps shadcn Select; rail/status tooltips use Tooltip; the account
  status menu and bot language list use Popover.
- **SWR** — data fetching in the frontend
- **tauri-plugin-updater** — auto-update via GitHub Releases (`latest.json`, minisign-signed)
- **Aptabase** — anonymous analytics (hand-rolled HTTP ingest in `src-tauri/src/aptabase.rs`)

## Project Structure

```
src-tauri/         Rust backend (Tauri)
  src/
    ai/            Shared AI provider config, HTTP adapters and prompts
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
  main.tsx         React entry
  pages/           SettingsProfiles, PlayerCareer, LiveGame, Chat, Store, BattlePass, Settings, About
  components/      parsed-settings-viewer, settings-diff-viewer, crosshair-svg-generator,
                   dynamic-modal, button (CustomButton), alert-container, router
  util/
    ipc.ts          Event subscription cleanup and transport-error reporting
    riot-client.ts   Typed frontend helpers (via Tauri invoke)
    share.ts         getData(code) → share_get_data command
  types/           Shared TypeScript types
```

## IPC Architecture

The frontend calls Tauri commands directly with `invoke<T>()`. Each request gets
its own Promise reply; replies are never broadcast to other callers.

```ts
import { invoke } from "@tauri-apps/api/core";

const data = await invoke<{ success: boolean; error?: string }>(
  "settings_profile_load",
  { args: [profileName] },
);
// Handle data.error / data.success; no JSON.parse or reply listener needed.
```

Rust command conventions:

- JSON replies return `serde_json::Value` (usually `Result<Value, ()>`) or a
  serializable type, with positional `args: Vec<Value>` retained where needed.
- Expected failures remain `{ success: false, error: string }` or a feature's
  existing error shape. Transport failures reject the Promise; every call must
  handle rejection so pending UI state can finish.
- Local Riot Client errors stay typed as `RiotError` through login classification.
  Commands retain text in `error` and expose `code` (`loginRequired`,
  `malformedLockfile`, `lockfileReadFailed`, `timeout`, or `unavailable`).
  Only client-unavailable/auth failures request login; never classify display
  text or treat malformed lockfiles, timeouts, or generic HTTP 503s as login.
- Plain-text results such as `version` and `share_get_data` remain strings.
- Backend pushes use `app.emit(channel, payload)` with structured payloads.
  `listenEvent<T>(channel, callback)` in `src/util/ipc.ts` unwraps the event and
  returns cleanup immediately, including when registration finishes after
  cleanup. Return/call that cleanup from the owning React effect.
- Push channels include `alert:info`, `update:*`, `settings:profile:list`,
  `presence:status-changed`, `chat:message`, `chat:presence`, `match:details`,
  `live-game:fetch`, `live-game:player-stats`, and `live-game:phase`. Some names
  also describe a command reply, but replies and subscriptions are independent.

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
| `career:get` | `career_get` | MMR + competitive history; also saved per account in `cache.json` |
| `career:cached` | `career_cached` | Last saved career for the signed-in account (no PD request) with `fresh`: under 10 min old and not saved before (or within 2 min after) a match ended. Career shows it without a request when fresh, otherwise shows it while `career_get` loads; Refresh always fetches |
| `tools:player:resolve` | `tools_player_resolve` | Resolve `GameName#Tag` or PUUID to a canonical Riot ID |
| `friend:profile:get` | `friend_profile_get` | Player profile used by Friends and Tools (rank + matches) |
| `store:get` | `store_get` | Storefront (daily, every featured bundle in `featuredBundles` — Riot often runs two — Night Market, accessories) + wallet; also saved per account in `cache.json` |
| `store:cached` | `store_cached` | Last saved storefront for the signed-in account (no PD request), shown while `store_get` loads |
| `battlepass:get` | `battlepass_get` | Act battle pass XP/level, owned premium contract ids, and active agent recruitment progress |
| `bloomline:get` | `bloomline_get` | Read agent progression; optional agent UUID and expected account load equipped stat counters |
| `chat:saved-match-details` | `chat_saved_match_details` | Map, mode, agent and result for a saved match chat; fetched once and stored in `match-chat-history.json` |
| `party:code-create` / `party:code-join` / `party:code-disable` | `party_code_create` / `party_code_join` / `party_code_disable` | Need VALORANT running (`valorantNotRunning` otherwise, checked before any Riot request, for the panel, chat commands and MCP). Create the current party's invite code (`{ success, inviteCode, link }`; the link is Riot's `https://gg.riotgames.com/VAL?joinCode=CODE`), join by code or pasted party link (`args: [code]`), or turn the code and link off (`DELETE /parties/v1/parties/{id}/invitecode`). Shared with `.code create`, `.party join` and MCP `create_party_code` / `join_party` / `disable_party_link`. UI: Chat → Party sidebar |
| `encounters:get` | `encounters_get` | Everyone from your last 10 matches with how often they were with/against you (`args: [excludeMatchId?]`); see Played before & parties |
| `chat:command` | `chat_command` | Runs a `.`- or `/`-prefixed command typed in the Chat composer; the raw line is never posted |
| `live-game:fetch` / `live-game:dump` | `live_game_fetch/dump` | Live match state (polled ~5s) |
| `chat:get/send/translate/friend-action/disconnect` | `chat_*` | Chat (REST + XMPP) |
| `clipboard:get/set` | `clipboard_get/set` | Clipboard access |
| `analytics:track` | `analytics_track` | Fire an Aptabase event |
| `ai:test` | `ai_test` | Test the selected AI provider |
| `ai:models` | `ai_models` | Fetch models for the selected provider and credentials |
| `ai:match-analyze` | `ai_match_analyze` | Analyze anonymized match stats |
| `match_timeline` | `match_timeline` | Round winners, kills, spike events, and player positions for a finished match |
| `update:check` | `update_check` | Trigger update check |
| `display:get` / `display:set` | `display_get/set` | List connected displays and save the display used on the next launch |
| `open_url` | `open_url` | Open URL in system browser |
| `remote:status` / `remote:set-enabled` / `remote:regenerate-token` | `remote_status` / `remote_set_enabled` / `remote_regenerate_token` | Remote chat server state, addresses (Tailscale/LAN) with QR SVGs; see Remote chat |
| `alert:info` | *(event only)* | Push: show toast in frontend |

Chat GUI exposes Friends, Party, Team and All channels. Game relay incoming group messages use the existing `chat:message` stream and buffered transcript in `chat_get`; outgoing bot commands are excluded. GUI group replies use a single native relay connection with server-confirmed membership and wait up to 10 seconds for the matching server echo or rejection. Independent XMPP writes cannot report GUI send success. Routes are removed on leave, kick, disconnect or relay reset; pregame and coregame rooms remain distinct. Room aliases and optimistic echoes are reconciled; relay shutdown clears captured chat session state. After a match ends, `chat_get` keeps that match's Team/All rooms and up to 200 lines (marked `ended`, composer read-only) until the next match, an account change, or `chat_disconnect`.

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

For Rust work in `src-tauri/`, load the project skill `rust-best-practices`
(`.claude/skills/rust-best-practices`, Apollo's Rust handbook): no
`unwrap()`/`expect()` outside tests (poisoned locks use
`unwrap_or_else(PoisonError::into_inner)`), borrow over clone, `?` for errors,
no blocking work (e.g. `tasklist`) on the async runtime (`spawn_blocking`), and
`cargo clippy --all-targets -- -D warnings` must stay clean (CI enforces it).

## Build / Release

- CI: GitHub Actions (`.github/workflows/build.yml`) builds on every push; tagged commits (`v*`) trigger `tauri-apps/tauri-action`, which builds, signs, and publishes a **draft** GitHub Release with the NSIS installer + `latest.json` update manifest
- Signing: minisign keypair. Public key is embedded in `tauri.conf.json`; the private key (`src-tauri/valoutils.key`, gitignored) must be set as the `TAURI_SIGNING_PRIVATE_KEY` repo secret for CI signing
- Auto-updater checks on launch and hourly (gated by the `autoUpdate` config flag), endpoint: `releases/latest/download/latest.json`
- No portable `.exe` target (electron-builder-only feature); NSIS installer only
- Rust checks: `.github/workflows/rust-checks.yml` runs `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --lib --locked` on PRs, on pushes to `master` touching `src-tauri/`, and on demand (a placeholder `dist/` satisfies `generate_context!`). Lint levels live in `[lints]` in `src-tauri/Cargo.toml`; silence a lint only with `#[expect(lint, reason = "...")]`

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
| `/account-xp/v1/players/<puuid>` | GET | Account level + XP (Career; optional, failure hides it) |
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
| `/pregame/v1/matches/<matchId>/quit` | POST | Leave agent select (`.dodge`) |
| `/core-game/v1/players/<puuid>` | GET | In-game match ID |
| `/core-game/v1/matches/<matchId>` | GET | Live match state |

### Settings API (currently used)

`Ares.PlayerSettings` is fetched/pushed via the Riot Client auth session. The blob is base64 + raw-deflate compressed JSON. See `src-tauri/src/riot/settings.rs` for the exact request.

### XMPP Chat

Riot chat is XMPP over raw TLS to `<affinity>.chat.si.riotgames.com:5223`, with a custom `X-Riot-RSO-PAS` SASL mechanism (access token + PAS token from `riot-geo.pas.si.riotgames.com/pas/v1/service/chat`). Implemented in `src-tauri/src/xmpp/` — handshake sequence, region table, and MUC join/leave/send mirror the old `@windowsedd/valorant-api` client.

## Common Tasks

### Bloomline agent progression

Bloomline is a read-only page in the main rail (also hideable in Settings).
`bloomline_get` takes `args: []` for all agents, or `[agentUuid, accountPuuid]`
for one agent's equipped counters. It uses the shared authenticated PD client,
rate gate and auth retry with a 20-second timeout. The parser uses the
`windowsedd-valorant-api` 0.2.0 response types, normalizes compact uppercase
agent IDs, rejects mismatched owners and malformed collections, and omits empty
stat slots. Missing values stay unknown; zero remains zero. The page loads agent
names/portraits through the existing asset cache, fetches only selected-agent
stats, and ignores superseded replies. An uncached local account check after
each PD read rejects account switches; detected switches clear the old roster.
Refresh clears old account data. Riot
does not supply level thresholds or stat names in these responses, so the UI
shows levels/points and numbered stat slots with their IDs; no percentage or
stat meaning is inferred. No mutations, polling, extra login, or local storage.

### Battle pass next rewards

The Battle Pass progress card shows a Next rewards row: the next three tiers
after the player's level (`upcomingRewards` in `battlepass-state.ts`) with art,
name, tier, XP still needed and a Premium tag when the premium track isn't owned.

### Agent recruitment progress

Riot reports the active agent recruitment event at the top of the contracts
document as `ActiveRecruitmentEventProgress` (`AgentID`, `ProgressionEarned`),
not as a contract. `battlepass_get` returns it as `recruitment` and, only while
an event is active, reads `/store/v1/storefronts/agent` for the end date: the
start of that agent's Kingdom Credit offer. A failed store read only hides the
end date. The Battle Pass page shows a banner card with the agent's name,
portrait, background and gradient from valorant-api.com, and XP against the
200,000 goal (Riot doesn't send the goal).
The contract catalog is cached until a game patch, so when the account has XP on
a contract the catalog doesn't know, the page reloads the catalog once.

### Career account status

Career shows Account status below Current Rank. `career_account_status` takes the
Career account PUUID and independently requests `/restrictions/v3/penalties` and
`/restrictions/v1/activeFutureInterventions` through the shared authenticated PD
client, rate budget and auth retry. Each request has a 20-second timeout; status
errors never block rank or history. Responses from a different account are
rejected. Empty collections differ from failures or malformed responses. The
panel shows reported penalty types, reasons, expiry and remaining games, plus
active interventions and next intervention names by behavior category. It does
not infer dates for next interventions. Refresh rechecks both endpoints. Nothing
is saved locally. The schemas come from the user's linked Valdocs documentation
and its `valorant-api-types/src/endpoints/pvp` source.

Matches uses container width for its shared header/row grid: compact under 40rem,
agent/KDA/date from 40rem, and all summary statistics from 54rem. This accounts
for the app rail and page padding; viewport breakpoints clipped the date column.

Act Rank keeps border and crystal images in `src/assets/mmr` and resolves them
with module-relative `new URL` so
Vite includes them as bundled assets. Acts below tier 3 show Unranked; RR and
win-based peak/lowest show a dash when they do not apply. The peak is labelled
Act peak because it belongs to the selected act, not the player's lifetime.

### Saved match chat history

Settings → Application → Save match chat history is opt-in (`saveMatchChatHistory`,
default false). Captured core-game Team/All messages are saved to
`%APPDATA%\ValoUtils\match-chat-history.json`, grouped by account PUUID then
`matchUuid` (the UUID in the room CID, without `-blue`, `-red` or `-all`).
The existing REST poller and relay/XMPP forwarder capture while the app runs,
including when Chat is closed. Relay/XMPP messages carry their source session's
account internally; REST batches validate the owner before and after fetching to
discard an account-switch batch. This stores captured chat only; Riot cannot
retrieve old match chat that the app never observed. Private, party and pregame
chat are excluded. Raw API fields are not saved. Writes replace a temporary JSON
file and surface errors without overwriting unreadable history.
The Chat rail's History tab (below Friends/Party/Team/All) opens saved matches
read-only, newest first, with a Team/All switch; it lists only the signed-in
account's history. The live Team/All sidebars no longer carry the picker.
A collapsible Scoreboard bar above a saved thread shows every player's line
(`MatchScoreboard` + `useMatchDetails`, the Matches page's `match_details` cache),
fetched only when opened. Its rows have a Copy PUUID button (`copyPuuid` on
`MatchScoreboard`; the Matches page leaves it off).
History lists every account with saved chat (`chat_saved_history_accounts`) in an
account picker; the signed-in account stays live, others are read from the file
(`chat_saved_history_get`, `args: [puuid]`). While signed in, missing owner and
speaker Riot IDs are looked up in batches of 100 through the name service and
saved under `names` in `match-chat-history.json`. History needs no sign-in; the
Chat sign-in panel offers View saved chat. Each saved match is a card (newest first) with
its last message time, Team/All line counts, speaker count and the latest line
in the viewed room; more than three matches adds a message/player search.
Cards also show map, mode, your agent and the result. `chat_saved_match_details`
(`args: [matchUuid]`) reads them from the saved match's `details` field in the
JSON, or fetches match-details once (shared PD client and auth retry), saves
them there and returns them. Only matches the signed-in account has saved can be
looked up. The Chat page looks up missing details one at a time while Team/All
is open. A failure, usually a match still in progress, is retried after five
minutes. Older history without `details` still loads.
`details.speakers` keeps the Riot ID and agent of each player who wrote a saved
line (only those players), so the saved thread names senders and shows agent
icons, and its header shows map · mode · result · start time instead of the
match ID. Details saved before speakers existed are looked up once more.
Capture also names speakers on the spot: each saved match's `speakers`
(PUUID, Riot ID, agent) is filled from the in-memory Live Game snapshot
(`match_chat_history::current_roster`, only when its `match.id` is the same
match), and the Riot ID is added to `names`. No extra requests; incognito
players keep their agent but not their name. The frontend merges these with
`details.speakers` (`savedMatchSpeakers`), match-details values winning.
Disabling saves keeps existing history. Clear match
chat history deletes all accounts' saved chats on this device and disables saving
so polling cannot restore its backlog. No cloud sync or new dependencies.

### AI providers

Settings → AI selects Anthropic, OpenAI, Google Gemini, or an OpenAI-compatible
endpoint. `aiProvider` defaults to `none`; `aiProviders` retains each provider's
`apiKey`, `model`, and (for compatible endpoints) `baseUrl`. Empty models use the
built-in default, except compatible endpoints which require a model. Config loads
into the process-wide `ai` RwLock at startup and refreshes through `config_set`.
The AI HTTP client verifies TLS and permits HTTP only on localhost. Keys are
plaintext in local config.json, like the existing DeepL key; never log them or
request bodies. Text is sent only when an AI feature is used.

Settings provides a Fetch models button and a model dropdown, while preserving
manual model IDs. `ai_models` takes a snapshot of the chosen provider and its
settings, so listing works before selecting a model on a compatible endpoint.
Anthropic and Gemini pagination is followed within a 20-second total timeout;
Gemini lists only models supporting generateContent. Lists are transient and
invalidated when the provider, key or endpoint changes. Never log credentials.
Completions (bot blocks, translation, Test, match analysis) share `ai::REQUEST_TIMEOUT`
(60 s), since self-hosted and reasoning models often take 30 s+.

The `ai` chat translator shares Google's language catalog. Bot custom commands
support balanced `{{ai: … {{map}} …}}` blocks: variables resolve first, then up to
three AI blocks per message run concurrently before translation. Failed blocks
become `N/A`. The editor provides a separate AI block insert button.
`.ai` and `.ask` are private by default: the answer goes only to the player (a
composer system line, or a Dummy Bot DM/whisper). `.ai party|team|all <prompt>`
is the only form that posts, to the named room.
Commands run only when whispered to the Dummy Bot or typed in the Chat composer.
Chat commands accept `.` or `/`, including saved custom triggers (both prefixes
resolve to the same trigger). Autocomplete preserves the typed prefix. Presence
commands keep their `$` prefix. `.party join <code>` (also quoted, e.g.
`/party join "TUE693"`) joins by invite code; `.party leave` removes only the
signed-in player; `.code create` generates the current party's invite code and
returns it privately. These use the shared authenticated GLZ client and auth
retry, and report Riot errors. Party/code commands are reserved custom triggers
and, like other built-ins, are swallowed in in-game group chat without running.
Built-in commands (`.send`, `.tran`, `.dodge`, `.ai`, `.ask`, `.ascii`) and dotted
custom triggers typed in party/pregame/team/all chat never run: the relay swallows
the line and the bot whispers a reminder. The one exception is `.tran`/`.translate`
(read-only, private reply): the relay still swallows it, runs it for the room it
was typed in unless it names one (`chat_command::history_translate_for_room`), and
the Dummy Bot whispers the translation.
`.who`, `.rr`, `.last` and `.met` (`chat_command::QuickCommand`, `commands/quick_stats.rs`)
are read-only and private too, so they also run from rooms (swallowed, answered by
the bot), from bot whispers and from the composer. `.who` is
`bot_template::who_lines` over the Live Game roster (no requests; Riot IDs except
players hidden outside your party); `.rr` reads the saved career, fetching only when
it is stale; `.last` reads the newest match through the Matches cache plus RR from
the saved career; `.met` (`bot_template::met_lines`) lists lobby players from the
"Played before" tally of your last 10 matches. The UI shows `/` as the default
prefix (`.` still works). Replies are short plain lines (no emoji, max 80 chars) and are
whispered one message per line, since Valorant collapses whisper newlines. They are
not reserved names: a saved custom trigger called `.who`/`.rr`/`.last` wins. The REST poller ignores the player's own
lines, so without the relay such a line is posted as ordinary chat.
In agent select or a live match, `.ask` also sends a fenced `<live_game>` block
(`bot_template::ask_game_context`): map, mode, phase, and per player agent, rank,
RR, peak, level and cached recent form, labelled `You` / `Ally N` / `Enemy N`.
It reads the stored Live Game roster (one fetch only when that has lapsed) and
`LiveStatsCache` only, never extra match-history requests. In a live game it adds
`score` (yourTeam, enemyTeam, roundsPlayed) from the player's own chat presence
(`partyOwnerMatchScoreAllyTeam`/`EnemyTeam` in `/chat/v4/presences`, via
`friends::fetch_own_match_score`, 2 s cap); Riot's match APIs carry no live score.
Match analysis sends only anonymized scoreboard stats: `You`, `Ally N`, and
`Enemy N`. Never send other players' Riot IDs, PUUIDs, or party IDs in match
analysis. Results stay in Matches state by match ID; Regenerate makes a new call.

### Played before & parties

`commands/encounters.rs` reads your last 10 matches (one match-list request,
reused 90 s, plus the Matches page's cached scoreboards, fetched one at a time
through `mcp::scoreboard` only when missing) and tallies each other player's
`with` / `against` count and last shared match. `encounters_get` serves it to
the app (`useEncounters` in `src/util/encounters.ts`, same 90 s reuse) and MCP
rows get `playedBefore` ("with you 2× · against you 1×"). The viewed finished
match is excluded so it doesn't count itself. `EncounterBadge` shows the total
on Live Game roster rows and finished-match scoreboard rows (green: with you,
red: against, amber: both; split in the tooltip).
Finished scoreboards colour parties like Live Game: players sharing a
`partyId` with someone else get a "Party N" number (`match-parties.ts`) and the
`partyColor` edge/label. MCP marks them "🔵 Party 1" (`party_marks`) in
`get_match_details`, and `get_live_match` turns Live Game's detected "Team N"
labels into the same marks (`party_mark_for_label`). MCP results also carry
🟢/🔴/⚪ results, 🟢/🔴 RR (`mark_rr`, applied after summaries read the numbers)
and ⬆/⬇ rank changes.

### Add a new IPC channel

1. Add a `#[tauri::command]` in the matching `src-tauri/src/commands/*.rs` module (`args: Vec<Value>` in where needed, structured `Value` or a serializable type out)
2. Register it in the `generate_handler![]` list in `src-tauri/src/lib.rs`
3. Call it with `await invoke<Response>("my_channel", { args: [...] })`; use the actual registered Rust command name. Reply with `{ success: true, ... }` or the feature's error shape and handle rejected Promises.
4. For backend pushes, use `app.emit("my:event", payload)` and `listenEvent<Response>("my:event", callback)`; clean up the subscription in the owning effect.

### Chat certificate identities

Bot and the shared login recovery panel show Wake config server when
`client_config_status` cannot reach the active loopback server's
`/__valoutils/health` endpoint. The config server and relay start automatically
when ValoUtils opens. Port 8000 is preferred; if occupied, Windows assigns a free
loopback port. Status, the Bot endpoint and Riot's launch URL use the selected
port, which is retained across stop/wake within the same app session.
`client_config_start` starts the relay and verifies the local config server,
recovering stale server tasks without restarting or signing out Riot Client.
Automatic startup, start, stop and launch commands share the launch lock.
Certificate failures and other bind failures remain errors; only a healthy
server reports success. An already-running Riot Client cannot be repointed to
a different config URL; close it completely and launch through ValoUtils when
the selected port changes.
The XMPP relay port is sticky too: the Riot Client reads `chat.port` once at
launch, so `relay::start` rebinds this session's last port, else the saved
`relayPort`, before falling back to a free one (logged: that client must
restart). Reopening ValoUtils or Wake then lets a running client reconnect.
The client also never re-reads its config, so the real Riot chat server it named
is saved as `relayUpstream` (`presence_proxy::remember_upstream`, only
`*.riotgames.com` hosts are restored) and restored at startup; otherwise the
reconnecting client hits "Riot chat target is not ready" forever.
Each local TLS handshake saves the Riot Client's lockfile pid as `relayClientPid`.
`client_config_status` reports `relayClientLost` when that same pid is running
with no relay connection (`presence_proxy::relay_client_lost`); a client opened
without ValoUtils has another pid and never counts. `RelayBanner`
(`src/components/relay-banner.tsx`, above the router) polls every 10 s, shows after
two lost polls in a row, offers Start relay (when the relay is down) and Restart
through relay (`useRiotClientActions`), and reappears after a later loss if dismissed.
A failed accept is logged and skipped rather than ending the relay, and `start`
replaces a relay task that has finished, so Wake recovers a dead relay.

The local chat relay's TLS identity is selectable (config key `presenceCert`, default `deceive`). Built-in identities live in `src-tauri/src/chat_certs.rs`; each has a host, a PFX download URL, and its own cache file `%APPDATA%\ValoUtils\<host>.pfx` (legacy `localhostCert.pfx` is migrated into the deceive slot). `presence:status-set "cert" <id>` switches and restarts the relay; `presence_cert_import` opens a native picker and installs a PFX for an identity. The selected host drives the `chat.host`/`chat.affinities` rewrite in `client_config.rs` and the SAN/loopback validation — the host must resolve only to `127.0.0.1` (DNS-only A record, no AAAA), so a hostname serving the PFX publicly (e.g. behind Cloudflare) cannot also be the chat host.

### Match timelines

The finished-match scoreboard has a collapsible Rounds & kills panel in
`src/components/match-timeline.tsx`. `match_timeline` returns round winners,
ordered kills, plant/defuse events and player positions. Scoreboard fetches
also fill a 40-match backend timeline cache, avoiding another PD request when
the panel opens. The minimap uses the map asset's projection with swapped game
axes. Selecting a kill shows positions at that moment and hides the spike until
its plant time; the default round view shows all death locations and the plant.
Elapsed round time accepts m:ss (1:39 is 99 seconds), with a seek slider and
Play/Pause at 1x, 2x or 4x. Event selection uses recorded kill, plant or defuse
snapshots; replay linearly animates shared players between consecutive snapshots
and labels that movement as estimated rather than a recorded trajectory.
It stops at the final recorded event and resets when the round changes.
Before the first snapshot, no player positions are shown.

### Add a new profile action button

- Follow the pattern in `src/pages/SettingsProfiles.tsx`
- Use `CustomButton` with `onClickLoading` returning a `Promise<void>` — reject with a string to show an error toast

### Agent-lock event logs

Live Game pregame refreshes write an `INFO` entry (`Agent lock observed`) to the
existing log file and Logs page when Riot reports `CharacterSelectionState: locked`
for your team (including you). Only normalized `Ally` players are recorded; enemy
and unknown-team locks are excluded from both the logs and the Events panel count.
Each entry includes the match, player PUUID, and agent UUID. Repeated polls and
partial rosters do not repeat the same lock; a new match starts fresh tracking.
The log timestamp is when ValoUtils first observes the lock, including players
already locked on the first refresh, rather than a server-provided lock time.
Collection follows Live Game polling (normally every 5 seconds while the app is
open, including other pages; idle polls every 15 seconds). It adds no extra
network requests beyond those polls. The pregame player document is reused for
3 minutes, and the pregame match document for 10 seconds, so a lock that lands
between those refreshes is observed on the next match-document fetch rather than
on every tick. A minimized or unfocused window skips ticks until it is visible
again. Locks may be missed if agent select ends between polls. A GLZ 429 holds
GLZ reads only and serves the last snapshot with `warning: rateLimited`; it does
not strike the PD budget. Name and rank enrichment spends the PD budget on the
current party members before the rest of the roster. Solo queue keeps roster order.

Snapshots also include `events` with stable IDs and `observedAt` Unix milliseconds.
The Events sidebar on the right of Live Game shows these with agent icons and
localized agent names, respects hidden player names, and retains the original
timestamps across refreshes and the transition into the same core game. Events
are scoped to the current match and collected in memory while the app runs.
It is a full-height column beside the roster (never overlaying it), so it cannot
cover player details toggles. Collapsed, it is a narrow strip that still shows
the count; the collapsed choice is remembered per viewer in localStorage. The
match summary and roster scroll as one column, with the roster header sticky.
The Events UI also filters incoming entries and their count against the current
allied roster (including yourself), excluding enemies and unknown players even
in older snapshots. In core game it uses your Red/Blue team rather than assuming
a fixed side; entries without a confirmed allied player stay hidden.

### MCP server for AI agents

Settings → AI agents (MCP) turns on a local MCP server (`mcpEnabled`, default
false) so Claude Code, Claude Desktop (through `mcp-remote`), Cursor, VS Code and
other MCP clients can use ValoUtils. `src-tauri/src/mcp.rs` serves Streamable
HTTP with plain JSON replies (no SSE, no sessions) on `127.0.0.1` only, at
`/mcp`. Port 47823 is tried first, and the port in use is saved as `mcpPort` so
client configs survive restarts. Every request needs `Authorization: Bearer
<mcpToken>` (32 random bytes, created on first use, replaceable from Settings).
Requests with an `Origin` header are refused so web pages can't reach it.
Tools live in `commands/mcp.rs` and reuse existing commands (same PD client,
rate budget and auth retry): `get_player_overview` (Riot ID, PUUID, region, current act wins/games/leaderboard,
peak rank from wins by tier, per-act ranks, net RR), `get_live_match` (the `.ask`
context: You / Ally N / Enemy N, no names; MCP adds each player's non-default
skins from Live Game's `loadout.weapons`, skin per weapon UUID, no extra Riot
requests), `get_store` (skin, bundle and accessory
names from valorant-api.com; accessories also get a `kind`; buddy/spray levels
take the parent's name, as level names are internal), `get_battle_pass` (active act/event passes from the valorant-api.com
contracts, seasons and events catalogs, cached per session: tier, XP, premium,
days left and the next three rewards by name), `list_settings_profiles` (names and
dates only), `get_settings_profile` (decoded settings of a saved profile or the
current account), `lookup_player` (Riot ID or PUUID → rank and matches, as on
the Tools page), `get_match_history` (own line per match, up to 10, one
match-details request each through the Matches cache), `get_match_details`
(scoreboard with every player labelled You / Ally N / Enemy N plus `riotId`
while `mcpShowNames` is on; never PUUIDs or party IDs), `get_friends` (no PUUIDs or party IDs;
includes the player's own friend notes, optional `search` over Riot ID and note), `get_account_status`, `get_agent_progression`; party and queue: `get_party`,
`leave_party`, `start_queue`, `stop_queue`, `change_queue` (GLZ
`/parties/v1/parties/{id}/matchmaking/join|leave` and `/queue`, checked against
`EligibleQueues`), `create_party_code`, `join_party`, `disable_party_link`; chat:
`get_chat_messages` (party/team/all/friend from `chat_get`), `send_chat_message`
(rooms through the `.ascii` relay path, whispers to friends by Riot ID only),
`set_presence`; cosmetics and rounds (`commands/mcp_cosmetics.rs`): `get_loadout`
(equipped skin/chroma/buddy per weapon in armory order, card, title, sprays),
`get_owned_skins` (skins by weapon from inventory skin levels, other counts),
`find_player` (1–10 Riot ID aliases or PUUIDs → Riot ID + PUUID through the
local alias lookup, no stat requests), `compare_players` (2–5 Riot IDs/PUUIDs/"me", looked up one at a time: rank, RR,
peak, act record and win rate, recent net RR), `translate_message` (`chat_translate`
with the Settings translator), `get_match_timeline` (`matchId`, optional `round`; labels from
`mcp::player_labels`, same as the scoreboard); launch: `open_riot_client`, `open_valorant` (`mode` "relay" =
Launch with XMPP relay, the default, or "normal"); `close_riot_client`,
`restart_riot_client` (see Close / restart Riot Client). Tools that act are marked
`readOnlyHint: false`. Agent and map names
come from `bot_template::content_names` (cached valorant-api.com catalog).
Settings shows copyable setups: an agent prompt, a Claude Code command, Claude
Desktop JSON and HTTP-client JSON. The token is masked on screen. The section's
Docs button opens `McpDocsPage` (connect steps, example questions, and the live
tool list from `mcp_tools`).
Settings → AI agents → Include player names (`mcpShowNames`, default on)
adds Riot IDs to `get_live_match` (except players who hid theirs, unless in
your party), `get_match_details` and `get_match_timeline` labels. `.ask` and
in-app match analysis stay anonymous regardless.
Commands: `mcp_status`, `mcp_tools`, `mcp_set_enabled` (`args: [bool]`),
`mcp_regenerate_token`.
Tool results are Markdown from `src-tauri/src/mcp_format.rs` (labelled lines,
tables for lists, identifying columns first, ranks by name, yes/no, tidy numbers,
scores as "7–5"), with the raw object in `structuredContent`; the server
instructions ask agents to lead with the answer and never paste JSON.

### Remote chat (phone, LAN / Tailscale)

Settings → Remote chat (`remoteEnabled`, default false) starts `src-tauri/src/remote.rs`:
an axum server on `0.0.0.0`, port 47824 first (saved as `remotePort`). It serves a
self-contained phone page (`src-tauri/src/remote_page.html`, chats sidebar: a fixed column from 760px, a ☰ drawer below; no CDN, DOM built with
`textContent`) at `/` and a JSON API: `GET /api/state` (Party/Team/All rooms with
their last 100 lines, `ended` rooms read-only, friends with unread counts and the
last 50 whisper lines), `POST /api/whisper` (`puuid`, `read`: friend-only `chat_history` + `chat_mark_read`, merged with the summary lines), `POST /api/send` (`channel` party|team|all through
`mcp::send_chat`, or `friend` + `puuid`, sent only to a friends-list `pid`),
`GET/POST /api/party` (`mcp::party_snapshot`; start/stop/change queue, leave,
create/disable/join party code through the existing MCP/riot_chat helpers).
Only loopback, private LAN, link-local and Tailscale `100.64.0.0/10` (plus IPv6
ULA/link-local) peers are answered; foreign `Origin`s are refused; every API call
needs `Authorization: Bearer <remoteToken>`. The QR URL is
`http://<ip>:<port>/#t=<token>`: the fragment never reaches the server, the page
moves it to the phone's localStorage and strips it from the address bar. A 401
unpairs the page. `chat_get` is cached 2.5 s and the party 4 s, so phones add
little Riot traffic; the page polls every 3 s (15 s hidden) and only patches the
message list so the phone keyboard stays open. Addresses come from UDP route
lookups (no packets sent): Tailscale via `100.100.100.100`, LAN via the default
route; listed Tailscale first, each with a `qrcode`-crate SVG. Settings blurs the QR
until clicked (it holds the secret; streamers). "Unpair all phones" regenerates
the token. Plain HTTP: Tailscale is WireGuard-encrypted, LAN is not.

### Watched friends

The Friends page star (`friends_watch_set`, `args: [puuid, watch]`) saves PUUIDs
in `watchedFriends`. `src-tauri/src/friend_watch.rs` polls `/chat/v4/presences`
(local Riot Client, no PD budget) every 10 s while the list is non-empty and, on
a watched friend's INGAME transition, emits an `alert:info` toast plus a Windows
notification (`tauri-plugin-notification`): "Duo#NA1 started a match ·
Competitive on Ascent" / "Duo#NA1 won 13–9 on Ascent". The first sighting never
notifies; the final score is the last presence score seen.

### Open Riot Client

The login panel's Open Riot Client button (`riot_open_client_with_config`, MCP
`open_riot_client`) starts the Riot Client through the config server and XMPP
relay with no `--launch-product`, so chat, presence and the bot work out of
game. Launch arguments still apply, minus product/patchline/config-URL flags.

### Launching with the Riot Client already open

Both launch commands (and MCP `open_valorant`) no longer refuse a running
client: `launch_in_running_client` asks it to start the game through
`POST /product-launcher/v1/products/{product}/patchlines/{patchline}` (its Play
button), or after sign-in via `watch_game_start` when it is signed out. The
reply has `runningClient`, `waitingForSignIn` and `relayActive` (the client is
connected through the XMPP relay). The login panel then shows one Launch
VALORANT button, and offers Restart through relay only while `relayActive` is
false; restarting is never needed just to play.

### Close / restart Riot Client

`riot_client_close` force-closes the Riot Client processes (`taskkill /F /T`,
then waits up to 10 s for `tasklist` to clear) and drops cached tokens.
`riot_client_restart` closes it and reopens it through the config server and
XMPP relay; VALORANT is relaunched (relay launch) only if it was running.
Both take `args: [closeGame]`: while VALORANT runs they close nothing and reply
`code: "valorantRunning"` unless `closeGame` is true. `RiotClientActions`
(`src/components/riot-client-actions.tsx`) always confirms Close (one prompt,
naming VALORANT when `client_config_status` says it runs; Restart asks only
then) through the app-wide modal and
reports results as toasts; it appears in the login panel while a client is
already running and in the account status menu. MCP: `close_riot_client`,
`restart_riot_client` require `userAsked: true` (agents with a stale tool list
closed the client just to launch; without it they are refused and pointed at
`open_valorant`), then close without a prompt; optional `closeGame` closes a
running VALORANT and is passed on the first call when the user already confirmed.

### Playing state

`client_config_status` also returns `valorantRunning` (the
`VALORANT-Win64-Shipping.exe` process, from the same single `tasklist` call as
`riotClientRunning`). The login panel then swaps its two launch buttons for a
green Playing status, and MCP `open_valorant` replies that the game is already
running instead of trying to launch.

### Launch arguments

Settings → Riot API → Launch arguments (`riotLaunchArgs`, default empty) adds
extra Riot Client arguments to every Valorant launch: both login-panel buttons
and MCP `open_valorant`. `split_launch_args` in `commands/riot_launch.rs`
splits the text like a command line (whitespace, double quotes). The
arguments follow `--launch-product` / `--launch-patchline`. An extra one of
those replaces the default (e.g. `--launch-patchline=pbe`), and an extra
`--client-config-url` is dropped so the relay launch keeps its own.

### Enemy team in agent select

Settings → Riot API → Show enemy team in agent select (`showPregameEnemies`,
default true). Riot often hides the enemy team in pregame; when it is revealed
through loadouts, Live Game lists the enemy five. Turning the setting off drops
enemy players in `live_game_fetch` before enrichment, so no names, ranks or
stats are requested for them. The snapshot sets `match.enemiesHidden`, and the
pregame notice then points to Settings instead of saying the roster is unavailable.

### Open at Windows startup

Settings → Application → Open at startup uses `startup:get` / `startup:set`,
registered in `lib.rs` and implemented in `commands/startup.rs`. Windows' current-user
`Software\Microsoft\Windows\CurrentVersion\Run` value named `ValoUtils` is the source
of truth; no duplicate preference is saved in `config.json`. Enabling writes the
quoted current executable path, and disabling removes only that value. Startup
registration is opt-in and takes effect at the next Windows sign-in. The UI waits
for a successful reply before changing the toggle and reports registration errors.

Settings → Application → Open on display saves `startupMonitor` in `config.json`.
An empty selection follows the primary display; a named selection uses the Windows
monitor name, with a primary-display fallback when disconnected. The display list
includes resolutions and a refresh control. `commands/display.rs` positions the
main window within the selected monitor's work area before `lib.rs` shows it;
`tauri.conf.json` starts the window hidden to avoid flashing on the wrong display.
Placement errors are logged and the window is still shown. The choice applies to
both manual launches and Windows sign-in launches, and does not move other apps.

### Crosshair codes

`src-tauri/src/crosshair_code.rs` turns each saved crosshair profile
(`SavedCrosshairProfileData`) into a share code, listing only non-default values
like the game. Only the primary crosshair (`P` section) is encoded; its keys and
defaults mirror `crosshair-svg-generator.tsx` and the fields in
`util/crosshair-mapper.ts`. Not encoded yet: ADS/sniper sections, general flags,
outline color, hide crosshair, spectated crosshair, focus mode. Settings view
replies include `crosshairCodes` (`[{ name, code, active }]`); MCP
`get_crosshair_codes` returns them for the account or a saved profile.
`code_from_spec` builds a code from a plain description (color, outlines, center
dot, inner/outer lines), clamped to in-game ranges: MCP `build_crosshair_code`
takes it directly; `ai_crosshair_generate` (`args: [description]`) asks the
Settings → AI provider for that description (`prompts::CROSSHAIR_DESIGNER`) and
returns `{ success, code, name, settings }`. UI: Tools → Crosshair generator
(prompt, previews on three backgrounds, Copy code, Copy link, recent results).

### valoutils:// links

`tauri-plugin-deep-link` registers the `valoutils` scheme (NSIS installer; dev
builds call `register_all` at startup). With single-instance's `deep-link`
feature, a link opened while the app runs reaches `on_open_url` in the running
window. `commands/deep_link.rs` parses `valoutils://crosshair?code=..&name=..` (code
limited to share-code characters), `valoutils://player?riotId=Name%23Tag` or
`?puuid=..`, and `valoutils://match?id=..`; it keeps the link as pending
(`deep_link_take`) and emits `deep-link:open` (`{ kind, ... }`). `DeepLinkWatcher`
opens crosshairs and players on Tools (`valoutils:navigate` /
`valoutils:tools-open` window events, parked in `util/deep-links.ts`) and matches
in the app-wide dialog (`MatchLinkView`). Copy-link buttons: crosshair generator,
Tools player lookup, History scoreboard.

### Add a new settings tab in the viewer

- Edit `src/components/parsed-settings-viewer.tsx`
- Settings come from `settings:profile:view` / `settings:current:view` (decoded in `src-tauri/src/settings_decoder.rs`); the reply includes `settings` and `crosshairs`

## Gotchas

- The Riot Client lockfile may not exist if Riot Client is not running — `get_riot_client_info()` returns `Err` in that case; commands surface it as `{ error }` JSON.
- Riot's localhost HTTPS uses a self-signed cert. `riot/client.rs` uses a reqwest client with `danger_accept_invalid_certs(true)` — this is intentional and must stay scoped to the local client only.
- Tauri command names can't contain `:` or `-` — the bridge maps channel `settings:profile:list` → command `settings_profile_list`. Keep them in sync.
- Rust commands return expected failures as structured `Ok(json with error field)`. Handle `invoke()` rejections explicitly; background actions can use `reportIpcError` to log and show an error toast.
- Profile names are unique keys; duplicate-name detection happens in `settings_profile_rename`.
- Share codes are 10 characters and expire after 90 days.
- Settings blobs must be at least ~2500 chars of valid base64 to be accepted as a profile (validation in `SettingsProfiles.tsx`).
- Analytics events (`analytics:track`) fire on every user action — keep them when adding new features.
- Never commit `src-tauri/valoutils.key` (updater signing private key, gitignored).
- The chat XMPP client (`src-tauri/src/xmpp/`) is a from-scratch Rust port — it can only be truly verified against Riot's live chat server with a signed-in account.

## Key Constraints

- **Windows only** — relies on `%LOCALAPPDATA%`, WebView2, and the Riot Client lockfile
- **Single instance** — `tauri-plugin-single-instance` (first plugin in `lib.rs`) makes a second launch focus the running window and exit, so the relay, config server and window are never duplicated
- **Tray** — `src-tauri/src/tray.rs` (tauri `tray-icon` feature): left-click or Open shows the window, Quit exits. The menu shows chat status ("Chat connected · Online", also the tooltip, refreshed every 3 s from in-memory relay state), Launch VALORANT (relay launch, result as a Windows notification) and a Presence submenu (`presence_proxy::change_mode`). Presence defaults to `online` for new configs. The close button hides the main window to the tray unless `closeToTray` is false (Settings → Application), because the relay, config server, MCP and remote chat live in this process and quitting drops Riot chat. The first hide shows a one-time Windows notification (`trayHintShown`)
- **Riot Client must be running** to save/load profiles (lockfile must exist)
- **Valorant must be closed** when loading a profile (Riot Client applies settings on next launch)
- No cloud sync — profiles are local JSON in `%APPDATA%\ValoUtils`
- Riot's API is private/unofficial — no guarantees of stability
