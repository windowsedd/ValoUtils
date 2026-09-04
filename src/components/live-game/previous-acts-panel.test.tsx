import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { CompetitiveSeason } from "../../types/live-game";
import { PreviousActsPanel } from "./previous-acts-panel";

const i18n = createInstance();
void i18n.use(initReactI18next).init({
	lng: "en",
	resources: {
		en: {
			translation: {
				liveGame: {
					previousActs: "Previous Acts",
					peakRating: "Peak Rating",
					unrated: "Unrated",
					winRate: "WR",
					actMatches: "Matches {{count}}",
					actMatchesLabel: "Matches",
				},
			},
		},
	},
	interpolation: { escapeValue: false },
});

const season = (seasonId: string, overrides: Partial<CompetitiveSeason> = {}): CompetitiveSeason => ({
	seasonId,
	tier: 18,
	rankedRating: 20,
	wins: 10,
	games: 19,
	winsByTier: { "18": 10 },
	...overrides,
});

const renderPanel = (seasons: CompetitiveSeason[]) =>
	renderToStaticMarkup(
		<I18nextProvider i18n={i18n}>
			<PreviousActsPanel
				competitiveSeasons={seasons}
				currentSeasonId="act-now"
				assets={{
					seasons: new Map([
						["act-now", { label: "V26A5", startMillis: 5, endMillis: 6 }],
						["act-two", { label: "V26A4", startMillis: 3, endMillis: 4 }],
						["act-one", { label: "V25A6", startMillis: 1, endMillis: 2 }],
					]),
					tiers: new Map([
						[18, { name: "Diamond 1", icon: "d1.png", largeIcon: "d1-lg.png", color: "#60a5fa" }],
					]),
				}}
			/>
		</I18nextProvider>,
	);

describe("PreviousActsPanel", () => {
	test("renders previous act peaks and hides the current act", () => {
		const markup = renderPanel([
			season("act-now"),
			season("act-two"),
			season("act-one", { tier: 0, wins: 0, games: 1, winsByTier: {} }),
		]);
		expect(markup).toContain("data-previous-acts=\"\"");
		expect(markup).toContain("Previous Acts");
		expect(markup).toContain("V26:A4");
		expect(markup).toContain("Diamond 1");
		expect(markup).toContain("Peak Rating");
		// Label and count are separate cells now so the strip's numbers align.
		expect(markup).toContain("Matches");
		expect(markup).toContain(">19<");
		expect(markup).toContain("Unrated");
		expect(markup).toContain("V25:A6");
		expect(markup).not.toContain("V26:A5");
		expect(markup).not.toContain("data-previous-act=\"act-now\"");
	});

	test("renders nothing without previous acts", () => {
		expect(renderPanel([season("act-now")])).toBe("");
	});
});
