# Bot Custom Command Autocomplete and Dynamic Variables

## Summary

Bot custom commands currently save a literal message and expand a trigger into a `.send` or `.tran` command. This feature adds cursor-aware autocomplete to the Send message editor and resolves supported `{{variable}}` placeholders when a saved command runs.

Template expansion must work when the Live Game page has never been opened. It must behave consistently for bot whispers, commands typed in the Chat composer, and custom triggers detected in Riot party, pregame, team, or all chat.

## Goals

- Suggest supported variables while a user edits a Send custom command.
- Insert a selected placeholder at the current caret without damaging surrounding text.
- Resolve only the variables used by the triggered custom command.
- Reuse the existing live-roster, recent-stat, cache, timeout, and concurrency behavior.
- Return useful messages even when Riot hides or fails to return part of the data.
- Keep existing saved custom commands valid without migration.

## Non-goals

- Do not add placeholders to direct `.send` commands. Expansion applies only to saved custom-command messages.
- Do not add variables to the Translate History action because it has no message template.
- Do not continuously poll Riot APIs in the background.
- Do not add arithmetic, conditions, loops, user-defined variables, or nested template expressions.
- Do not change trigger normalization or the persisted `botCustomCommands` shape.

## Placeholder Syntax

A placeholder is an exact, lowercase identifier enclosed by double braces, such as `{{enemy_team_kd}}`. The editor inserts canonical lowercase identifiers. Runtime matching is case-sensitive so the template language stays predictable.

- A supported placeholder with a value is replaced with its formatted value.
- A supported placeholder whose value cannot be obtained is replaced with `N/A`.
- An unsupported or malformed placeholder is preserved verbatim.
- Repeated supported placeholders are resolved once and substituted everywhere.
- Ordinary braces and messages without placeholders are unchanged.

## Initial Variable Catalog

The catalog is a small shared JSON contract imported by the frontend and embedded in the Rust backend. Each entry contains its identifier, group, translation-description key, example, and required data level. This prevents the autocomplete list and runtime allowlist from drifting.

### Team variables

Each suffix is available for both `enemy_team_*` and `ally_team_*`.

| Suffix | Meaning | Example |
| --- | --- | --- |
| `kd` | Ratio of total recent kills to total recent deaths across players with usable stats | `1.24` |
| `kda` | Average recent kills/deaths/assists per player per match | `16.4/13.2/4.8` |
| `acs` | Average combat score | `238` |
| `dpr` | Average damage per round | `151` |
| `win_rate` | Recent win rate | `54%` |
| `rank` | Rounded average current competitive rank | `Platinum 2` |
| `count` | Players currently visible on that side | `5` |
| `names` | Comma-separated visible Riot names | `A#NA, B#EU` |
| `agents` | Comma-separated resolved agent names | `Sage, Jett` |

Team recent-stat metrics average only players whose stats resolved successfully. They become `N/A` if no player on that side has usable data. Hidden players may still contribute to `count` but not to `names`.

### Personal variables

| Variable | Meaning | Example |
| --- | --- | --- |
| `my_name` | Local player's Riot ID | `Player#TAG` |
| `my_agent` | Selected agent | `Sage` |
| `my_rank` | Current competitive rank | `Diamond 1` |
| `my_rr` | Current ranked rating | `62` |
| `my_level` | Account level | `184` |
| `my_kd` | Recent K/D ratio | `1.18` |
| `my_kda` | Recent kills/deaths/assists per match | `17.2/14.6/5.1` |
| `my_acs` | Recent ACS | `226` |
| `my_dpr` | Recent damage per round | `147` |
| `my_win_rate` | Recent win rate | `60%` |

### Match variables

| Variable | Meaning | Example |
| --- | --- | --- |
| `map` | Human-readable map name | `Ascent` |
| `mode` | Human-readable game mode where available | `Competitive` |
| `queue` | Riot queue identifier | `competitive` |
| `phase` | `Party`, `Agent Select`, or `Live Game` | `Agent Select` |
| `roster_count` | Total currently visible players | `10` |

Agent, map, mode, and rank labels use cached content metadata when available. Content lookup is lazy and bounded by a short timeout. Map internal-name fallback and stable rank-name fallback are allowed; otherwise the value is `N/A`.

## Editor Interaction

The Send message input becomes a small autocomplete editor while preserving its current compact layout.

