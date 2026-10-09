import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActRankTriangle } from "./act-rank-triangle";
import { existsSync } from "node:fs";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "../../i18n/locales/en.json";
import { ActRankPanel } from "./act-rank-panel";

describe("ActRankTriangle", () => {
	test("resolves border and crystal assets as bundled module URLs", () => {
		const markup = renderToStaticMarkup(<ActRankTriangle winsByTier={{ "20": 1 }} wins={1} />);
		const urls = [...markup.matchAll(/(?:src|href)="([^"]+\.png)"/g)].map((match) => match[1]);
		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) {
			expect(url.startsWith("file:")).toBe(true);
			expect(existsSync(new URL(url))).toBe(true);
		}
	});
	test("separates the inset lattice and crystals from the official border", () => {
		const markup = renderToStaticMarkup(
			<ActRankTriangle winsByTier={{ "20": 47, "24": 2 }} wins={14} />,
		);

		expect(markup).toContain('max-w-[24rem]');
		expect(markup).toContain('aspect-square');
		expect(markup.match(/data-rank-cell=""/g)).toHaveLength(14);
		expect(markup).toContain('24_up.png"');
		expect(markup).toContain('20_down.png"');
		expect(markup).toContain('border1.png"');
		expect(markup).toContain('data-act-rank-mask=""');
		expect(markup).toContain('data-act-rank-lattice=""');
		expect(markup).toContain('data-rank-cell="" class="absolute z-[2] object-fill" style="left:44.925');
		expect(markup).toContain('top:18.75%');
		expect(markup).toContain('data-act-rank-border=""');
		expect(markup).toContain("<mask");
		expect(markup).toContain("<polygon");
	});

	test("selects the official border image from total Act wins", () => {
		for (const [wins, border] of [
			[0, 0],
			[9, 1],
			[25, 2],
			[50, 3],
			[75, 4],
			[100, 5],
		] as const) {
			const markup = renderToStaticMarkup(
				<ActRankTriangle winsByTier={{}} wins={wins} />,
			);
			expect(markup).toContain(`border${border}.png"`);
		}
	});
});

describe("ActRankPanel layout", () => {
	test("labels an act with placement games as unranked", async () => {
		const i18n = createInstance();
		await i18n.init({ lng: "en", resources: { en: { translation: en } } });
		const markup = renderToStaticMarkup(
			<I18nextProvider i18n={i18n}>
				<ActRankPanel defaultExpanded assets={{ seasons: new Map() }}
					selectedSeasonId="act" onSeasonChange={() => {}}
					competitiveSeasons={[{ seasonId: "act", tier: 0, rankedRating: 0, wins: 0, games: 2, winsByTier: {} }]} />
			</I18nextProvider>,
		);
		expect(markup).toContain("Unranked");
		expect(markup).toContain(">—<");
		expect(markup).not.toContain("Unavailable");
	});
	test("puts the triangle beside the stats based on the card's own width", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const source = readFileSync(join(import.meta.dir, "act-rank-panel.tsx"), "utf8");
		expect(source).toContain("panel @container");
		expect(source).toContain("@lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]");
		// The triangle comes first, so it sits on the left once the card is wide enough.
		expect(source.indexOf("<ActRankTriangle")).toBeLessThan(source.indexOf('<dl className="grid grid-cols-2'));
		expect(source).not.toContain("<select");
	});
});
