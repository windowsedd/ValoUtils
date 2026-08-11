# Chat Translation Language Selectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select provider-valid source and target languages for Chat translation, persist those selections, and send them to Google or DeepL.

**Architecture:** Store one checked-in provider-aware JSON catalog that both TypeScript and Rust consume. A focused TypeScript utility owns filtering, normalization, localization, and provider-switch mapping; Settings renders native selects from that utility. Rust validates the same catalog before constructing provider requests, so persisted or caller-supplied invalid codes never reach the network.

**Tech Stack:** React 19, TypeScript 6, Bun test, Tauri 2, Rust 2021, serde/serde_json, reqwest.

## Global Constraints

- Work directly on the current `master` checkout; do not create a worktree.
- Preserve all unrelated dirty files and stage only task-specific paths or hunks.
- The catalog is a checked-in stable snapshot; Settings does not perform runtime language discovery.
- Google continues to use `https://translate.googleapis.com/translate_a/single`; replacing it with paid Cloud Translation is out of scope.
- DeepL `auto` is represented by omitting `source_lang`; Google `auto` is represented by `sl=auto`.
- `Auto Detect` is source-only.
- Defaults are Google `auto -> en` and DeepL `auto -> en-US`.
- Language labels use `Intl.DisplayNames` in the active UI locale with the catalog English name as fallback.
- DeepL beta and early-access languages are excluded.
- No live Google or DeepL service is required by automated tests.

---

## File Structure

- Create `src/data/translation-languages.json`: single provider-aware catalog consumed by both runtimes.
- Create `src/util/translation-languages.ts`: TypeScript catalog types and pure normalization/mapping/label helpers.
- Create `src/util/translation-languages.test.ts`: pure frontend domain tests.
- Modify `src/pages/Settings.tsx`: configuration migration, provider switching, and accessible source/target selects.
- Create `tests/translation-language-settings.test.ts`: Settings/config/localization integration checks.
- Modify `src/i18n/locales/en.json`, `src/i18n/locales/ko.json`, `src/i18n/locales/zh-TW.json`: selector copy only; preserve existing unrelated locale edits.
- Modify `src-tauri/src/lib.rs` and `src-tauri/src/commands/app.rs`: source-language default and config allowlist.
- Modify `src-tauri/src/translate.rs`: shared-catalog validation and provider request construction.
- Modify `src-tauri/src/commands/chat.rs`: read source config and return source/target response metadata.
- Modify `src/types/chat.ts`: successful translation response type includes `sourceLanguage`.
- Create `tests/translation-language-ipc.test.ts`: frontend/Rust boundary contract checks.

---

### Task 1: Shared Provider Language Catalog and TypeScript Domain Logic

**Files:**
- Create: `src/data/translation-languages.json`
- Create: `src/util/translation-languages.ts`
- Create: `src/util/translation-languages.test.ts`

**Interfaces:**
- Consumes: official Google NMT table and DeepL stable translation table as of 2026-08-12.
- Produces: `TranslationProvider`, `TranslationLanguageRole`, `TranslationLanguage`, `TranslationSelection`, `getTranslationLanguages()`, `displayTranslationLanguage()`, `normalizeTranslationCode()`, `normalizeTranslationSelection()`, and `switchTranslationProvider()`.

- [ ] **Step 1: Write the failing catalog and mapping tests**

Create `src/util/translation-languages.test.ts` with focused invariants and user-visible mapping cases:

