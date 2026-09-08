import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../i18n/locales/en.json";
import ko from "../i18n/locales/ko.json";
import zhTW from "../i18n/locales/zh-TW.json";
import { RankShieldBadge } from "./rank-shield-badge";

const i18n = createInstance();
void i18n.use(initReactI18next).init({
	lng: "en",
	resources: {
		en: {
			translation: {
				rankShield: {
					remaining: "Rank Shields remaining: {{count}}",
					unavailable: "Shield status unavailable",
				},
			},
		},
	},
	interpolation: { escapeValue: false },
});

const renderBadge = (tier: number, remaining: number | null) =>
	renderToStaticMarkup(
		<I18nextProvider i18n={i18n}>
			<RankShieldBadge tier={tier} remaining={remaining} />
		</I18nextProvider>,
	);

const renderInlineBadge = (tier: number, remaining: number | null) =>
	renderToStaticMarkup(
		<I18nextProvider i18n={i18n}>
			<RankShieldBadge tier={tier} remaining={remaining} inline />
		</I18nextProvider>,
	);

describe("RankShieldBadge", () => {
	test("renders each known shield count with an accessible label", () => {
		expect(renderBadge(12, 2)).toContain("2/2");
		expect(renderBadge(12, 1)).toContain('aria-label="Rank Shields remaining: 1"');
		expect(renderBadge(12, 0)).toContain("0/2");
	});

	test("renders unavailable eligible states and hides ineligible tiers", () => {
		expect(renderBadge(12, null)).toContain("Shield status unavailable");
		expect(renderBadge(13, 2)).toBe("");
		expect(renderBadge(27, 2)).toBe("");
	});

	test("drops the pill chrome inline so a dense row keeps one line", () => {
		const markup = renderInlineBadge(12, 2);
		expect(markup).toContain("2/2");
		expect(markup).toContain('aria-label="Rank Shields remaining: 2"');
		expect(markup).not.toContain("border-cyan-300/20");
		expect(markup).not.toContain("bg-cyan-300/8");
	});

	test("provides shared labels in every supported locale", () => {
		for (const locale of [en, ko, zhTW]) {
			const translations = locale as { rankShield?: { remaining?: string; unavailable?: string } };
			expect(translations.rankShield?.remaining?.trim()).toBeTruthy();
			expect(translations.rankShield?.unavailable?.trim()).toBeTruthy();
		}
	});
});
