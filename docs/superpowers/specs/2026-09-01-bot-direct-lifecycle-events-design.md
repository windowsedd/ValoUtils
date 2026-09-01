# Dummy Bot Direct Commands and Lifecycle Events

## Summary

Dummy Bot custom commands currently send only to Riot group rooms: party, pregame, team, or all. This feature adds a Direct target that makes Dummy Bot whisper the signed-in user. It also adds three automatic custom-command events: `onPregame`, `onMatchStart`, and `onMatchEnd`.

The event messages use the existing custom-command message editor, translation settings, and `{{variable}}` templates. They always deliver as Dummy Bot direct messages and never post automatically into a Riot group room.

## Goals

- Add `direct` to the target dropdown for manual custom Send commands.
- Deliver Direct commands as a local Dummy Bot whisper to the signed-in user.
- Add one configurable message for each of `onPregame`, `onMatchStart`, and `onMatchEnd`.
- Fire lifecycle events even when ValoUtils starts during agent select or an active match.
- Support the existing template-variable catalog for all three lifecycle messages.
- Add `{{server}}` to the Match variable group for the current pregame or live-game server pod.
- Preserve all existing saved commands and group-room behavior without migration.

## Non-goals

- Do not add Direct to `.send` syntax or to the group-room `ChatChannel` enum.
- Do not send lifecycle messages to party, pregame, team, or all chat.
- Do not queue lifecycle messages while the Dummy Bot relay is disconnected.
- Do not add `onPregameEnd` or expose user-defined event names.
- Do not allow more than one configured entry for the same lifecycle event.
- Do not expose Riot's full internal `GamePodID` prefix or reduce the value to only the broad shard.
- Do not make edits to an `onMatchEnd` template during an active match affect that match; event configuration is captured when the match starts and applies to the next match after an edit.

## Saved Configuration

`CustomBotCommand` gains one additive field:

```text
when: command | onPregame | onMatchStart | onMatchEnd
```

The persisted shape remains the existing `botCustomCommands` array. Missing or invalid `when` values normalize to `command`, so existing entries keep their current behavior.

### Manual entries

- `when` is `command`.
- `trigger` remains required and follows the existing normalization and reserved-name rules.
- `action` may remain `send` or `tran`.
- A Send entry may store `channel: "direct"` in addition to the four existing group targets.
- Translate History does not offer Direct because it summarizes a selected group-room history rather than sending a message template.

### Lifecycle entries

- `when` is `onPregame`, `onMatchStart`, or `onMatchEnd`.
- `trigger` is stored as an empty string and is never matched as typed chat.
- `action` is always `send`.
- `channel` is always `direct`.
- Language and message use the existing Send behavior.
- The editor rejects a second entry with the same lifecycle value.
- If an externally edited configuration contains duplicates, the first valid entry in array order wins and the rest are ignored.

No separate configuration file or migration is required.

## Editor Behavior

The custom-command form gains a When dropdown with four values:

- Command
- onPregame
- onMatchStart
- onMatchEnd

For Command + Send, the target dropdown contains:

- direct
- party
- pregame
- team
- all

For Command + Translate History, the existing group target and count controls remain unchanged and Direct is not shown.

For a lifecycle entry:

- The trigger and action controls are hidden.
- The target is displayed as Direct and is locked.
- Language, message, and variable autocomplete remain visible.
- Already-configured lifecycle choices are disabled in the When dropdown.
- The saved-command preview labels the event and shows `Dummy Bot DM` rather than rendering a `.send` command.

The editor continues to show unexpanded `{{variable}}` syntax in saved previews.

The Variables popover adds `{{server}}` to the Match group. Its description is `Current match server`, and its example uses the normalized pod suffix `ap-gp-hongkong-1`.

## Direct Delivery Architecture

Direct is a Dummy Bot delivery mode, not a Riot room type. `ChatChannel` therefore remains Party, Pregame, Team, and All.

Custom-command resolution returns a typed result instead of forcing every Send action into `.send {channel} ...` text:

```text
History(expanded .tran command)
Group(expanded .send command)
Direct { language, resolved_message }
```

Group and History results continue through their current parsers and executors. Direct resolution follows this pipeline:

1. Resolve supported template variables in the saved message.
2. Apply the selected translation provider and language; `none` preserves the original text.
3. Return the translated body to the delivery adapter for the entry point that invoked it.

Bot whispers that trigger a Direct command return the body through their existing source-connection reply path. That path records the message once and constructs the Dummy Bot frames as it does for current replies.

Direct commands invoked from the Chat composer, in-game own-message poller, or lifecycle detector use the relay's proactive local-delivery channel. The proactive adapter records the body once in the existing bot transcript, then sends a payload containing the body and a stable message identity. The active relay connection supplies its account domain, bot JID, and current client version when constructing the final frames. The Chat composer receives a local confirmation such as `Dummy Bot sent you a direct message`; the direct content appears only in the Dummy Bot conversation. An in-game trigger produces no extra group-chat line beyond the trigger the player already typed.

Delivery succeeds only when an active relay subscriber accepts the message. It does not attempt to create a real Riot direct conversation for the fake PUUID and does not post a user-authored message through Riot REST.

## Lifecycle Detection