```ts
import { describe, expect, test } from "bun:test";
import {
	getTranslationLanguages,
	normalizeTranslationSelection,
	switchTranslationProvider,
} from "./translation-languages";

describe("translation language catalog", () => {
	test("filters source and target roles per provider", () => {
		const deeplSources = getTranslationLanguages("deepl", "source");
		const deeplTargets = getTranslationLanguages("deepl", "target");
		expect(deeplSources.some((item) => item.code === "en")).toBe(true);
		expect(deeplSources.some((item) => item.code === "en-US")).toBe(false);
		expect(deeplTargets.some((item) => item.code === "en-US")).toBe(true);
		expect(deeplTargets.some((item) => item.code === "en")).toBe(false);
		expect(getTranslationLanguages("google", "source").some((item) => item.code === "zh-TW")).toBe(true);
	});

	test("normalizes legacy casing and falls back invalid values", () => {
		expect(normalizeTranslationSelection({
			provider: "google",
			sourceLanguage: "ZH-tw",
			targetLanguage: "KO",
		})).toEqual({
			provider: "google",
			sourceLanguage: "zh-TW",
			targetLanguage: "ko",
		});
		expect(normalizeTranslationSelection({
			provider: "deepl",
			sourceLanguage: "not-real",
			targetLanguage: "not-real",
		})).toEqual({
			provider: "deepl",
			sourceLanguage: "auto",
			targetLanguage: "en-US",
		});
	});

	test("maps equivalent languages when providers change", () => {
		expect(switchTranslationProvider({
			provider: "google",
			sourceLanguage: "ja",
			targetLanguage: "zh-TW",
		}, "deepl")).toEqual({
			provider: "deepl",
			sourceLanguage: "ja",
			targetLanguage: "zh-HANT",
		});
		expect(switchTranslationProvider({
			provider: "google",
			sourceLanguage: "auto",
			targetLanguage: "en",
		}, "deepl")).toEqual({
			provider: "deepl",
			sourceLanguage: "auto",
			targetLanguage: "en-US",
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/util/translation-languages.test.ts`

Expected: FAIL because `src/util/translation-languages.ts` does not exist.

- [ ] **Step 3: Add the complete shared catalog**

Create `src/data/translation-languages.json` as a JSON array. Every entry has this exact shape:

```json
[
  {
    "provider": "google",
    "canonicalId": "zh-Hant",
    "code": "zh-TW",
    "englishName": "Chinese (Traditional)",
    "source": true,
    "target": true
  },
  {
    "provider": "deepl",
    "canonicalId": "zh-Hant",
    "code": "zh-HANT",
    "englishName": "Chinese (Traditional)",
    "source": false,
    "target": true
  }
]
```

The committed array must contain every row in Google's official **Neural Machine Translation model** table and every non-beta row with `translation: true` in DeepL's official supported-languages table. Apply these deterministic transformations:

1. Google rows are both source and target.
2. DeepL rows with `isVariant: true` are target-only; non-variant rows are source and target, except documented role differences take precedence. In particular, generic `en`, `pt`, and `zh` are source-only where regional/script target variants replace them (`en-US`/`en-GB`, `pt-BR`/`pt-PT`, and `zh-HANS`/`zh-HANT`).
3. Store codes in provider request casing: Google as documented; DeepL normalized to BCP 47 casing (`en-US`, `zh-HANT`, not all uppercase).
4. Use the base lowercase code as `canonicalId`, except script-sensitive Chinese uses `zh-Hans` and `zh-Hant`.
5. Assign all English variants canonical ID `en`, all Portuguese variants `pt`, and all French variants `fr`; catalog order determines preferred targets (`en-US` before `en-GB`, provider-generic target before regional targets elsewhere).
6. Normalize known equivalents: Google `no` and DeepL `nb` use `canonicalId: "nb"`; Google `fil`/`tl` and DeepL `tl` use `canonicalId: "tl"`; Google `jv`/`jw` and DeepL `jv` use `canonicalId: "jv"`; Google `ku` and DeepL `kmr` use `canonicalId: "kmr"`.

After populating, verify the JSON parses and contains no duplicate `(provider, code)` pairs:

```powershell
bun -e "const c=await Bun.file('src/data/translation-languages.json').json(); const k=c.map(x=>x.provider+':'+x.code.toLowerCase()); if(new Set(k).size!==k.length) throw new Error('duplicate provider code'); console.log(c.length)"
```

