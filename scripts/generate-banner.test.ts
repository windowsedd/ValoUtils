import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bannerNode, parseArgs } from "./generate-banner";

const parse = (...argv: string[]) => parseArgs(argv);

describe("parseArgs", () => {
	test("defaults to the social preview", () => {
		expect(parse()).toEqual({
			width: 1280,
			height: 640,
			format: "png",
			out: "assets/social-preview.png",
		});
	});

	test("rejects the removed --social preset switch", () => {
		expect(() => parse("--social")).toThrow("Unknown argument --social");
	});

	test("a lone --width keeps the preset aspect ratio", () => {
		expect(parse("--width", "2560").height).toBe(1280);
	});

	test("an explicit --height overrides the derived one", () => {
		const options = parse("--width", "2400", "--height", "500");
		expect(options.height).toBe(500);
	});

	test("rejects unknown flags", () => {
		expect(() => parse("--bogus")).toThrow("Unknown argument --bogus");
	});

	test("rejects a flag whose value is missing or another flag", () => {
		expect(() => parse("--width")).toThrow("--width requires a value");
		expect(() => parse("--out", "--social")).toThrow(
			"--out requires a value",
		);
	});

	test("rejects formats the renderer is not set up for", () => {
		expect(() => parse("--format", "gif")).toThrow("--format must be one of");
	});

	test("rejects non-positive dimensions", () => {
		expect(() => parse("--width", "0")).toThrow("positive number");
		expect(() => parse("--height", "-10")).toThrow("positive number");
		expect(() => parse("--width", "wide")).toThrow("positive number");
	});
});

test("README uses only the social preview hero asset", () => {
	const root = resolve(import.meta.dir, "..");
	const readme = readFileSync(resolve(root, "README.md"), "utf8");
	expect(readme).toContain('src="assets/social-preview.png"');
	expect(readme).not.toMatch(/assets\/banner\.(?:svg|png)/);
	expect(existsSync(resolve(root, "assets", "banner.svg"))).toBe(false);
	expect(existsSync(resolve(root, "assets", "banner.png"))).toBe(false);
});

describe("bannerNode", () => {
	const icon = new Uint8Array([1, 2, 3, 4]);
	const render = (overrides: Partial<Parameters<typeof bannerNode>[0]> = {}) =>
		bannerNode({ ...parse(), ...overrides }, icon);

	const flatten = (node: ReturnType<typeof bannerNode>): string[] => {
		if (node.type === "text") return [node.text];
		if (node.type === "container") {
			return (node.children ?? []).flatMap(flatten);
		}
		return [];
	};

	test("carries the wordmark and the readout labels", () => {
		const strings = flatten(render());
		expect(strings).toContain("VALO");
		expect(strings).toContain("UTILS");
		expect(strings).toContain("PLATFORM");
		expect(strings).toContain("STACK");
	});

	// A version printed here would be stale the moment the next release ships,
	// since the banner is committed as a PNG and not regenerated per release.
	test("states no version", () => {
		const joined = flatten(render()).join(" ");
		expect(joined).not.toContain("VERSION");
		expect(joined).not.toMatch(/v\d+\.\d+\.\d+/);
	});

	test("does not advertise the removed replays feature", () => {
		const joined = flatten(render()).join(" ").toLowerCase();
		expect(joined).not.toContain("replay");
	});

	test("scales every dimension off the reference width", () => {
		const single = render();
		const double = render({ width: 2560, height: 1280 });
		// The accent spine is the first child of the root; at 2x it is twice as wide.
		const spine = (node: ReturnType<typeof bannerNode>) =>
			node.type === "container" ? node.children?.[0].style?.width : undefined;
		expect(spine(single)).toBe("6.4px");
		expect(spine(double)).toBe("12.8px");
	});
});
