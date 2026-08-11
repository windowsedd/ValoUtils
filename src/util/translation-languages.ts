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
} satisfies Record<
	TranslationProvider,
	Omit<TranslationSelection, "provider">
>;

export const getTranslationLanguages = (
	provider: TranslationProvider,
	role: TranslationLanguageRole,
) => catalog.filter((item) => item.provider === provider && item[role]);

export const normalizeTranslationCode = (
	provider: TranslationProvider,
	role: TranslationLanguageRole,
	value: unknown,
): string | null => {
	if (
		role === "source" &&
		typeof value === "string" &&
		value.trim().toLowerCase() === "auto"
	) {
		return "auto";
	}
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return (
		getTranslationLanguages(provider, role).find(
			(item) => item.code.toLowerCase() === normalized,
		)?.code ?? null
	);
};

export const normalizeTranslationSelection = (
	value: Partial<TranslationSelection>,
): TranslationSelection => {
	const provider: TranslationProvider =
		value.provider === "deepl" ? "deepl" : "google";
	return {
		provider,
		sourceLanguage:
			normalizeTranslationCode(provider, "source", value.sourceLanguage) ??
			defaults[provider].sourceLanguage,
		targetLanguage:
			normalizeTranslationCode(provider, "target", value.targetLanguage) ??
			defaults[provider].targetLanguage,
	};
};

const canonicalFor = (
	provider: TranslationProvider,
	role: TranslationLanguageRole,
	code: string,
) =>
	getTranslationLanguages(provider, role).find((item) => item.code === code)
		?.canonicalId;

export const switchTranslationProvider = (
	selection: TranslationSelection,
	provider: TranslationProvider,
): TranslationSelection => {
	const current = normalizeTranslationSelection(selection);
	const sourceCanonical =
		current.sourceLanguage === "auto"
			? null
			: canonicalFor(
					current.provider,
					"source",
					current.sourceLanguage,
				);
	const targetCanonical = canonicalFor(
		current.provider,
		"target",
		current.targetLanguage,
	);
	const sourceLanguage = sourceCanonical
		? getTranslationLanguages(provider, "source").find(
				(item) => item.canonicalId === sourceCanonical,
			)?.code
		: "auto";
	const targetLanguage = targetCanonical
		? getTranslationLanguages(provider, "target").find(
				(item) => item.canonicalId === targetCanonical,
			)?.code
		: undefined;
	return normalizeTranslationSelection({
		provider,
		sourceLanguage,
		targetLanguage,
	});
};

export const displayTranslationLanguage = (
	language: TranslationLanguage,
	locale: string,
) => {
	try {
		return (
			new Intl.DisplayNames([locale], { type: "language" }).of(language.code) ??
			language.englishName
		);
	} catch {
		return language.englishName;
	}
};
