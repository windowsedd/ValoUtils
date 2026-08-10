# Tag-Only Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Build & Release run only for `v*` tag pushes and remove the unused unsigned-build path.

**Architecture:** A focused Bun regression test inspects the workflow source and locks down its trigger and step set. The workflow keeps setup, version validation, signing, and draft-release publishing while removing every non-tag trigger and branch-only step.

**Tech Stack:** GitHub Actions YAML, Bun, `bun:test`, Tauri Action

## Global Constraints

- `.github/workflows/build.yml` must trigger only for pushed `v*` tags.
- Keep release version validation before the Tauri build.
- Keep signed draft GitHub Release publishing.
- Remove branch, pull-request, and manual triggers.
- Remove unsigned NSIS build and temporary artifact upload.

---

### Task 1: Lock down and implement the tag-only workflow

**Files:**
- Create: `scripts/build-workflow.test.ts`
- Modify: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: `.github/workflows/build.yml` as UTF-8 text.
- Produces: a workflow triggered only by `push.tags: ["v*"]` and a regression test that rejects non-tag triggers or unsigned-build steps.

- [ ] **Step 1: Write the failing workflow test**

Create `scripts/build-workflow.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
	resolve(import.meta.dir, "..", ".github", "workflows", "build.yml"),
	"utf8",
);

test("Build & Release runs only for version tags", () => {
	expect(workflow).toMatch(/on:\s*\n\s+push:\s*\n\s+tags: \['v\*'\]\s*\n\s*permissions:/);
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
```

- [ ] **Step 2: Run the test and verify red**

Run: `bun test scripts/build-workflow.test.ts`

Expected: FAIL because branch, pull-request, manual, unsigned-build, and artifact-upload configuration still exists.

- [ ] **Step 3: Simplify the workflow**

Replace the event block with:

```yaml
on:
  push:
    tags: ['v*']
```

Remove `if:` guards from `Verify release version` and `Build & Publish` because every run is now a tag run. Remove the full `Build NSIS installer (unsigned)` and `Upload artifact` steps.

- [ ] **Step 4: Run focused verification**

```powershell
bun test scripts/build-workflow.test.ts
bun run version:check 1.0.4
```

Expected: both commands exit 0.

- [ ] **Step 5: Inspect and commit only the workflow change and test**

```powershell
git diff --check -- .github/workflows/build.yml scripts/build-workflow.test.ts
git add -- .github/workflows/build.yml scripts/build-workflow.test.ts
git diff --cached --check
git commit -m "ci: build releases only for version tags"
```

- [ ] **Step 6: Push and verify `master`**

```powershell
git push origin master
git ls-remote origin refs/heads/master
```

Expected: remote `master` resolves to the new workflow commit. This push must not start Build & Release because the updated workflow has no branch trigger.
