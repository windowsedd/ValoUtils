# Chat Translation Source and Target Language Selectors

**Date:** 2026-08-12

## Goal

Replace the translation target-language code input with friendly source and target language dropdowns. Each translation provider exposes its own complete source and target choices, and the selected source language is sent to the provider instead of always relying on automatic detection.

The intended Settings layout is:

```text
From  [Auto Detect v]  ->  To  [Traditional Chinese v]
```

This improves short and mixed-language chat translation by letting the user override unreliable automatic language detection. It does not promise that a provider will correctly interpret slang or supply missing conversational context.

## Current Behavior

- The provider is either Google or DeepL.
- `translatorTargetLanguage` is a free-text code with a default of `en`.
- Google always sends `sl=auto` to the existing Google web translation endpoint.
- DeepL omits `source_lang`, which also enables automatic detection.
- The frontend cannot prevent unsupported or provider-incompatible language codes.

## User Experience

The Translation settings section keeps the existing Google/DeepL provider control and replaces the target code field with one row containing two dropdowns:

- **From** lists `Auto Detect` first, followed by every source language supported by the active provider.
- **To** lists every target language supported by the active provider and never contains `Auto Detect`.
- Options display localized, human-readable language names; provider codes are not the primary label. Names are produced with `Intl.DisplayNames` from the provider's BCP 47 code, with the catalog's English name as a fallback.
- The current selections remain visible when Settings is reopened.
- Switching providers immediately replaces both dropdown lists with that provider's choices.

The DeepL API key field remains visible only as provider configuration; no language discovery request is made from the Settings screen.

## Provider-Aware Language Catalog

Add a checked-in frontend catalog (for example, `src/util/translation-languages.ts`) rather than one unified list. The catalog is a versioned snapshot of stable provider support as of implementation and contains:

- a canonical semantic identifier used only for cross-provider mapping;
- a friendly display-name key;
- the provider-specific code;
- whether the language is usable as a source;
- whether the language is usable as a target.

Google's catalog uses the Neural Machine Translation language table from the official Google Cloud Translation documentation as its maintained baseline. The app still calls the existing unauthenticated Google web endpoint, which has no official language-discovery contract, so catalog updates must include request tests for newly added Google codes.

DeepL's catalog models source and target support separately. This matters for variants: for example, generic `en` is a source language while `en-US` and `en-GB` are target languages. Only stable `translate_text` languages belong in the initial snapshot; beta or early-access entries are excluded unless deliberately enabled later.

The authoritative maintenance references are:

- Google Cloud Translation language support: https://cloud.google.com/translate/docs/languages
- DeepL `GET /v3/languages?resource=translate_text`: https://developers.deepl.com/docs/languages/using-the-languages-api

Runtime discovery is intentionally out of scope. It would require a valid DeepL key, while the existing Google web provider offers no equivalent documented discovery API. Keeping both catalogs local makes Settings deterministic and usable before credentials are configured.

## Configuration and Migration

Add `translatorSourceLanguage` to application configuration.

- Default source: `auto` for both providers.
- Existing `translatorTargetLanguage` values are retained when valid for the selected provider.
- Codes are normalized case-insensitively and through explicit aliases before validation, such as `zh-tw` to Google's `zh-TW`.
- An absent or invalid source migrates to `auto`.
- An absent or invalid target migrates to the provider's English target: Google `en`, DeepL `en-US`.

Configuration stores provider-native codes, not canonical semantic identifiers. This keeps backend requests direct and preserves compatibility with the existing target setting.

When the provider changes, the UI maps the current languages by canonical semantic identifier:

- Equivalent variants are preserved when possible, such as Google `zh-TW` to DeepL `zh-HANT`.
- `auto` remains `auto`.
- If the previous source has no equivalent, source falls back to `auto`.
- If the previous target has no equivalent, target falls back to that provider's English target.

The provider, mapped source, and mapped target are calculated before updating the React state, so the controls never render an invalid intermediate combination. The existing configuration channel may persist the three keys as individual messages; the UI treats the calculated set as one state transition.

## Translation Request Flow

`chat_translate` reads `translatorSourceLanguage` and `translatorTargetLanguage`, then passes both values to `translate_text`.

For Google:

- `auto` sends `sl=auto`.
- An explicit source sends that provider code as `sl`.
- The selected target is sent as `tl`.

For DeepL:

- `auto` omits `source_lang` entirely.
- An explicit source adds `source_lang`.
- The selected target remains `target_lang`.

Successful translation responses include both `sourceLanguage` and `targetLanguage` alongside the translated text and provider so frontend state and developer diagnostics reflect the actual request.

## Validation and Error Handling

Validation exists in both layers:

- The frontend only offers provider-valid options and normalizes persisted legacy values while loading Settings.
- The Rust translation layer validates source and target codes against provider-specific allowlists before making a network request.
- `auto` is accepted only for the source language.
- Invalid source or target codes return a readable translation error and do not contact the provider.
- Provider HTTP and response-parsing failures retain the existing error path.

The backend allowlists and frontend catalog must be derived from the same checked-in data definition or equivalent generated fixtures so they cannot silently drift. The implementation plan will choose the smallest repo-appropriate sharing/generation mechanism after inspecting the build boundary; duplicating handwritten lists is not acceptable.

## Localization and Accessibility

Add localized copy for `From`, `To`, and `Auto Detect` in the existing English, Traditional Chinese, and Korean locale files. Language names use `Intl.DisplayNames` in the active UI locale, avoiding hundreds of duplicated translation keys; the checked-in English catalog name is used when the browser cannot format a code. Native select semantics or the repository's accessible select component must preserve keyboard navigation, focus visibility, and an associated label for each field.

Long language names must not overflow the Settings row. On narrow widths, the two selectors may wrap while retaining the visual source-to-target order.

## Testing

Frontend tests cover:

- provider-specific source and target filtering;
- source `Auto Detect` availability and its absence from targets;
- provider switching with equivalent-language mapping;
- source and target fallback when no mapping exists;
- normalization and migration of existing configuration;
- Settings rendering and configuration messages.

Rust tests cover:

- Google uses the selected source in `sl` and the selected target in `tl`;
- Google auto detection sends `sl=auto`;
- DeepL omits `source_lang` for `auto`;
- DeepL includes an explicit `source_lang` when selected;
- provider-specific source and target validation;
- response metadata contains both selected language values.

Network request tests should exercise request construction through a mock server or extracted pure request builders. Tests must not depend on live Google or DeepL availability.

## Out of Scope

- Replacing the existing Google web endpoint with paid Google Cloud Translation.
- Runtime language discovery or background catalog updates.
- Automatic slang expansion, glossary management, or conversation-context translation.
- Per-message source/target overrides inside the Chat tab.
- DeepL beta or early-access languages.

## Acceptance Criteria

- Users can choose both source and target languages using friendly dropdowns.
- Each provider shows its own complete stable source and target lists.
- Explicit source selection reaches the provider request.
- Existing users migrate without losing a valid target choice.
- Switching providers never leaves an unsupported visible selection.
- Invalid persisted or caller-supplied codes are rejected before a provider request.
- Automated tests verify catalog behavior, migration, request construction, and Settings integration.
