import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const config = JSON.parse(
	readFileSync(
		resolve(import.meta.dir, "..", "src-tauri", "tauri.conf.json"),
		"utf8",
	),
);

test("release builds generate signed updater artifacts", () => {
	expect(config.bundle.createUpdaterArtifacts).toBe(true);
});