Expected: prints a positive catalog count and exits 0.

- [ ] **Step 4: Implement pure TypeScript catalog behavior**

Create `src/util/translation-languages.ts`:

```ts
import catalogJson from "@/data/translation-languages.json";

export type TranslationProvider = "google" | "deepl";
export type TranslationLanguageRole = "source" | "target";

export type TranslationLanguage = {
	provider: TranslationProvider;
	canonicalId: string;
	code: string;
	englishName: string;
	source: boolean;
	target: boolean;
};

export type TranslationSelection = {
	provider: TranslationProvider;
	sourceLanguage: string;
	targetLanguage: string;
};

const catalog = catalogJson as TranslationLanguage[];
const defaults = {
	google: { sourceLanguage: "auto", targetLanguage: "en" },
	deepl: { sourceLanguage: "auto", targetLanguage: "en-US" },
} satisfies Record<TranslationProvider, Omit<TranslationSelection, "provider">>;

export const getTranslationLanguages = (
	provider: TranslationProvider,
	role: TranslationLanguageRole,
) => catalog.filter((item) => item.provider === provider && item[role]);

export const normalizeTranslationCode = (
	provider: TranslationProvider,
	role: TranslationLanguageRole,
	value: unknown,
): string | null => {
	if (role === "source" && typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return getTranslationLanguages(provider, role)
		.find((item) => item.code.toLowerCase() === normalized)?.code ?? null;
};

export const normalizeTranslationSelection = (
	value: Partial<TranslationSelection>,
): TranslationSelection => {
	const provider: TranslationProvider = value.provider === "deepl" ? "deepl" : "google";
	return {
		provider,
		sourceLanguage: normalizeTranslationCode(provider, "source", value.sourceLanguage)
			?? defaults[provider].sourceLanguage,
		targetLanguage: normalizeTranslationCode(provider, "target", value.targetLanguage)
			?? defaults[provider].targetLanguage,
	};
};

const canonicalFor = (provider: TranslationProvider, role: TranslationLanguageRole, code: string) =>
	getTranslationLanguages(provider, role).find((item) => item.code === code)?.canonicalId;

export const switchTranslationProvider = (
	selection: TranslationSelection,
	provider: TranslationProvider,
): TranslationSelection => {
	const current = normalizeTranslationSelection(selection);
	const sourceCanonical = current.sourceLanguage === "auto"
		? null
		: canonicalFor(current.provider, "source", current.sourceLanguage);
	const targetCanonical = canonicalFor(current.provider, "target", current.targetLanguage);
	const sourceLanguage = sourceCanonical
		? getTranslationLanguages(provider, "source").find((item) => item.canonicalId === sourceCanonical)?.code
		: "auto";
	const targetLanguage = targetCanonical
		? getTranslationLanguages(provider, "target").find((item) => item.canonicalId === targetCanonical)?.code
		: null;
	return normalizeTranslationSelection({ provider, sourceLanguage, targetLanguage });
};

export const displayTranslationLanguage = (language: TranslationLanguage, locale: string) => {
	try {
		return new Intl.DisplayNames([locale], { type: "language" }).of(language.code)
			?? language.englishName;
	} catch {
		return language.englishName;
	}
};
```

- [ ] **Step 5: Run the domain tests and type-check**

Run: `bun test src/util/translation-languages.test.ts`

Expected: all tests PASS.

Run: `bun run build:vite`

Expected: TypeScript and Vite production build exit 0; existing chunk-size or native-module warnings are acceptable.

- [ ] **Step 6: Commit the catalog domain layer**

```powershell
git add -- src/data/translation-languages.json src/util/translation-languages.ts src/util/translation-languages.test.ts
git commit -m "feat: add translation language catalog"
```

---

### Task 2: Settings Migration and Accessible Source/Target Selectors

