# Hide Replays Tab Design

## Goal

Let users remove the Replays tab from the main navigation through a persistent setting. Existing users continue to see Replays unless they enable the new option.

## User Experience

Add a `Hide Replays tab` switch to `Settings → App`.

- The switch defaults to off.
- Turning it on removes Replays from the navigation without restarting the app.
- Turning it off restores Replays without restarting the app.
- The switch uses hide semantics: on means hidden, off means visible.
- English, Korean, and Traditional Chinese locales provide the label and description.

The setting hides the route from the router's available route collection. It does not disable replay parsing, delete replay data, or change the Replays page.

## Configuration

Store a boolean `hideReplaysTab` value in the existing Tauri `ConfigStore`.

- `src-tauri/src/lib.rs` registers `false` as the default.
- `config_get_all` includes the key with a `false` fallback.
- `Settings.tsx` adds the key to `AppConfig`, initializes it to `false`, and updates it through the existing `config:set` channel.

This keeps the preference in the same `%APPDATA%\ValoUtils\config.json` store as other application settings.

## Navigation Behavior

`RouterProvider` owns the visible route list because it supplies the routes used for tab rendering and selection. On mount, it reads `hideReplaysTab` from `config:get-all`. `Settings.tsx` includes the changed key and value in the existing `valoutils:config-changed` browser event, so the provider can apply later changes without another IPC request.

When `hideReplaysTab` is true, the provider filters out the route whose id is `replays`. The filtered list drives both tab rendering and route lookup, so hidden Replays cannot remain available as a selectable application tab.

The router tracks selection by route id instead of array index. Hiding Replays therefore keeps Settings selected even though later routes shift one position. If the selected route is removed through an external config change, the router selects the first visible route. All other routes retain their order.

## Failure Handling

If config loading fails, returns invalid JSON, or omits the key, the router keeps Replays visible. This matches the default and avoids hiding a feature because of a damaged preference.

## Testing

Add focused tests that verify:

- the backend default and `config_get_all` response include `hideReplaysTab: false`;
- Settings renders the hide switch and writes `hideReplaysTab` through `setConfig`;
- the router filters the `replays` route when the preference is true;
- the router responds to the key and value in `valoutils:config-changed` without requiring an app restart;
- route selection remains stable when the visible route list changes;
- all three locale files contain the new label and description.

Run the focused tests, TypeScript type checking, and the production Vite build before completion.

## Out of Scope

- Removing replay commands or parser code
- Deleting cached or source replay files
- Hiding other navigation tabs
- Adding a restart requirement
