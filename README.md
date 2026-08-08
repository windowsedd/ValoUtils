<p align="center">
  <img src="assets/banner.svg" alt="ValoUtils" width="100%">
</p>

<p align="center">
  <a href="https://github.com/windowsedd/ValoUtils/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/windowsedd/ValoUtils?style=flat-square&color=FF4655&labelColor=0E1419"></a>
  <a href="https://github.com/windowsedd/ValoUtils/actions/workflows/build.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/windowsedd/ValoUtils/build.yml?style=flat-square&labelColor=0E1419"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0E1419?style=flat-square">
  <img alt="Stack" src="https://img.shields.io/badge/Tauri%202-React%2019-FF4655?style=flat-square&labelColor=0E1419">
</p>

ValoUtils is a Windows desktop companion for VALORANT. It saves and restores full settings profiles, shows your rank and match history with per-round scoreboards, tracks your friends list, and parses local replay files — all without a login. It reads your auth tokens straight from the Riot Client's lockfile on your own machine.

---

## Features

### Settings profiles

- Snapshot your current in-game settings into a named profile
- Restore any profile back to your account in one click
- Share a profile as a 10-character code, or import a friend's
- Duplicate and rename profiles locally
- Inspect a profile without applying it — general, controls, crosshair (with live SVG previews), audio, video, and the raw decoded JSON

### Career & matches

- Current rank, peak rank, and RR progression
- Competitive history with expandable rows
- Full match history with per-match scoreboards: ACS, ADR, K/D/A, headshot percentage, and resolved player names
- Map thumbnails and agent icons inline on every row

### Friends

- Live roster with presence — who's online, in a queue, in agent select, or mid-match
- Queue, map, score, and party size for anyone currently in a game

### Replays

- Parses local `.vrf` replay files in-process, no external tools
- Extracts player positions, ability usage, and match events
- Export as structured JSON or raw records

### Also

- English, Korean, and Traditional Chinese
- Auto-update on launch and hourly, signed via minisign
- Built-in Riot API reference browser

---

## Requirements

- Windows 10/11 x64
- **Riot Client must be running** — ValoUtils reads its lockfile for auth
- **VALORANT must be closed** when restoring a profile; the Riot Client applies settings on next launch

No account, no login, no cloud. Profiles live in `%APPDATA%\ValoUtils`.

---

## Installation

Grab the installer from [Releases](https://github.com/windowsedd/ValoUtils/releases/latest).

| File | Notes |
| --- | --- |
| `ValoUtils_x.x.x_x64-setup.exe` | NSIS installer, installs per-user (no admin prompt) |

The installer is not yet Authenticode-signed, so SmartScreen will warn on first run — choose **More info → Run anyway**. Updates after that are handled in-app.

---

## Building from source

Requires [Bun](https://bun.sh) and a stable Rust toolchain (MSVC).

```bash
git clone https://github.com/windowsedd/ValoUtils.git
cd ValoUtils

bun install
bun run build:sidecar   # required once before the first dev run or build

bun run dev             # Vite dev server + cargo run, hot-reload
bun run build           # full production build → NSIS installer
```

Useful during development:

```bash
bun run debug:replay -- <path-to-replay.vrf>   # inspect replay parser output
cargo check                                     # from src-tauri/
cargo clippy                                    # from src-tauri/
```

---

## Architecture

```text
src-tauri/          Rust backend
  commands/         One module per feature — every #[tauri::command] lives here
  riot/             Lockfile reader, local client API, pd/glz game API
  replay/           In-process .vrf parser (Unreal netcode → positions/events)
  xmpp/             Hand-rolled XMPP client for Riot chat
  settings_decoder  base64 + raw-deflate blob decoding

src/                React frontend (WebView2)
  pages/            One page per nav tab
  components/       Scoreboards, crosshair generator, settings viewers
  util/             tauri-bridge.ts — invoke()/listen() shim
```

The frontend never calls `invoke` directly. It goes through a bridge in `src/util/tauri-bridge.ts` that maps channel names like `settings:profile:load` onto the Rust command `settings_profile_load`, and routes both command replies and backend-pushed events to the same listeners.

**How settings actually move:** the Riot Client writes a lockfile containing a local port and password. ValoUtils reads it, authenticates against `127.0.0.1` over HTTPS, and calls Riot's private `Ares.PlayerSettings` endpoint. The settings blob comes back base64-encoded and raw-deflate compressed; ValoUtils inflates it, parses the JSON, and renders it. Profiles are stored in their original encoded form, so nothing is lost in a round-trip.

---

## Releases

CI builds on every push. Pushing a `v*` tag triggers a signed build published as a **draft** GitHub Release with the installer and an updater manifest.

```bash
git tag v1.0.4
git push origin v1.0.4
```

---

## Disclaimer

ValoUtils is an unofficial third-party tool. It is not affiliated with, endorsed by, or connected to Riot Games. It relies on private APIs that Riot may change or restrict at any time.

Restoring a profile overwrites your current VALORANT settings — save your existing setup first if you want it back.