**Files:**
- Modify: `src/pages/Settings.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/app.rs`
- Create: `tests/translation-language-settings.test.ts`

**Interfaces:**
- Consumes: `TranslationProvider`, `normalizeTranslationSelection()`, `switchTranslationProvider()`, `getTranslationLanguages()`, and `displayTranslationLanguage()` from Task 1.
- Produces: persisted keys `translatorProvider`, `translatorSourceLanguage`, and `translatorTargetLanguage`; Settings controls with `aria-label` values from `settings.translationFrom` and `settings.translationTo`.

- [ ] **Step 1: Write failing Settings/config integration tests**

Create `tests/translation-language-settings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const settings = readFileSync(join(root, "src/pages/Settings.tsx"), "utf8");
const app = readFileSync(join(root, "src-tauri/src/commands/app.rs"), "utf8");
const lib = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");

describe("translation language settings", () => {
	test("persists source language and normalizes loaded config", () => {
		expect(lib).toContain('config_defaults.insert("translatorSourceLanguage".into(), json!("auto"));');
		expect(app).toContain('"translatorSourceLanguage": get_or("translatorSourceLanguage", json!("auto"))');
		expect(settings).toContain("normalizeTranslationSelection");
		expect(settings).toContain('setConfig("translatorSourceLanguage"');
	});

	test("renders labeled provider-aware source and target selects", () => {
		expect(settings).toContain('aria-label={t("settings.translationFrom")}');
		expect(settings).toContain('aria-label={t("settings.translationTo")}');
		expect(settings).toContain('value="auto"');
		expect(settings).toContain("getTranslationLanguages(appConfig.translatorProvider, \"source\")");
		expect(settings).toContain("getTranslationLanguages(appConfig.translatorProvider, \"target\")");
	});

	for (const locale of ["en", "ko", "zh-TW"] as const) {
		test(`${locale} contains translation selector copy`, () => {
			const messages = JSON.parse(readFileSync(
				join(root, `src/i18n/locales/${locale}.json`), "utf8",
			)).settings;
			expect(messages.translationLanguages).toBeString();
			expect(messages.translationLanguagesDesc).toBeString();
			expect(messages.translationFrom).toBeString();
			expect(messages.translationTo).toBeString();
			expect(messages.translationAuto).toBeString();
		});
	}
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `bun test tests/translation-language-settings.test.ts`

Expected: FAIL because the source default, localized keys, and selects are absent.

- [ ] **Step 3: Add the backend configuration default and allowlist entry**

In `src-tauri/src/lib.rs`, insert beside the existing translator defaults:

```rust
config_defaults.insert("translatorProvider".into(), json!("google"));
config_defaults.insert("translatorSourceLanguage".into(), json!("auto"));
config_defaults.insert("translatorTargetLanguage".into(), json!("en"));
```

In `src-tauri/src/commands/app.rs`, expose the same default:

```rust
"translatorProvider": get_or("translatorProvider", json!("google")),
"translatorSourceLanguage": get_or("translatorSourceLanguage", json!("auto")),
"translatorTargetLanguage": get_or("translatorTargetLanguage", json!("en")),
```

- [ ] **Step 4: Normalize loaded Settings state and provider changes**

Import Task 1 helpers and add `translatorSourceLanguage: string` to `AppConfig`, defaulting it to `auto`. Replace the translation portion of `onConfigLoaded` with a normalized selection:

```ts
const translation = normalizeTranslationSelection({
	provider: config.translatorProvider,
	sourceLanguage: config.translatorSourceLanguage,
	targetLanguage: config.translatorTargetLanguage,
});
setAppConfig((current) => ({
	...current,
	...config,
	translatorProvider: translation.provider,
	translatorSourceLanguage: translation.sourceLanguage,
	translatorTargetLanguage: translation.targetLanguage,
	hiddenTabs: normalizeHiddenTabs(config.hiddenTabs),
}));

