import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readVersions, updateVersionFiles } from "./release-version";

const roots: string[] = [];
const script = resolve(import.meta.dir, "release-version.ts");

function fixture(version = "1.2.3") {
	const root = mkdtempSync(join(tmpdir(), "valoutils-release-"));
	roots.push(root);
	mkdirSync(join(root, "src-tauri"));
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "valoutils", version }, null, "\t") + "\n",
	);
	writeFileSync(
		join(root, "src-tauri", "tauri.conf.json"),
		JSON.stringify({ productName: "ValoUtils", version }, null, "\t") + "\n",
	);
	writeFileSync(
		join(root, "src-tauri", "Cargo.toml"),
		`[package]\nname = "valoutils"\nversion = "${version}"\n\n[dependencies]\nserde = "1"\n`,
	);
	writeFileSync(
		join(root, "src-tauri", "Cargo.lock"),
		`version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "valoutils"\nversion = "${version}"\n`,
	);
	return root;
}

function run(root: string, ...args: string[]) {
	return Bun.spawnSync([process.execPath, "run", script, ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("version check", () => {
	test("accepts four matching versions without editing files", () => {
		const root = fixture();
		const paths = [
			"package.json",
			"src-tauri/tauri.conf.json",
			"src-tauri/Cargo.toml",
			"src-tauri/Cargo.lock",
		];
		const before = paths.map((path) => readFileSync(join(root, path), "utf8"));

		const result = run(root, "--check", "1.2.3");

		expect(result.exitCode).toBe(0);
		expect(paths.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(
			before,
		);
	});

	test("rejects a prefixed version", () => {
		const result = run(fixture(), "--check", "v1.2.3");

		expect(result.exitCode).not.toBe(0);
	});

	test("reports a mismatched file", () => {
		const root = fixture();
		writeFileSync(
			join(root, "src-tauri", "Cargo.toml"),
			`[package]\nname = "valoutils"\nversion = "9.9.9"\n`,
		);

		const result = run(root, "--check", "1.2.3");

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("src-tauri/Cargo.toml");
	});
});

describe("version updates", () => {
	test("updates only the four ValoUtils version fields", () => {
		const root = fixture();

		updateVersionFiles(root, "2.0.0");

		expect(readVersions(root)).toEqual({
			"package.json": "2.0.0",
			"src-tauri/tauri.conf.json": "2.0.0",
			"src-tauri/Cargo.toml": "2.0.0",
			"src-tauri/Cargo.lock": "2.0.0",
		});
		expect(
			readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8"),
		).toContain('name = "serde"\nversion = "1.0.0"');
		expect(readFileSync(join(root, "package.json"), "utf8")).toStartWith(
			'{\n\t"name"',
		);
	});

	test("rejects a lockfile without the ValoUtils package", () => {
		const root = fixture();
		writeFileSync(
			join(root, "src-tauri", "Cargo.lock"),
			'version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
		);

		expect(() => updateVersionFiles(root, "2.0.0")).toThrow(
			"src-tauri/Cargo.lock",
		);
	});
});
