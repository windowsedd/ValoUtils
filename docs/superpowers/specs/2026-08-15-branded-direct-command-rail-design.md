# Branded Direct Command Rail Design

## Goal

Refine the compact ValoUtils command rail by using the existing ValoUtils app icon as its brand mark and exposing every visible destination directly, including About and Bot.

## Brand Mark

- Replace the generated red `V` tile with the existing transparent ValoUtils `V + wrench` artwork from `src-tauri/icons/icon.png`.
- Render the artwork inside the current 64px fixed-width rail without adding a background tile or changing rail width.
- Keep the image decorative inside an element labeled `ValoUtils`, with crisp sizing and preserved aspect ratio.

## Navigation

- Render every visible non-Settings route as a direct icon button in its configured order.
- About and Bot become normal direct rail buttons.
- Remove the `More` trigger, overflow menu, overflow positioning, and overflow keyboard-state code because no routes are hidden behind a menu.
- Preserve direct-route selection, exact `aria-current="page"`, translated accessible names, right-side tooltips, `goTo`, and `tab_change` analytics.
- Existing hidden-tab preferences continue to determine which routes appear.

## Vertical Layout

- The brand mark remains fixed at the top.
- The middle navigation column receives the remaining height and becomes vertically scrollable only when all visible route buttons cannot fit.
- Hide the middle column's scrollbar visually while retaining wheel, touchpad, and keyboard scrolling.
- Settings remains pinned above the Riot account/status control at the bottom and never scrolls away.
- The rail stays permanently fixed at 64px and never expands.

## Accessibility and Motion

- Every route remains a native button with a translated `aria-label`.
- Tooltips continue to appear to the right on hover and keyboard focus.
- Reduced-motion behavior continues to cover both buttons and tooltips.
- The primary navigation landmark includes the scrolling destinations and pinned Settings.

## Verification

- Update route grouping tests to verify all non-Settings routes remain direct and Settings is pinned.
- Update rail markup tests to verify the real icon asset, direct About/Bot buttons, absence of `More`, fixed width, and a scrollable middle navigation region.
- Run all frontend tests, Oxlint, the TypeScript/Vite production build, Cargo check, and `git diff --check`.

## Non-goals

- No expandable or collapsible rail.
- No route reordering or preference-format changes.
- No changes to page content, Riot polling, presence controls, or backend IPC.
