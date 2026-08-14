# Task 3 — Router integration, localization, and dismissal behavior

## What changed

- Replaced the HeroUI tab header in `Router` with the two-row floating dock header: ValoUtils wordmark and Riot status control in the utility row, plus `NavbarDock` in the scrollable dock viewport.
- Split visible routes into dock and overflow groups, retained route selection analytics, and close overflow after a route is selected.
- Added controlled overflow state with outside-pointer dismissal and Escape dismissal. Router ignores an Escape already handled by `NavbarDock`, preserving the dock's trigger-focus restoration behavior.
- Portaled the overflow menu to `document.body` with fixed, viewport-bounded positioning so it can render above page content instead of being clipped by the horizontally scrolling dock viewport. Router includes both the More trigger and portaled menu in its outside-pointer boundary.
- Added the Escape-only dismissal policy helper and its regression test.
- Added `nav.more` translations for English, Korean, and Traditional Chinese, and a reduced-motion override for `.navbar-motion` transitions.

## Files changed

- `src/components/router.tsx`
- `src/components/navbar-dock.tsx`
- `src/components/navbar-dock.test.tsx`
- `src/components/navbar-layout.ts`
- `src/util/navbar-routes.ts`
- `src/util/navbar-routes.test.ts`
- `src/i18n/locales/en.json`
- `src/i18n/locales/ko.json`
- `src/i18n/locales/zh-TW.json`
- `src/index.css`

## TDD evidence

1. Added the required `shouldDismissNavbarOverflow` test before adding the helper.
2. RED: `bun test src/util/navbar-routes.test.ts` exited 1 with `SyntaxError: Export named 'shouldDismissNavbarOverflow' not found`.
3. GREEN: added `export const shouldDismissNavbarOverflow = (key: string) => key === "Escape";` and re-ran `bun test src/util/navbar-routes.test.ts`; 4 passed, 0 failed.
4. Review-driven correction RED: added an overflow-menu-position test before exposing the portaled position helper; `bun test src/components/navbar-dock.test.tsx` exited 1 because `getOverflowMenuPosition` was not exported.
5. GREEN: implemented the fixed, portaled menu position helper and re-ran focused tests; 13 passed, 0 failed.

## Verification

| Command | Result |
| --- | --- |
| `bun test src/util/navbar-routes.test.ts` | RED as above; subsequent GREEN: 4 pass, 0 fail. |
| `bun test src/util/navbar-routes.test.ts src/components/navbar-dock.test.tsx src/util/navigation-tabs.test.ts` | 13 pass, 0 fail after the portal correction. |
| `bun run lint` | Exit 0; Oxlint reported no errors. |
| `bun run build:vite` | Exit 0; TypeScript and Vite production build succeeded. Vite reported existing config-native and bundle-size warnings. |
| `bun run dev:vite -- --host 127.0.0.1` | Started successfully; `http://127.0.0.1:5173` returned HTTP 200 and contained the app root. Process stopped after check. |
| `bun test src` | 90 pass, 0 fail across 20 frontend test files. |
| `git diff --check` | Exit 0; no whitespace errors. |
| JSON locale parse check | All three locale files parse and provide `nav.more`. |

## Self-review

- Reviewed the committed diff against the task brief: HeroUI `Tabs` and `Key` imports are removed; selection still calls `goTo` and emits the unchanged `tab_change` analytics payload.
- Confirmed the status control remains in the utility row and the overflow reference wraps exactly the More trigger/menu, so outside pointerdown can distinguish both from the rest of the page.
- Confirmed router-level Escape handling skips an event default-prevented by the dock, avoiding a competing handler with the dock's focus restoration.
- Confirmed locale JSON validity and reduced-motion coverage for the dock tab transition class.
- Independent review initially found that the horizontally scrolling viewport would clip an absolutely positioned menu. The fixed portal corrects that root cause while preserving horizontal dock scrolling; the portal is included in the outside-click boundary and its position updates for viewport/nested-scroll changes.

## Concerns

- The requested visual/manual checks at 760x560 and 1000x720 could not be completed because this session does not expose the required browser-control runtime. Static inspection and the local Vite HTTP smoke check completed; interaction with a Tauri/Riot session was not attempted.
- `bun run build:vite` succeeds but reports pre-existing Vite warnings about native config loading and a minified chunk exceeding 500 kB.

## Commit

- `feat: restyle navbar as floating dock` (includes the portal correction and this report)
