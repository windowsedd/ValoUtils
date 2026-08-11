# Hide Navigation Tabs Design

## Goal

Let users hide any main navigation tab except Settings. Users manage the list from Settings, and the app preserves it across restarts.

## User Experience

Add a `Navigation Tabs` section to Settings. It lists every configured route except `settings`, with one `Hide <tab> tab` switch per route.

- Every switch defaults to off, so existing users keep the current navigation.
- Turning a switch on removes that tab without restarting the app.
- Turning it off restores the tab in its original position.
- `Settings` remains visible and does not receive a hide switch.
- English, Korean, and Traditional Chinese locales provide the section title, row labels, and description.

The setting changes navigation visibility only. It does not disable feature commands, remove page code, or delete user data.

## Configuration

Store hidden route ids in one `hiddenTabs` string array in the existing Tauri `ConfigStore`. For example:

```json
{
  "hiddenTabs": ["replays", "about"]
}
```

- `src-tauri/src/lib.rs` registers an empty array as the default.
- `config_get_all` includes the key with an empty-array fallback.
- `Settings.tsx` adds `hiddenTabs: string[]` to `AppConfig` and initializes it to an empty array.
- The existing `config:set` channel accepts and persists the full array.

The app ignores unknown ids in `hiddenTabs`. This lets older and newer versions share the config without breaking navigation.

## Route Metadata

Settings must render controls for the same routes that the router uses. Expose the provider's configured route list through a small route-context hook instead of maintaining a second hard-coded list. Settings filters out its own `settings` route and renders one row for every remaining route.

Each row uses the route's translated title. The label follows the selected hide semantics, such as `Hide Replays tab`, and the description explains that enabling the switch removes the tab from navigation.

## Navigation Behavior

`RouterProvider` owns the full configured routes and the current `hiddenTabs` value. On mount, it reads `hiddenTabs` from `config:get-all`. `Settings.tsx` includes the changed key and value in the existing `valoutils:config-changed` browser event, so the provider applies changes without another IPC request.

The provider filters hidden route ids before supplying routes to tab rendering and route lookup. It always retains the `settings` route, even if a damaged or manually edited config contains `settings` in `hiddenTabs`.

The router tracks selection by route id instead of array index. Hiding a tab that appears before Settings therefore keeps Settings selected. If an external config change removes the active route, the router selects the first visible route. Restored tabs return to their original order because the provider filters the original route array rather than sorting or mutating it.

## Failure Handling

If config loading fails, returns invalid JSON, or provides a non-array `hiddenTabs` value, the provider uses an empty array and displays every tab. If the array contains non-string values, it ignores those entries. Settings stays available under every input.

## Testing

Add focused tests that verify:

- the backend default and `config_get_all` response include an empty `hiddenTabs` array;
- Settings renders a hide switch for every configured route except Settings;
- changing a switch writes the updated array through `config:set`;
- the provider filters every requested route except `settings`;
- the provider applies `valoutils:config-changed` updates without restarting;
- selection stays on the same route id when visible routes change;
- removing the selected route falls back to the first visible route;
- all three locale files contain the section title, label template, and description.

Run the focused tests, TypeScript type checking, and the production Vite build before completion.

## Out of Scope

- Hiding the Settings tab
- Reordering tabs
- Disabling backend commands for hidden pages
- Deleting data owned by hidden pages
- Adding a global show-all or hide-all action
