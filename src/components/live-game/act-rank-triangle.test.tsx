import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActRankTriangle } from "./act-rank-triangle";

describe("ActRankTriangle", () => {
	test("separates the inset lattice and crystals from the official border", () => {
		const markup = renderToStaticMarkup(
			<ActRankTriangle winsByTier={{ "20": 47, "24": 2 }} wins={14} />,
		);

		expect(markup).toContain('max-w-[24rem]');
		expect(markup).toContain('aspect-square');
		expect(markup.match(/data-rank-cell=""/g)).toHaveLength(14);
		expect(markup).toContain('src="/mmr/24_up.png"');
		expect(markup).toContain('src="/mmr/20_down.png"');
		expect(markup).toContain('<image href="/mmr/border1.png"');
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
			expect(markup).toContain(`<image href="/mmr/border${border}.png"`);
		}
	});
});
