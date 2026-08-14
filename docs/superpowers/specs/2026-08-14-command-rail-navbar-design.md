# Command Rail Navbar Design

## Goal

Replace the recently merged floating-dock header with the approved command-rail direction: a permanently compact, icon-only navigation rail on the left side of ValoUtils.

## Visual Design

The rail is a fixed-width dark surface running the full app height. A clipped Valorant-red `V` mark anchors the top. Navigation icons form a single vertical column beneath it. The selected destination uses a filled Valorant-red rounded square with a white icon and a short red edge marker; inactive destinations use muted gray and gain a restrained surface highlight on hover or focus.

The rail never expands. Every icon has an accessible name and a visual tooltip that appears to the right on hover or keyboard focus. Tooltips float above page content and do not change the rail width or content position. Transitions use only color, background, opacity, and transform over 150-200 ms and respect reduced motion.

## Navigation Structure

- Render the first six visible non-Settings routes directly, in their existing order.
- When additional non-Settings routes remain, show a `More` icon that opens a menu to the right of the rail.
- Keep Settings pinned near the bottom as a direct destination, matching the approved mockup. Settings remains available because existing hidden-tab filtering always retains it.
- Keep the Riot account/presence control at the bottom as a compact avatar/status button.
- If the selected route is inside `More`, the `More` icon receives selected styling while only the exact route receives `aria-current="page"`.
- Route selection continues to call `goTo`, close open menus, and send the existing `tab_change` analytics event.
- Existing hidden-tab preferences still determine which routes participate; no persistence format changes.

## Layout and Components

- `Router` changes from a header-plus-content stack to a full-height row containing the command rail and the existing page body.
- A new `NavbarRail` component owns the icon buttons, tooltips, and controlled overflow menu markup.
- A pure route-partition helper separates direct routes, overflow routes, and Settings without changing the source route array.
- `RiotStatusBar` gains a compact presentation mode. Its polling, presence state, settings viewer, and menu actions remain unchanged.
- The floating-dock component and its dock-only tests/tokens are removed once the rail replaces all usages.

## Accessibility and Interaction

- Every rail item is a native button with an `aria-label`; the current destination uses `aria-current="page"`.
- Tooltips appear for both pointer hover and keyboard focus and are not the only source of the accessible name.
- The `More` menu keeps the complete ARIA menu keyboard contract: first-item focus on open, cyclic Arrow Up/Down, Home/End, Escape focus restoration, selection focus restoration, and logical Tab/Shift+Tab handoff.
- Clicking outside the overflow or Riot status menu closes that menu.
- Focus rings remain clearly visible and do not rely on color alone.

## Responsive Behavior

The rail remains the same width at the supported 760x560 minimum window and larger sizes. Six direct routes, `More`, Settings, and the compact account control fit without vertical scrolling. Page content receives the remaining width and preserves its existing scrolling behavior. Menus and tooltips use fixed or portaled positioning so the rail cannot clip them.

## Error and Edge Cases

- With no non-Settings routes, the rail shows only Settings and account status.
- With six or fewer non-Settings routes, `More` is omitted.
- If a selected route becomes hidden, existing selected-route resolution falls back to the first visible route.
- Offline/loading Riot states retain their existing dot colors and translated labels through accessible text and tooltips.

## Verification

- Add pure tests for rail route partitioning, including Settings extraction, hidden-route promotion, overflow, and empty input.
- Add component markup tests for accessible labels, exact current-route semantics, permanent compactness, and overflow state.
- Preserve and run keyboard focus-policy tests for the overflow menu.
- Run all frontend tests, Oxlint, TypeScript/Vite production build, and Cargo check.
- Inspect 760x560 and 1000x720 layouts, tooltips, keyboard-only navigation, overflow positioning, the compact Riot status menu, and reduced-motion behavior.

## Non-goals

- No hover expansion, collapsible rail, or user-controlled rail width.
- No route renaming or persisted route reordering.
- No page-content redesign.
- No changes to Riot polling, presence control, profile viewing, or backend IPC.