for (const [key, value] of Object.entries({
	translatorProvider: translation.provider,
	translatorSourceLanguage: translation.sourceLanguage,
	translatorTargetLanguage: translation.targetLanguage,
})) {
	if (config[key as keyof AppConfig] !== value) {
		window.Main.send("config:set", key, value);
	}
}
```

This comparison is the migration write-back: invalid legacy values are not merely hidden in React state; their normalized replacements are persisted for Chat and the next launch.

Add a grouped update helper so React applies provider/source/target together while IPC persists each key:

```ts
const setConfigs = (values: Partial<AppConfig>) => {
	for (const [key, value] of Object.entries(values)) {
		window.Main.send("config:set", key, value);
		window.dispatchEvent(new CustomEvent("valoutils:config-changed", {
			detail: { key, value },
		}));
	}
	setAppConfig((previous) => ({ ...previous, ...values }));
};

const changeTranslatorProvider = (provider: TranslationProvider) => {
	const next = switchTranslationProvider({
		provider: appConfig.translatorProvider,
		sourceLanguage: appConfig.translatorSourceLanguage,
		targetLanguage: appConfig.translatorTargetLanguage,
	}, provider);
	setConfigs({
		translatorProvider: next.provider,
		translatorSourceLanguage: next.sourceLanguage,
		translatorTargetLanguage: next.targetLanguage,
	});
};
```

Use `changeTranslatorProvider(provider)` from the provider buttons.

- [ ] **Step 5: Replace the code input with accessible source and target selects**

Replace the current target-language `SettingRow` right side with responsive native selects:

```tsx
<SettingRow
	icon={<FaGlobe />}
	label={t("settings.translationLanguages")}
	description={t("settings.translationLanguagesDesc")}
	right={
		<div className="flex flex-wrap items-center justify-end gap-2 max-w-[32rem]">
			<select
				aria-label={t("settings.translationFrom")}
				value={appConfig.translatorSourceLanguage}
				onChange={(event) => setConfig("translatorSourceLanguage", event.target.value)}
				className="max-w-48 px-2 py-1 rounded border border-white/10 bg-[#0b0e13] text-sm text-white outline-none focus:border-[#22d3ee]/50"
			>
				<option value="auto">{t("settings.translationAuto")}</option>
				{getTranslationLanguages(appConfig.translatorProvider, "source").map((language) => (
					<option key={language.code} value={language.code}>
						{displayTranslationLanguage(language, i18n.language)}
					</option>
				))}
			</select>
			<span aria-hidden="true" className="text-gray-500">→</span>
			<select
				aria-label={t("settings.translationTo")}
				value={appConfig.translatorTargetLanguage}
				onChange={(event) => setConfig("translatorTargetLanguage", event.target.value)}
				className="max-w-48 px-2 py-1 rounded border border-white/10 bg-[#0b0e13] text-sm text-white outline-none focus:border-[#22d3ee]/50"
			>
				{getTranslationLanguages(appConfig.translatorProvider, "target").map((language) => (
					<option key={language.code} value={language.code}>
						{displayTranslationLanguage(language, i18n.language)}
					</option>
				))}
			</select>
		</div>
	}