- Typing `{{` opens a menu anchored below the message field.
- Text after the nearest unmatched `{{` filters identifiers and localized descriptions case-insensitively.
- Up and Down move the active option.
- Enter or Tab inserts the active canonical placeholder.
- Escape closes the menu without changing the message.
- Clicking an option inserts it at the caret and restores focus to the field.
- Insertion replaces only the active partial placeholder and preserves text before and after it.
- A Variables button opens the complete list for users who prefer the mouse or do not know the syntax.
- Suggestions are grouped as Enemy team, Ally team, Me, and Match.
- Each row shows the placeholder, a localized description, and a short example.
- The existing saved-command preview continues to display the unexpanded template.
- The menu is not rendered for Translate History commands.

Filtering, active-range detection, and caret insertion live in pure TypeScript helpers. The React component owns focus, keyboard, pointer, and open/close behavior. Keeping those boundaries separate makes cursor behavior testable without a browser automation dependency.

## Runtime Architecture

### Shared catalog and parser

A dedicated Rust template module embeds the shared catalog, extracts supported identifiers, and formats resolved values. It does not perform network calls. Parsing scans the custom message once and returns the unique supported identifiers and their required data levels.

### Live context provider

The live-game backend exposes internal, non-IPC helpers for building a roster snapshot and fetching recent player stats. The template context provider calls these helpers directly with the managed `RiotState`, `LiveCache`, `LiveStatsCache`, and `LivePartyHistoryCache` states.

The provider plans work from the requested identifiers:

- Static template text requires no data work.
- Match, count, name, rank, level, and RR variables require one roster snapshot.
- K/D, KDA, ACS, DPR, and win-rate variables additionally request recent stats only for the relevant players.
- Agent/map/rank display names lazily request content metadata only when an identifier needs them.

Recent-stat requests keep the existing global limit of three concurrent Player Data operations and reuse cached values. The complete template-resolution phase has a six-second budget so it cannot monopolize chat handling or consume the relay's full ten-second translation budget. Successful partial results are retained; unresolved fields become `N/A`.

### Command routing

Custom-command matching remains separate from direct built-in command parsing. A matched custom command carries its saved action and message into an asynchronous resolution step.

For a Send action:

1. Match and normalize the saved trigger.
2. Resolve supported placeholders in the saved message.
3. Construct the expanded `.send {channel} {language} {message}` command.
4. Parse and translate the expanded message with the existing translation path.
5. Post the translated result to the selected Riot room.

For a Translate History action, the existing `.tran` expansion remains unchanged.

The bot-whisper relay, Chat composer command, and in-game own-message poller all call the same asynchronous custom-command resolver. Direct `.send`, `.tran`, `.translate`, and `.dodge` behavior remains unchanged.

## Formatting Rules

- Ratios use two decimal places, with insignificant trailing zeroes removed.
- K/D/A components use one decimal place, with insignificant trailing zeroes removed.
- ACS and DPR are rounded to whole numbers.
- Win rate is rounded to a whole percentage.
- RR, account level, and counts are integers.
- Names and agents are comma-and-space separated in stable roster order.
- Empty lists and values with no usable samples become `N/A`.
- `enemy_team_kda` and `ally_team_kda` are computed as average kills, deaths, and assists per player per selected recent match, not as the current unfinished match scoreboard.

## Error Handling and Compatibility

- A missing Riot login, idle session, hidden enemy roster, unavailable content metadata, rate limit, or timeout does not cancel the custom command; affected known values become `N/A`.
- Translation and posting failures continue to use the current error paths because they occur after template resolution.
- Unknown placeholders remain visible, making typos discoverable and allowing a future app version to add them without rewriting saved messages.
- Existing literal custom commands produce byte-for-byte equivalent expanded messages before translation.
- The stored configuration schema does not change.

## Testing

Development follows red-green-refactor.

Frontend unit tests cover:

- detection of the active unmatched `{{` range;
- case-insensitive filtering by identifier and description;
- insertion at the start, middle, and end of a message;
- replacement of a partial placeholder without touching surrounding text;
- Enter, Tab, Escape, Up, and Down controller behavior;
- group/catalog completeness and localized description keys;
- the Variables button and Send-only rendering contract.

Rust unit tests cover:

- supported, unknown, malformed, and repeated placeholders;
- no-data fast path for literal messages;
- variable-to-data-level planning;
- team assignment relative to the local player;
- K/D, KDA, ACS, DPR, win-rate, rank, count, name, and agent formatting;
- partial player-stat success and all-unavailable fallback;
- six-second resolver timeout behavior using controlled providers;
- preservation of existing literal custom-command expansion;
- Send and Translate History routing.

Routing tests cover all three entry points with fixed context providers so no test calls Riot or public content services. The full frontend tests, Rust library tests, TypeScript build, and lint run before completion.

## Rollout

No migration or feature flag is required. The feature is additive: existing commands remain literal, while messages containing supported placeholders gain dynamic expansion. Analytics behavior remains unchanged because adding or running a custom command already follows existing user-action paths.
