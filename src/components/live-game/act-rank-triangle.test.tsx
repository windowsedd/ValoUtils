import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActRankTriangle } from "./act-rank-triangle";

describe("ActRankTriangle", () => {
	test("renders one clipped SVG coordinate system without PNG layers", () => {
		const markup = renderToStaticMarkup(
			<ActRankTriangle winsByTier={{ "20": 5, "24": 2 }} wins={7} />,
		);

		expect(markup).toContain('viewBox="0 0 300 360"');
		expect(markup).toContain("<clipPath");
		expect(markup).toContain('stroke-linejoin="round"');
		expect(markup).not.toContain("<img");
		expect(markup).not.toContain("/mmr/");
		expect(markup.match(/data-rank-cell=""/g)).toHaveLength(7);
		expect(markup).toContain('data-palette="immortal"');
		expect(markup).toContain('data-palette="diamond"');
	});
});
