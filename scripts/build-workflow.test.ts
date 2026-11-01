import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
  resolve(import.meta.dir, "..", ".github", "workflows", "build.yml"),
  "utf8",
);

test("Build & Release runs for version tags and master pushes only", () => {
  expect(workflow).toMatch(
    /on:\s*\n\s+push:\s*\n\s+branches: \[master\]\s*\n\s+tags: \['v\*'\]\s*\n/,
  );
  expect(workflow).not.toContain("pull_request:");
  expect(workflow).not.toContain("workflow_dispatch:");
});

test("master pushes tag a new version and build only when a tag is chosen", () => {
  expect(workflow).toContain("- name: Auto release tag");
  expect(workflow).toContain("jq -r .version package.json");
  // An existing tag means that version was already released: never re-tag it.
  expect(workflow).toMatch(/git rev-parse -q --verify "refs\/tags\/\$tag"[\s\S]*?exit 0/);
  expect(workflow).toContain("needs: tag");
  expect(workflow).toContain("if: needs.tag.outputs.tag != ''");
  expect(workflow).toContain("ref: refs/tags/${{ needs.tag.outputs.tag }}");
  expect(workflow).toContain("tagName: ${{ needs.tag.outputs.tag }}");
  expect(workflow).not.toContain("github.ref_name }}'.Substring");
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
