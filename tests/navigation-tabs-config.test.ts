import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const appCommand = readFileSync(join(root, "src-tauri/src/commands/app.rs"), "utf8");
const tauriApp = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");

describe("hidden navigation config", () => {
	test("defaults hiddenTabs to an empty array", () => {
		expect(tauriApp).toContain('config_defaults.insert("hiddenTabs".into(), json!([]));');
	});

	test("returns hiddenTabs from config_get_all", () => {
		expect(appCommand).toContain('"hiddenTabs": get_or("hiddenTabs", json!([]))');
	});
});