The existing always-running Riot chat poller owns a small pure lifecycle state machine. It derives phase identity from the pregame CID or any resolved team/all core-game CID it already reads, avoiding a second background poller or repeated full live-roster fetches. CID parsing removes the room-side suffix so blue, red, and all rooms for one phase produce one stable match ID.

State contains:

```text
active_pregame_id: optional string
active_match_id: optional string
missing_match_checks: integer
prepared_match_end: optional resolved message
```

### onPregame

- A newly observed `@ares-pregame` match ID fires `onPregame` once.
- The first observation after ValoUtils launches also fires, so launching during agent select is supported.
- Disappearance merely clears the remembered pregame ID; there is no Pregame End event.
- If pregame is dodged, no Match Start or Match End is synthesized.

### onMatchStart

- A newly observed `@ares-coregame` match ID fires `onMatchStart` once.
- The first observation after ValoUtils launches also fires, so launching mid-match is supported.
- When Match Start is detected, the resolver plans the configured Start and End templates together. It uses one live snapshot and shared recent-stat/content work, delivers the Start message, and retains the resolved but untranslated End message.
- Configuration is captured at this point. Changes made during the active match apply to the next match.

### onMatchEnd

- A connected poll tick without the active core-game ID increments `missing_match_checks`.
- Re-observing the same ID resets the counter to zero.
- Three consecutive connected ticks without that ID confirm Match End and deliver the retained End message.
- Failure to connect to the Riot Client does not increment the counter.
- If a different core-game ID appears directly, the old Match End is processed before the new Match Start.
- After either delivery or a skipped delivery, the old match state is cleared so the event cannot repeat.

The event state is in memory. Restarting ValoUtils during a match intentionally produces a new `onMatchStart` when that match is first detected, as approved. Restarting after a match does not invent an `onMatchEnd` because there is no remembered active match.

## Template and Translation Behavior

All three lifecycle messages use the complete existing variable catalog. `onPregame` resolves against its pregame snapshot. Match Start and Match End share the core-game snapshot captured at Match Start, which keeps map, roster, team, agent, and recent-stat values available after the room disappears.

`{{server}}` reads `GamePodID` from Riot's pregame or core-game match payload. The value is normalized to the final dot-separated pod suffix: for example, `aresriot.aws-ape1-prod.ap-gp-hongkong-1` becomes `ap-gp-hongkong-1`. If Riot returns a non-empty value without a dot, that value is preserved. Party/idle state or a missing value renders as `N/A`. Because Match End uses the Match Start snapshot, it retains the same server value after the core-game room disappears.

- Known unavailable values render as `N/A`.
- Unknown placeholders remain verbatim.
- Literal messages use the no-data fast path.
- Template resolution keeps the existing six-second budget and global recent-stat concurrency limit.
- A blank language normalizes to `none` as it does for current custom Send commands.
- Translation happens immediately before Direct delivery. A translation failure prevents delivery and uses existing error reporting.

## Failure Handling

- A manual Direct command with no active Dummy Bot relay returns a clear delivery error.
- A lifecycle event with no active relay is skipped, emits the existing chat error event, and logs a bounded warning. It is not queued or retried later.
- Template data failure does not cancel delivery; affected known values become `N/A`.
- A Riot Client connection failure pauses lifecycle transition counting rather than being interpreted as Match End.
- Duplicate or malformed lifecycle entries are ignored deterministically as described above.
- Existing party, pregame, team, all, and Translate History error paths remain unchanged.

## Compatibility

- Existing commands without `when` normalize to `command`.
- Existing literal custom messages remain byte-for-byte equivalent before translation.
- Existing trigger normalization, reserved triggers, and execution entry points stay in place.
- Direct is handled before `.send` parsing, so the documented direct `.send` non-goal is enforced structurally.
- The stored array remains readable by older versions; older versions ignore the new field but lifecycle entries have empty triggers and therefore cannot execute accidentally.

## Testing

Development follows red-green-refactor.

Frontend tests cover:

- normalization of missing `when` to Command;
- Direct appearing only for manual Send targets;
- lifecycle controls hiding trigger/action and locking Direct;
- one-entry uniqueness for all three lifecycle events;
- saved preview labels and unchanged template autocomplete;
- `{{server}}` appearing in the Match autocomplete group with localized description and example;
- existing manual Send and Translate History editor behavior.

Rust unit tests cover:

- additive deserialization and deterministic duplicate handling;
- typed custom-command results for History, Group, and Direct;
- Direct template resolution and `none` translation behavior;
- proactive relay delivery success and no-subscriber failure;
- exactly-once Pregame, Match Start, and Match End transitions;
- launch during pregame and launch during core game;
- transient missing core-game checks and Riot Client disconnects;
- direct match-ID replacement ordering;
- retained Match End template values;
- pregame and core-game `GamePodID` extraction, normalized server suffix rendering, and missing-server `N/A` fallback;
- skipped event delivery without queueing;
- preservation of every existing command-routing test.

Full frontend tests, lint, TypeScript/Vite build, Rust library tests, and `cargo check` run before completion.

## Rollout

The feature is additive and needs no migration or feature flag. Users can continue using existing manual commands immediately. Direct and lifecycle entries become available through the updated editor, and automatic delivery is active only while the Dummy Bot relay is connected.
