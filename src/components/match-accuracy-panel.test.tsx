import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MatchAccuracy } from "./match-accuracy-panel";

const i18n = createInstance();
void i18n.use(initReactI18next).init({
	lng: "en",
	resources: {
		en: {
			translation: {
				matches: {
					accuracy: "Accuracy",
					head: "Head",
					body: "Body",
					legs: "Legs",
					hits: "{{count}} Hits",
				},
			},
		},
	},
	interpolation: { escapeValue: false },
});

const renderAccuracy = (player: { headshots: number; bodyshots: number; legshots: number }) =>
	renderToStaticMarkup(
		<I18nextProvider i18n={i18n}>
			<MatchAccuracy player={player} />
		</I18nextProvider>,
	);

describe("MatchAccuracy", () => {
	test("renders head body and legs with percents and hit counts", () => {
		const markup = renderAccuracy({ headshots: 20, bodyshots: 40, legshots: 5 });
		expect(markup).toContain("data-match-accuracy=\"\"");
		expect(markup).toContain("data-accuracy-zone=\"head\"");
		expect(markup).toContain("data-accuracy-zone=\"body\"");
		expect(markup).toContain("data-accuracy-zone=\"legs\"");
		expect(markup).toContain("30.77%");
		expect(markup).toContain("61.54%");
		expect(markup).toContain("7.69%");
		expect(markup).toContain("20 Hits");
		expect(markup).toContain("40 Hits");
		expect(markup).toContain("5 Hits");
		expect(markup).toContain("<svg");
	});

	test("renders zeros when no shots landed", () => {
		const markup = renderAccuracy({ headshots: 0, bodyshots: 0, legshots: 0 });
		expect(markup.match(/0\.00%/g)?.length).toBe(3);
		expect(markup.match(/0 Hits/g)?.length).toBe(3);
	});
});
