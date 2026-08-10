import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_PATHS = [
	"package.json",
	"src-tauri/tauri.conf.json",
	"src-tauri/Cargo.toml",
	"src-tauri/Cargo.lock",
] as const;

type VersionPath = (typeof VERSION_PATHS)[number];

export type VersionState = Record<VersionPath, string>;

export function parseInvocation(args: string[]) {
	const mode = args[0] === "--check" ? "check" : "release";
	const values = mode === "check" ? args.slice(1) : args;
	if (values.length !== 1 || !VERSION.test(values[0])) {
		throw new Error("Usage: bun run version [--check] MAJOR.MINOR.PATCH");
	}
	return { mode, version: values[0] } as const;
}

function readJsonVersion(root: string, path: VersionPath) {
	const value = JSON.parse(readFileSync(join(root, path), "utf8")) as {
		version?: unknown;
	};
	if (typeof value.version !== "string") {
		throw new Error(`${path}: missing top-level version`);
	}
	return value.version;
}

function sectionBlocks(content: string, heading: string) {
	const headingPattern = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const startPattern = new RegExp(`^${headingPattern}[ \\t]*$`, "gm");
	const starts = [...content.matchAll(startPattern)].map((match) => match.index);
	return starts.map((start) => {
		const nextHeading = /^\[.*\][ \t]*$/gm;
		nextHeading.lastIndex = start + heading.length;
		const next = nextHeading.exec(content);
		return {
			start,
			end: next?.index ?? content.length,
			text: content.slice(start, next?.index ?? content.length),
		};
	});
}

function packageBlock(content: string, path: VersionPath) {
	const heading = path.endsWith("Cargo.lock") ? "[[package]]" : "[package]";
	let blocks = sectionBlocks(content, heading);
	if (path.endsWith("Cargo.lock")) {
		blocks = blocks.filter(({ text }) =>
			/^name[ \t]*=[ \t]*"valoutils"[ \t]*$/m.test(text),
		);
	}
	if (blocks.length !== 1) {
		throw new Error(`${path}: expected one ValoUtils package section, found ${blocks.length}`);
	}
	return blocks[0];
}

function versionFromPackageFile(content: string, path: VersionPath) {
	const block = packageBlock(content, path);
	const matches = [
		...block.text.matchAll(/^version[ \t]*=[ \t]*"([^"]+)"[ \t]*$/gm),
	];
	if (matches.length !== 1) {
		throw new Error(`${path}: expected one package version, found ${matches.length}`);
	}
	return matches[0][1];
}

function replacePackageVersion(content: string, path: VersionPath, version: string) {
	const block = packageBlock(content, path);
	const matches = [
		...block.text.matchAll(/^version[ \t]*=[ \t]*"([^"]+)"[ \t]*$/gm),
	];
	if (matches.length !== 1) {
		throw new Error(`${path}: expected one package version, found ${matches.length}`);
	}
	const updated = block.text.replace(
		/^version[ \t]*=[ \t]*"[^"]+"[ \t]*$/m,
		`version = "${version}"`,
	);
	return content.slice(0, block.start) + updated + content.slice(block.end);
}

export function readVersions(root: string): VersionState {
	const cargoTomlPath = "src-tauri/Cargo.toml" as const;
	const cargoLockPath = "src-tauri/Cargo.lock" as const;
	return {
		"package.json": readJsonVersion(root, "package.json"),
		"src-tauri/tauri.conf.json": readJsonVersion(
			root,
			"src-tauri/tauri.conf.json",
		),
		[cargoTomlPath]: versionFromPackageFile(
			readFileSync(join(root, cargoTomlPath), "utf8"),
			cargoTomlPath,
		),
		[cargoLockPath]: versionFromPackageFile(
			readFileSync(join(root, cargoLockPath), "utf8"),
			cargoLockPath,
		),
	};
}

export function assertVersions(versions: VersionState, expected: string) {
	const mismatches = VERSION_PATHS.filter((path) => versions[path] !== expected);
	if (mismatches.length > 0) {
		throw new Error(
			mismatches
				.map((path) => `${path}: expected ${expected}, found ${versions[path]}`)
				.join("\n"),
		);
	}
}

export function updateVersionFiles(root: string, version: string) {
	readVersions(root);
	for (const path of ["package.json", "src-tauri/tauri.conf.json"] as const) {
		const absolutePath = join(root, path);
		const value = JSON.parse(readFileSync(absolutePath, "utf8")) as Record<
			string,
			unknown
		>;
		value.version = version;
		writeFileSync(absolutePath, JSON.stringify(value, null, "\t") + "\n");
	}
	for (const path of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"] as const) {
		const absolutePath = join(root, path);
		const content = readFileSync(absolutePath, "utf8");
		writeFileSync(absolutePath, replacePackageVersion(content, path, version));
	}
}

function main() {
	const { mode, version } = parseInvocation(Bun.argv.slice(2));
	const root = process.cwd();
	if (mode === "check") {
		assertVersions(readVersions(root), version);
		console.log(`Version metadata matches ${version}`);
		return;
	}
	throw new Error("Release mode is not implemented yet");
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
