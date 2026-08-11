import { describe, expect, test } from "bun:test";
import {
	displayTranslationLanguage,
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
		expect(
			getTranslationLanguages("google", "source").some(
				(item) => item.code === "zh-TW",
			),
		).toBe(true);
	});

	test("normalizes legacy casing and falls back invalid values", () => {
		expect(
			normalizeTranslationSelection({
				provider: "google",
				sourceLanguage: "ZH-tw",
				targetLanguage: "KO",
			}),
		).toEqual({
			provider: "google",
			sourceLanguage: "zh-TW",
			targetLanguage: "ko",
		});
		expect(
			normalizeTranslationSelection({
				provider: "deepl",
				sourceLanguage: "not-real",
				targetLanguage: "not-real",
			}),
		).toEqual({
			provider: "deepl",
			sourceLanguage: "auto",
			targetLanguage: "en-US",
		});
	});

	test("maps equivalent languages when providers change", () => {
		expect(
			switchTranslationProvider(
				{
					provider: "google",
					sourceLanguage: "ja",
					targetLanguage: "zh-TW",
				},
				"deepl",
			),
		).toEqual({
			provider: "deepl",
			sourceLanguage: "ja",
			targetLanguage: "zh-HANT",
		});
		expect(
			switchTranslationProvider(
				{
					provider: "google",
					sourceLanguage: "auto",
					targetLanguage: "en",
				},
				"deepl",
			),
		).toEqual({
			provider: "deepl",
			sourceLanguage: "auto",
			targetLanguage: "en-US",
		});
	});

	test("uses a catalog name when Intl cannot format a provider code", () => {
		const language = getTranslationLanguages("deepl", "target").find(
			(item) => item.code === "en-US",
		);
		expect(language).toBeDefined();
		expect(displayTranslationLanguage(language!, "_")).toBe(
			language!.englishName,
		);
	});
});
