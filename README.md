# ValoUtils

A desktop utility for Valorant that lets you save, load, and share full settings profiles — including crosshair data, keybinds, audio, and more.

Built with Electron + React + Vite.

---

## Features

- **Save profiles** — snapshot your current Valorant settings from your account
- **Load profiles** — apply any saved profile back to your account instantly
- **Share profiles** — generate a 10-character share code; anyone can import it
- **Import via share code** — paste a friend's code to load their settings
- **Settings viewer** — inspect a profile without loading it:
  - General (sensitivity, minimap, colorblind mode, gameplay toggles)
  - Controls (keybinds, agent overrides)
  - Crosshair (live SVG preview for every saved crosshair profile, copy code)
  - Audio (volume levels, push-to-talk, HRTF, mic settings)
  - Video (performance stat display modes)
  - Raw JSON (full decoded settings blob)
- **Duplicate & rename** profiles locally
- **Auto-update** — built-in updater checks for new releases on launch

---

## Requirements

- Windows 10/11 x64
- **Riot Client must be running**
- **Valorant must be closed** when loading a profile

No login required — ValoUtils talks directly to the local Riot Client to read your auth tokens.

---

## Installation

Download the latest installer or portable `.exe` from [Releases](../../releases).

| File                            | Description                      |
| ------------------------------- | -------------------------------- |
| `ValoUtils-Setup-x.x.x.exe`     | NSIS installer (recommended)     |
| `ValoUtils-x.x.x-portable.exe`  | No install needed, run anywhere  |

---

## Building from source

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/ValoUtils.git
cd ValoUtils

# Install dependencies
npm install

# Development (hot-reload)
npm run dev

# Production build
npm run build

# Build + publish to GitHub Releases (requires GH_TOKEN)
npm run release
```

**Stack:** Electron 42 · React 19 · Vite 8 · TypeScript · Tailwind CSS v4 · HeroUI v3

---

## CI / Releases

GitHub Actions builds automatically on every push.  
Tagged commits (`v*`) are built and published to GitHub Releases.

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## How it works

ValoUtils reads your Riot Client's local lockfile to get auth tokens, then calls Riot's private preference API (`Ares.PlayerSettings`) to fetch or push your settings. The settings blob is base64-encoded + raw-deflate compressed JSON — ValoUtils decodes, parses, and displays it in a structured UI.

Profiles are stored locally in your app data folder (no cloud sync, no account required).

---

## Disclaimer

ValoUtils is an unofficial third-party tool and is not affiliated with Riot Games. Use at your own risk. Loading a profile overwrites your current Valorant settings.
