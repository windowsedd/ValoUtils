import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
	resolve(import.meta.dir, "..", ".github", "workflows", "build.yml"),
	"utf8",
);

test("Build & Release runs only for version tags", () => {
	expect(workflow).toMatch(
		/on:\s*\n\s+push:\s*\n\s+tags: \['v\*'\]\s*\n\s*permissions:/,
	);
	expect(workflow).not.toContain("branches:");
	expect(workflow).not.toContain("pull_request:");
	expect(workflow).not.toContain("workflow_dispatch:");
});

test("tag builds verify and publish without unsigned artifacts", () => {
	expect(workflow).toContain("- name: Verify release version");
	expect(workflow).toContain("- name: Build & Publish");
	expect(workflow).not.toContain("Build NSIS installer (unsigned)");
	expect(workflow).not.toContain("actions/upload-artifact");
	const verify = workflow.indexOf("- name: Verify release version");
	const publish = workflow.indexOf("- name: Build & Publish");
	expect(verify).toBeGreaterThan(-1);
	expect(publish).toBeGreaterThan(verify);
});

test("tag builds refuse to publish an unsigned release", () => {
	expect(workflow).toContain("- name: Verify signing key");
	expect(workflow).toContain("- name: Verify updater assets");
	const signingKey = workflow.indexOf("- name: Verify signing key");
	const publish = workflow.indexOf("- name: Build & Publish");
	const updaterAssets = workflow.indexOf("- name: Verify updater assets");
	// The key check has to run before anything is built or released, and the
	// asset check only means something once the release exists.
	expect(signingKey).toBeGreaterThan(-1);
	expect(publish).toBeGreaterThan(signingKey);
	expect(updaterAssets).toBeGreaterThan(publish);
});

test("updater assets check looks for latest.json and the installer signature", () => {
	expect(workflow).toContain("'latest.json'");
	expect(workflow).toContain("*-setup.exe.sig");
	expect(workflow).toContain("steps.publish.outputs.releaseId");
});
