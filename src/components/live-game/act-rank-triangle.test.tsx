import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActRankTriangle } from "./act-rank-triangle";

describe("ActRankTriangle", () => {
	test("renders every win with its competitive tier PNG below the official border", () => {
		const markup = renderToStaticMarkup(
			<ActRankTriangle winsByTier={{ "20": 12, "24": 2 }} wins={14} />,
		);

		expect(markup).toContain('viewBox="0 0 512 512"');
		expect(markup).toContain('max-w-[24rem]');
		expect(markup).toContain('aspect-square');
		expect(markup).toContain("<clipPath");
		expect(markup).toContain('stroke-linejoin="round"');
		expect(markup.match(/data-rank-cell=""/g)).toHaveLength(14);
		expect(markup).toContain('href="/mmr/24_up.png"');
		expect(markup).toContain('href="/mmr/20_down.png"');
		expect(markup).toContain('src="/mmr/border1.png"');
		expect(markup).toContain('data-act-rank-border=""');
		expect(markup).toContain('pointer-events-none absolute inset-0 z-10');
		expect(markup).not.toContain("<linearGradient");
		expect(markup).not.toContain('data-palette=');
		expect(markup).not.toContain('stroke="#30353b"');
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
			expect(markup).toContain(`src="/mmr/border${border}.png"`);
		}
	});
});
