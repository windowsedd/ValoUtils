# Enable Live Game navigation

## Goal

Make the existing Live Game page available from the main navigation.

## Design

Import `LiveGame` in `src/main.tsx` and add a permanent route after Matches. The route uses the existing `nav.liveGame` translation, the ID `live-game`, and a crosshair icon from the current icon package.

The tab has no feature flag. It reuses the existing Live Game page, Tauri commands, polling, and error states without changing backend behavior.

## Verification

Run the TypeScript and Vite production build. Confirm the route ID is unique and the three locale files already define `nav.liveGame`.
