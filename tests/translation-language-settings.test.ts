import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const settings = readFileSync(join(root, "src/pages/Settings.tsx"), "utf8");
const app = readFileSync(join(root, "src-tauri/src/commands/app.rs"), "utf8");
const lib = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");

describe("translation language settings", () => {
	test("persists source language and normalizes loaded config", () => {
		expect(lib).toContain(
			'config_defaults.insert("translatorSourceLanguage".into(), json!("auto"));',
		);
		expect(app).toContain(
			'"translatorSourceLanguage": get_or("translatorSourceLanguage", json!("auto"))',
		);
		expect(settings).toContain("normalizeTranslationSelection");
		expect(settings).toContain('setConfig("translatorSourceLanguage"');
	});

	test("renders labeled provider-aware source and target selects", () => {
		expect(settings).toContain(
			'aria-label={t("settings.translationFrom")}',
		);
		expect(settings).toContain('aria-label={t("settings.translationTo")}');
		expect(settings).toContain('<option value="auto">');
		expect(settings).toMatch(
			/getTranslationLanguages\(\s*appConfig\.translatorProvider,\s*"source",?\s*\)/,
		);
		expect(settings).toMatch(
			/getTranslationLanguages\(\s*appConfig\.translatorProvider,\s*"target",?\s*\)/,
		);
	});

	for (const locale of ["en", "ko", "zh-TW"] as const) {
		test(`${locale} contains translation selector copy`, () => {
			const messages = JSON.parse(
				readFileSync(
					join(root, `src/i18n/locales/${locale}.json`),
					"utf8",
				),
			).settings;
			expect(messages.translationLanguages).toBeString();
			expect(messages.translationLanguagesDesc).toBeString();
			expect(messages.translationFrom).toBeString();
			expect(messages.translationTo).toBeString();
			expect(messages.translationAuto).toBeString();
		});
	}
});