/>
```

- [ ] **Step 6: Add localized selector copy without overwriting unrelated locale edits**

Add these exact keys under `settings` in each locale, staging only these hunks because all three files already contain unrelated user changes:

```json
// en.json
"translationLanguages": "Translation languages",
"translationLanguagesDesc": "Choose the detected or known source language and the translated output language",
"translationFrom": "From language",
"translationTo": "To language",
"translationAuto": "Auto Detect"
```

```json
// zh-TW.json
"translationLanguages": "翻譯語言",
"translationLanguagesDesc": "選擇自動偵測或指定來源語言，以及翻譯後的目標語言",
"translationFrom": "來源語言",
"translationTo": "目標語言",
"translationAuto": "自動偵測"
```

```json
// ko.json
"translationLanguages": "번역 언어",
"translationLanguagesDesc": "자동 감지 또는 원문 언어와 번역할 대상 언어를 선택합니다",
"translationFrom": "원문 언어",
"translationTo": "대상 언어",
"translationAuto": "자동 감지"
```

- [ ] **Step 7: Run Settings tests and frontend build**

Run: `bun test src/util/translation-languages.test.ts tests/translation-language-settings.test.ts`

Expected: all tests PASS.

Run: `bun run build:vite`

Expected: exit 0; existing build warnings are acceptable.

- [ ] **Step 8: Commit only the Settings/config changes**

Use a temporary cached patch or interactive staging equivalent for the three dirty locale files so unrelated `coach` copy is not included. Then stage the clean task files:

```powershell
git add -- src/pages/Settings.tsx src-tauri/src/lib.rs src-tauri/src/commands/app.rs tests/translation-language-settings.test.ts
git diff --cached -- src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json
git commit -m "feat: add translation language selectors"
```

Expected: the cached locale diff contains only the five translation keys per locale.

---

### Task 3: Provider Validation and Source-Aware Request Construction

**Files:**
- Modify: `src-tauri/src/translate.rs`

**Interfaces:**
- Consumes: `src/data/translation-languages.json` from Task 1 via `include_str!("../../src/data/translation-languages.json")`.
- Produces: `translate_text(text, provider, source_language, target_language, deepl_api_key) -> Result<TranslationResult, String>` plus pure `normalize_language()`, `google_query()`, and `deepl_form()` helpers.

- [ ] **Step 1: Write failing Rust tests for validation and request fields**

Append a test module to `src-tauri/src/translate.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_roles_from_shared_catalog() {
        assert_eq!(normalize_language("google", "source", "ZH-tw").unwrap(), "zh-TW");
        assert_eq!(normalize_language("google", "source", "auto").unwrap(), "auto");
        assert!(normalize_language("deepl", "source", "en-US").is_err());
        assert_eq!(normalize_language("deepl", "target", "EN-us").unwrap(), "en-US");
        assert!(normalize_language("google", "target", "auto").is_err());
        assert!(normalize_language("google", "target", "not-real").is_err());
        assert!(normalize_language("unknown", "target", "en").is_err());
    }

    #[test]
    fn google_query_contains_explicit_or_auto_source() {
        let explicit = google_query("hello", "en", "zh-TW");
        assert!(explicit.contains(&("sl", "en".to_string())));
        assert!(explicit.contains(&("tl", "zh-TW".to_string())));
        let automatic = google_query("hello", "auto", "zh-TW");
        assert!(automatic.contains(&("sl", "auto".to_string())));
    }

    #[test]
    fn deepl_form_omits_auto_and_includes_explicit_source() {
        let automatic = deepl_form("hello", "auto", "en-US");
        assert!(!automatic.iter().any(|(key, _)| *key == "source_lang"));
        assert!(automatic.contains(&("target_lang", "en-US".to_string())));
        let explicit = deepl_form("hello", "ja", "en-US");
        assert!(explicit.contains(&("source_lang", "ja".to_string())));
    }
}
```

- [ ] **Step 2: Run the Rust tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml translate::tests --lib`

Expected: compilation FAIL because the validation and request helper functions are absent.

- [ ] **Step 3: Parse and validate the shared catalog once**

Add these internal types and helpers to `src-tauri/src/translate.rs`:

