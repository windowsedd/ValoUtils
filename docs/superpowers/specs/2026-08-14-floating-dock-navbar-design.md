# Floating Dock Navbar Design

## Goal

Restyle ValoUtils' primary navigation as the approved "Floating dock" direction while preserving every current route, hidden-tab preference, analytics event, and Riot account/presence action.

## Visual Design

The app shell gains a compact utility row with a `V / VALOUTILS` wordmark on the left and the existing Riot status control on the right. Beneath it, the primary destinations sit in a centered floating dock with a dark raised surface, rounded corners, and restrained shadow.

The active destination uses a filled Valorant-red pill with white icon and label. Inactive destinations use muted gray text and gain a subtle lighter surface on hover. Focus remains clearly visible. Transitions are limited to color, background, and shadow over 150-200 ms; reduced-motion users receive no nonessential transition.

## Navigation Structure

- Render up to five currently visible routes directly in their configured order.
- When more than five routes are visible, render a labeled `More` control as the last dock item and place the remaining routes in an anchored menu.
- If the selected route is in the overflow menu, `More` receives the selected styling and the menu marks the exact selected route.
- Hiding routes in Settings continues to use the existing `filterVisibleRoutes` behavior; the first five remaining routes automatically fill the dock.
- Selecting either a dock item or an overflow item continues to call `goTo` and emit the existing `tab_change` analytics event.
- The Riot status menu retains its current data flow and actions, but anchors beneath the utility row instead of the old tab strip.

## Components

- `Router` remains responsible for route selection, analytics, and rendering page content.
- A small navigation helper within the router separates visible routes into dock and overflow groups. No route metadata or persistence format changes.
- `navbarLayout` remains the shared styling contract between the router and `RiotStatusBar`, updated for the two-row shell and menu anchoring.
- The overflow menu uses semantic buttons, `aria-haspopup`, `aria-expanded`, `role="menu"`, and `role="menuitem"`. It closes after selection, on outside click, and on Escape.

## Responsive Behavior

The supported app width starts at 760 px. At that minimum width, the dock keeps five labeled destinations plus `More` without horizontal page overflow. If localized labels exceed the available width, the dock itself may scroll horizontally with its scrollbar hidden; the Riot status control remains in the separate utility row and is never squeezed by navigation.

## Error and Edge Cases

- Zero visible routes keeps the existing empty selection behavior and hides the dock.
- Five or fewer visible routes omit `More` entirely.
- If a selected route becomes hidden, the existing `resolveSelectedRouteId` behavior chooses the first visible route.
- Account loading/offline states and presence warnings remain unchanged.

## Verification

- Add focused tests for splitting visible routes into primary and overflow groups.
- Verify an overflow route can be selected and receives the correct active state.
- Verify the overflow menu supports outside-click and Escape dismissal.
- Run the existing navigation preference tests, frontend unit tests, Oxlint, TypeScript checking, and Vite production build.
- Inspect the shell at 760 px and 1000 px widths, including a locale with longer labels, keyboard focus, and reduced-motion mode.

## Non-goals

- No route renaming or reordering.
- No changes to tab visibility settings or persisted configuration.
- No page-content redesign.
- No changes to Riot status polling, presence state, or settings-view behavior.
