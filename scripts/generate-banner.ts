/**
 * Renders the ValoUtils social preview with Takumi.
 *
 * The layout follows the app's own instrument-panel language: near-black
 * ground, purple accent reserved for emphasis, and a mono readout block on the
 * right. Sizes are expressed against a 1200x320 reference and scaled, so
 * `--width 2400` yields a true @2x asset rather than an upscaled one.
 *
 * Usage: bun run banner [--out PATH] [--width N] [--format png]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render } from "takumi-js";
import { container, googleFonts, image, text } from "takumi-js/helpers";
import type { Node } from "takumi-js/helpers";

/** Design tokens lifted from src/index.css so the banner tracks the app. */
const TOKEN = {
	ground: "#0f0f11",
	panelRaised: "#222226",
	line: "#29292e",
	ink: "#ededf0",
	inkDim: "#aaaab2",
	inkFaint: "#777780",
	accent: "#8064e9",
	accentSelected: "#b6a7ff",
} as const;

const REFERENCE_WIDTH = 1200;
const FORMATS = ["png", "webp", "jpeg"] as const;

export type BannerFormat = (typeof FORMATS)[number];

export interface BannerOptions {
	width: number;
	height: number;
	format: BannerFormat;
	out: string;
}

const DEFAULTS = {
	width: 1280,
	height: 640,
	out: "assets/social-preview.png",
} as const;

const USAGE =
	"Usage: bun run banner [--out PATH] [--width N] [--height N] [--format png|webp|jpeg]";

const VALUE_FLAGS = ["--out", "--format", "--width", "--height"];

export function parseArgs(argv: string[]): BannerOptions {
	let width: number = DEFAULTS.width;
	let height: number = DEFAULTS.height;
	let out: string = DEFAULTS.out;
	let format: BannerFormat = "png";
	let explicitHeight = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!VALUE_FLAGS.includes(arg)) {
			throw new Error(`Unknown argument ${arg}\n${USAGE}`);
		}
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`${arg} requires a value\n${USAGE}`);
		}
		i++;

		switch (arg) {
			case "--out":
				out = value;
				break;
			case "--format":
				if (!FORMATS.includes(value as BannerFormat)) {
					throw new Error(`--format must be one of ${FORMATS.join(", ")}`);
				}
				format = value as BannerFormat;
				break;
			case "--width":
				width = positive(arg, value);
				break;
			case "--height":
				height = positive(arg, value);
				explicitHeight = true;
				break;
		}
	}

	// Hold the social preview's aspect ratio when only a width is given.
	if (!explicitHeight) {
		height = Math.round((width / DEFAULTS.width) * DEFAULTS.height);
	}
	return { width, height, format, out };
}

function positive(flag: string, value: string) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive number`);
	}
	return parsed;
}

/** A labelled mono readout row, matching the panels inside the app. */
function readout(label: string, value: string, s: number): Node {
	return container({
		style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			width: `${264 * s}px`,
			paddingTop: `${9 * s}px`,
			paddingBottom: `${9 * s}px`,
			borderBottom: `${1 * s}px solid ${TOKEN.line}`,
		},
		children: [
			text(label, {
				fontFamily: "Chivo Mono",
				fontSize: `${12 * s}px`,
				fontWeight: 500,
				letterSpacing: `${1.4 * s}px`,
				color: TOKEN.inkFaint,
			}),
			text(value, {
				fontFamily: "Chivo Mono",
				fontSize: `${13 * s}px`,
				fontWeight: 500,
				color: TOKEN.inkDim,
			}),
		],
	});
}

export function bannerNode(options: BannerOptions, icon: Uint8Array): Node {
	const s = options.width / REFERENCE_WIDTH;
	const iconSize = 76 * s;

	const identity = container({
		style: { display: "flex", alignItems: "center", gap: `${22 * s}px` },
		children: [
			container({
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					width: `${iconSize}px`,
					height: `${iconSize}px`,
					borderRadius: `${16 * s}px`,
					backgroundColor: TOKEN.panelRaised,
					border: `${1 * s}px solid ${TOKEN.line}`,
				},
				children: [
					image({
						src: icon,
						width: Math.round(iconSize * 0.66),
						height: Math.round(iconSize * 0.66),
					}),
				],
			}),
			container({
				style: {
					display: "flex",
					flexDirection: "column",
					gap: `${10 * s}px`,
				},
				children: [
					container({
						style: { display: "flex", alignItems: "baseline" },
						children: [
							text("VALO", {
								fontFamily: "Archivo",
								fontSize: `${62 * s}px`,
								fontWeight: 700,
								letterSpacing: `${-1 * s}px`,
								color: TOKEN.ink,
							}),
							text("UTILS", {
								fontFamily: "Archivo",
								fontSize: `${62 * s}px`,
								fontWeight: 700,
								letterSpacing: `${-1 * s}px`,
								color: TOKEN.accentSelected,
							}),
						],
					}),
					text("SETTINGS · CAREER · MATCHES · LIVE GAME · STORE", {
						fontFamily: "Archivo",
						fontSize: `${15 * s}px`,
						fontWeight: 600,
						letterSpacing: `${3.4 * s}px`,
						color: TOKEN.inkDim,
					}),
				],
			}),
		],
	});

	const panel = container({
		style: {
			display: "flex",
			flexDirection: "column",
			paddingLeft: `${28 * s}px`,
			borderLeft: `${1 * s}px solid ${TOKEN.line}`,
		},
		children: [
			readout("PLATFORM", "WINDOWS 10/11", s),
			readout("STACK", "TAURI 2 · RUST", s),
		],
	});

	return container({
		style: {
			display: "flex",
			width: "100%",
			height: "100%",
			backgroundColor: TOKEN.ground,
			fontFamily: "Archivo",
		},
		children: [
			// Accent spine: the only saturated element, echoing the rail's selection tile.
			container({
				style: {
					width: `${6 * s}px`,
					height: "100%",
					backgroundColor: TOKEN.accent,
				},
			}),
			container({
				style: {
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					flexGrow: 1,
					paddingLeft: `${54 * s}px`,
					paddingRight: `${54 * s}px`,
					gap: `${26 * s}px`,
				},
				children: [
					container({
						style: {
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							width: "100%",
						},
						children: [identity, panel],
					}),
					text(
						"Unofficial desktop companion for VALORANT. Settings profiles, career, matches, live game, social, store, and inventory — read from the Riot Client session already running on your PC.",
						{
							fontFamily: "Archivo",
							fontSize: `${16 * s}px`,
							fontWeight: 400,
							lineHeight: 1.5,
							color: TOKEN.inkFaint,
							maxWidth: `${840 * s}px`,
						},
					),
				],
			}),
		],
	});
}

export async function generateBanner(root: string, options: BannerOptions) {
	const icon = new Uint8Array(
		readFileSync(join(root, "src-tauri/icons/128x128@2x.png")),
	);
	const fonts = await googleFonts([
		{ name: "Archivo", weight: "400..700" },
		{ name: "Chivo Mono", weight: [400, 500], generic: "monospace" },
	]);

	const bytes = await render(bannerNode(options, icon), {
		width: options.width,
		height: options.height,
		format: options.format,
		fonts,
	});

	const target = join(root, options.out);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
	return { target, size: bytes.length };
}

async function main() {
	const root = process.cwd();
	const options = parseArgs(Bun.argv.slice(2));
	const { size } = await generateBanner(root, options);
	console.log(
		`Wrote ${options.out} — ${options.width}x${options.height} ${options.format}, ${(size / 1024).toFixed(1)} KB`,
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
