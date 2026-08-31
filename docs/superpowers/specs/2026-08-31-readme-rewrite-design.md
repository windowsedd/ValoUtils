# ValoUtils README Rewrite Design

## Goal

Replace the outdated English README with a concise, product-first project page and add a complete Traditional Chinese counterpart at `README.zh-TW.md`.

## Audience

The opening sections serve VALORANT players who want to understand and install ValoUtils. Later sections serve contributors who need build commands and a short architectural overview.

## Document structure

Both README files will use the same section order:

1. Banner, project badges, and language links
2. Product summary
3. Current features grouped by user task
4. Requirements, local data storage, and privacy details
5. Installer instructions and the Windows SmartScreen notice
6. Development, testing, and linting commands
7. Concise Tauri, React, Rust, Riot API, and XMPP architecture overview
8. Tagged-release workflow
9. Riot Games disclaimer and profile-restoration warning

## Content changes

- Remove the discontinued Replay viewer, `.vrf` parser, sidecar build step, and replay debugging command.
- Cover the current Profiles, Career, Matches, Live Game, Friends, Chat, Store, Battle Pass, Inventory, and Tools features.
- Describe authentication accurately: ValoUtils reads local Riot Client credentials and does not require a separate ValoUtils account.
- Use the current Bun scripts from `package.json` and Rust checks documented in `CLAUDE.md`.
- Keep private Riot API limitations and the requirement to close VALORANT before restoring settings visible.

## Localization

`README.zh-TW.md` will be a natural Traditional Chinese translation rather than a literal line-by-line rendering. Product names, commands, paths, filenames, and API identifiers will remain unchanged. Links and technical facts will match the English README.

## Quality checks

- Confirm both documents contain the same sections and links.
- Search both files for stale Replay and sidecar references.
- Verify commands against `package.json` and `CLAUDE.md`.
- Review Markdown headings, tables, code fences, and language-switch links.