```rust
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
struct LanguageEntry {
    provider: String,
    code: String,
    source: bool,
    target: bool,
}

fn language_catalog() -> &'static Vec<LanguageEntry> {
    static CATALOG: OnceLock<Vec<LanguageEntry>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/data/translation-languages.json"))
            .expect("translation language catalog must be valid JSON")
    })
}

fn normalize_language(provider: &str, role: &str, code: &str) -> Result<String, String> {
    if role == "source" && code == "auto" {
        return Ok("auto".into());
    }
    language_catalog().iter().find(|entry| {
        entry.provider == provider
            && entry.code.eq_ignore_ascii_case(code)
            && match role {
                "source" => entry.source,
                "target" => entry.target,
                _ => false,
            }
    })
    .map(|entry| entry.code.clone())
    .ok_or_else(|| format!("Unsupported {role} language '{code}' for {provider}."))
}
```

Do not include unused JSON fields in `LanguageEntry`; serde ignores them.

- [ ] **Step 4: Extract pure provider parameter builders**

Add:

```rust
fn google_query(text: &str, source: &str, target: &str) -> Vec<(&'static str, String)> {
    vec![
        ("client", "gtx".into()),
        ("sl", source.into()),
        ("tl", target.into()),
        ("dt", "t".into()),
        ("q", text.into()),
    ]
}

fn deepl_form(text: &str, source: &str, target: &str) -> Vec<(&'static str, String)> {
    let mut form = vec![
        ("text", text.into()),
        ("target_lang", target.into()),
    ];
    if source != "auto" {
        form.push(("source_lang", source.into()));
    }
    form
}
```

Add the normalized result type and change the public function signature:

```rust
pub struct TranslationResult {
    pub text: String,
    pub source_language: String,
    pub target_language: String,
}

pub async fn translate_text(
    text: &str,
    provider: &str,
    source_language: &str,
    target_language: &str,
    deepl_api_key: &str,
) -> Result<TranslationResult, String> {
    let source = if source_language.trim().is_empty() { "auto" } else { source_language.trim() };
    let target = if target_language.trim().is_empty() {
        if provider == "deepl" { "en-US" } else { "en" }
    } else {
        target_language.trim()
    };
    if provider != "google" && provider != "deepl" {
        return Err(format!("Unsupported translation provider '{provider}'."));
    }
    let source = normalize_language(provider, "source", source)?;
    let target = normalize_language(provider, "target", target)?;
    if text.trim().is_empty() {
        return Ok(TranslationResult {
            text: String::new(),
            source_language: source,
            target_language: target,
        });
    }
    // Keep the existing provider response parsing below this guard.
```

Use `.form(&deepl_form(text, &source, &target))` for DeepL and `.query(&google_query(text, &source, &target))` for Google. Remove `target.to_uppercase()` so the checked-in provider-native BCP 47 code is transmitted exactly. After the existing provider-specific response parser yields `translated_text`, return:

```rust
Ok(TranslationResult {
    text: translated_text,
    source_language: source,
    target_language: target,
})
```

- [ ] **Step 5: Run focused Rust tests and formatting**

Run: `cargo test --manifest-path src-tauri/Cargo.toml translate::tests --lib`

Expected: all translation tests PASS.

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: exit 0. If formatting is required, run `cargo fmt --manifest-path src-tauri/Cargo.toml`, then repeat the check and verify only task Rust files changed.

- [ ] **Step 6: Commit the backend translation layer**

```powershell
git add -- src-tauri/src/translate.rs
git commit -m "feat: validate translation language requests"
```

---

### Task 4: Chat IPC Metadata and End-to-End Verification

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src/types/chat.ts`
- Create: `tests/translation-language-ipc.test.ts`

**Interfaces:**
- Consumes: the five-argument `translate_text()` from Task 3 and persisted translation keys from Task 2.
- Produces: successful `TranslateResponse` with `sourceLanguage` and `targetLanguage`.

- [ ] **Step 1: Write the failing IPC contract test**

Create `tests/translation-language-ipc.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const command = readFileSync(join(root, "src-tauri/src/commands/chat.rs"), "utf8");
const types = readFileSync(join(root, "src/types/chat.ts"), "utf8");

