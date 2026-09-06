# ASCII Chat Command Design

**Date:** 2026-09-07

## Goal

Add a built-in `.ascii` command that converts a short phrase into compact block text and sends the result as one VALORANT chat message. The command must preserve channel intent, fit a conservative chat-safe layout, and never split one artwork across multiple messages.

## Command Syntax

The command accepts an optional destination as its first argument:

```text
.ascii <text>
.ascii {team|all|party} <text>
```

Examples:

```text
.ascii hk gay
.ascii team nice try
.ascii all gg
.ascii party hello
```

The first token after `.ascii` is treated as a destination only when it exactly matches `team`, `all`, or `party`, case-insensitively. When a destination is present, every remaining token forms the artwork text. Without a destination, every token after `.ascii` forms the artwork text and the result is sent to the channel in which the command was entered.

Channel names in the first argument are reserved. `.ascii team` therefore means “send to Team” with a missing message and returns the empty-text error; it does not render the word `TEAM`.

## Channel Routing

The parser returns an optional requested channel plus the normalized artwork text. Delivery applies these rules:

- An explicit `team`, `all`, or `party` destination resolves through the existing chat-channel resolver. If that room is unavailable, the existing channel-unavailable error is returned; no fallback channel is substituted.
- A command detected from the local player in VALORANT uses the source message's channel and CID when no destination was supplied. This includes the current pregame team room.
- A command entered in the ValoUtils Chat composer uses the currently selected Party, Team, or All conversation when no destination was supplied. The frontend passes the selected CID with the command, and the backend validates that it is a live group room rather than trusting an arbitrary CID.
- Friend direct-message conversations are not ASCII-art destinations in this version. A destination-free command entered in a direct conversation returns a clear group-channel-required error.

When entered inside VALORANT, the original `.ascii ...` command has already been posted before the poller can observe it. ValoUtils cannot remove that source message. When entered in the ValoUtils composer, the raw command is intercepted and never posted.

## Artwork Format and Length Safety

Use a checked-in, deterministic three-row block font rather than a network service or FIGlet dependency. The font supports:

- Latin letters `A` through `Z`;
- digits `0` through `9`;
- spaces;
- the punctuation `!`, `?`, and `-`.

Input is trimmed, converted to uppercase, and runs of whitespace are collapsed to one space. Any other character returns an unsupported-character error rather than being silently removed or replaced.

Each glyph occupies a fixed compact cell. Glyphs use `█`, `▀`, `▄`, and `░` so three rows remain legible in VALORANT's fixed-width chat rendering. One background column separates adjacent characters, and a wider background gap separates words.

The complete payload is five rows: one blank background row, three glyph rows, and one blank background row. Every row is padded to exactly 26 Unicode characters and rows are joined with newline characters in one message. The resulting payload is always 134 Unicode characters: 130 visible grid characters plus four newlines.

Before padding, the renderer calculates the widest glyph row. If it exceeds 26 characters, rendering fails with a concise text-too-long error. The command never truncates artwork, reduces letter spacing, wraps words into another artwork block, or sends multiple messages.

The 26-column, five-row format is an application-owned conservative limit. It avoids depending on an undocumented Riot maximum and produces deterministic snapshots for tests.

## Command Integration

Add `.ascii` to the reserved built-in command set so a saved custom command cannot shadow it.

The pure command layer owns:

- recognizing `.ascii` without matching prefixes such as `.asciify`;
- parsing the optional first-argument destination;
- normalizing and validating text;
- rendering the fixed-grid payload;
- rejecting empty, unsupported, and oversized input.

The Tauri command and in-game poller own delivery:

- the composer classifier routes `.ascii` to the built-in executor and includes the selected CID as source context;
- the local-player poller classifies `.ascii` alongside `.send` and `.dodge`, retaining the observed source channel and CID;
- delivery reuses the existing REST/XMPP group-chat path and existing sent-message UI event behavior;
- the emitted command result names the channel, for example `Sent ASCII art to Team.`.

The generated payload does not begin with a dot, so it cannot be classified as another command when its echo is observed. Delivery still uses the existing sent-echo bookkeeping for consistent UI reconciliation.

## Errors

Errors are returned through the existing sanitized command paths and contain no Riot credentials or raw response bodies. Required cases are:

- `.ascii` or `.ascii all` with no artwork text: show command usage;
- unsupported character: name the character and list the supported character classes;
- artwork wider than 26 columns: state that the text is too long for one VALORANT artwork message;
- destination-free composer command in a direct conversation: require Party, Team, or All;
- explicit or inferred room unavailable: use the existing channel-unavailable error;
- REST and XMPP delivery failures: preserve the existing sanitized chat error behavior.

No partial artwork is sent after any validation or routing failure.

## User-Facing Documentation

Add the built-in command to the Dummy Bot command reference in English, Korean, and Traditional Chinese. Documentation shows both forms and uses neutral examples:

```text
.ascii {team|all|party} <text>
.ascii gg
```

The description explains that the channel is optional, the current group channel is used by default, and long text is rejected rather than split.

## Testing

Pure Rust tests cover:

- exact, case-insensitive `.ascii` recognition and rejection of longer prefixes;
- parsing with each explicit destination;
- destination-free parsing that retains the entire phrase;
- the reserved first-token behavior for `team`, `all`, and `party`;
- whitespace normalization and lowercase-to-uppercase conversion;
- exact snapshot output for a representative phrase;
- every supported glyph producing three equal-width rows;
- the final payload being five rows of 26 characters and 134 characters total;
- empty, unsupported-character, and over-width errors;
- `.ascii` being unavailable as a custom trigger.

Routing tests cover:

- an in-game destination-free command retaining its observed channel and CID;
- each explicit destination overriding the source channel;
- no substitution when an explicit room is unavailable;
- composer classification and selected-CID forwarding;
- rejection of destination-free direct-conversation use;
- generated-message echo handling.

Frontend tests verify the composer sends the selected CID with `.ascii` and that all three locale files expose the command reference.

Verification includes focused Rust tests, the full frontend test suite, frontend lint and production build, Rust formatting checks, and the relevant Rust library tests. Final runtime verification requires a live smoke test with a signed-in Riot Client because Riot's chat API and XMPP rooms are private runtime services.

## Out of Scope

- Multiple fonts, colors, animation, or user-selectable fill characters.
- Unicode letters, emoji, or arbitrary punctuation.
- Automatic translation of artwork text.
- Multiple-message artwork, truncation, or word wrapping.
- Friend direct-message delivery.
- Removing a raw command already posted from the VALORANT client.
- A gallery or visual artwork editor.

## Acceptance Criteria

- `.ascii <text>` sends one compact artwork message to the current group channel.
- `.ascii team <text>`, `.ascii all <text>`, and `.ascii party <text>` send only to the requested channel.
- Explicit destinations never fall back to another channel.
- The payload is deterministic, five rows high, 26 columns wide, and contained in one message.
- Invalid or oversized input sends nothing and returns a readable error.
- The command works through both the in-game local-message poller and the ValoUtils Chat composer.
- `.ascii` cannot be shadowed by a saved custom command.
- Command help is localized in English, Korean, and Traditional Chinese.
- Automated tests cover parsing, rendering, limits, routing, composer integration, and error behavior.
