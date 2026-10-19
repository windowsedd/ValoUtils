# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users and purpose
ValoUtils is a Windows desktop companion for Valorant players. Its React interface runs in Tauri's WebView2. Players manage local settings profiles and inspect their signed-in Riot account, matches, shop, chat, and progression.

## Constraints
- Existing stack: Tauri 2, React 19, TypeScript, Tailwind v4, Rust.
- Riot Client supplies authentication. No new login or cloud account.
- Bloomline is read-only: show agent progression and tracked stats, without changing cosmetics or modules.
- Preserve the existing interface and local user data. Do not commit or push until requested again.
- Available evidence: CLAUDE.md, current components, and windowsedd-valorant-api 0.2.0's Bloomline types and endpoints.