describe("translation IPC language contract", () => {
	test("reads source config and passes source plus target to translation", () => {
		expect(command).toContain('.get("translatorSourceLanguage")');
		expect(command).toContain("&source_language,\n            &target_language,");
	});

	test("returns and types both selected languages", () => {
		expect(command).toContain('"sourceLanguage": result.source_language');
		expect(command).toContain('"targetLanguage": result.target_language');
		expect(types).toContain("sourceLanguage: string; targetLanguage: string");
	});
});
```

- [ ] **Step 2: Run the IPC test to verify it fails**

Run: `bun test tests/translation-language-ipc.test.ts`

Expected: FAIL because `chat_translate` does not read or return a source language.

- [ ] **Step 3: Thread source language through `chat_translate`**

In `src-tauri/src/commands/chat.rs`, read the new key with fallback:

```rust
let source_language = config
    .get("translatorSourceLanguage")
    .and_then(|v| v.as_str().map(|s| s.to_string()))
    .unwrap_or_else(|| "auto".into());
```

Call the new signature:

```rust
Ok(match translate::translate_text(
    &text,
    &provider,
    &source_language,
    &target_language,
    &deepl_key,
).await {
    Ok(result) => json!({
        "success": true,
        "translatedText": result.text,
        "provider": provider,
        "sourceLanguage": result.source_language,
        "targetLanguage": result.target_language,
    }).to_string(),
    Err(e) => json!({ "success": false, "error": e }).to_string(),
})
```

- [ ] **Step 4: Extend the frontend response type**

Change the success branch in `src/types/chat.ts` to:

```ts
export type TranslateResponse =
	| {
			success: true;
			translatedText: string;
			provider: TranslatorProvider;
			sourceLanguage: string;
			targetLanguage: string;
	  }
	| { success: false; error: string };
```

No Chat controller behavior changes are needed because it only consumes `translatedText`.

- [ ] **Step 5: Run focused frontend and Rust validation**

Run: `bun test src/util/translation-languages.test.ts tests/translation-language-settings.test.ts tests/translation-language-ipc.test.ts src/pages/chat/use-chat-controller.test.ts`

Expected: all focused tests PASS.

Run: `cargo test --manifest-path src-tauri/Cargo.toml translate::tests --lib`

Expected: all translation tests PASS.

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::chat::tests --lib`

Expected: all Chat command tests PASS.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: exit 0.

- [ ] **Step 6: Run full frontend verification**

Run: `bun test`

Expected: all Bun tests PASS, including all new translation tests.

Run: `bun run build:vite`

Expected: exit 0; existing native configuration and chunk-size warnings are acceptable.

Do not use the full Rust library suite as the sole completion gate: this repository currently has unrelated replay-fixture failures. If it is run, report those known failures separately; the required gates are the focused translation/Chat tests plus `cargo check`.

- [ ] **Step 7: Perform a live Settings/Chat smoke test when Riot Client is available**

1. Start Riot Client and ValoUtils.
2. Open Settings → Chat Translation.
3. Confirm Google shows `Auto Detect` under From but not under To.
4. Select `English → Traditional Chinese`, return to Chat, translate an English message, and confirm a translated message appears.
5. Change From to an intentionally correct explicit language for a short message and confirm the request succeeds.
6. If a DeepL key is configured, switch to DeepL and confirm the mapped selections remain valid; otherwise verify the existing readable missing-key error remains.
7. Restart ValoUtils and confirm provider/source/target selections persist.

Expected: controls update immediately, explicit source selection is honored, and no unsupported selection remains visible after provider switching.

- [ ] **Step 8: Commit the IPC integration**

```powershell
git add -- src-tauri/src/commands/chat.rs src/types/chat.ts tests/translation-language-ipc.test.ts
git commit -m "feat: send selected translation languages"
```

Before committing, run `git diff --cached --check` and `git diff --cached --stat`; confirm no unrelated dirty path is staged.
