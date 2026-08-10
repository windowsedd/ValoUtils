# Release Version Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested Bun command that synchronizes ValoUtils version files, creates a local release commit and annotated tag, and lets tagged CI verify the committed versions before building.

**Architecture:** A single TypeScript CLI owns version parsing, deterministic file updates, read-only checks, and Git orchestration. Bun integration tests run the CLI in temporary repositories so they exercise real filesystem and Git behavior without touching the working repository. GitHub Actions calls the CLI's read-only mode before tagged builds.

**Tech Stack:** Bun, TypeScript, `bun:test`, Git, GitHub Actions, PowerShell

## Global Constraints

- Accept versions only in plain `MAJOR.MINOR.PATCH` form.
- Update `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `valoutils` package entry in `src-tauri/Cargo.lock`.
- Create local commit `chore(release): v<version>` and annotated tag `v<version>`.
- Do not push, change branches, reset files, or delete tags.
- CI may read version files and fail the job; CI must not edit or commit repository files.
- Preserve unrelated working-tree changes throughout implementation.

---

### Task 1: Read-only version validation and deterministic file updates

**Files:**
- Create: `scripts/release-version.ts`
- Create: `scripts/release-version.test.ts`

**Interfaces:**
- Consumes: CLI arguments `--check <MAJOR.MINOR.PATCH>` or `<MAJOR.MINOR.PATCH>` and the current working directory.
- Produces: `parseInvocation(args: string[]): { mode: "check" | "release"; version: string }`, `readVersions(root: string): VersionState`, and `updateVersionFiles(root: string, version: string): void`.

- [ ] **Step 1: Write failing tests for argument parsing and read-only checks**

Create `scripts/release-version.test.ts` with fixture helpers that create the four target files in a temporary directory. Add tests asserting that `--check 1.2.3` succeeds when all fields match, rejects `v1.2.3`, rejects a mismatched Cargo version, and leaves every fixture byte unchanged.

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const script = resolve(import.meta.dir, "release-version.ts");

function fixture(version = "1.2.3") {
	const root = mkdtempSync(join(tmpdir(), "valoutils-release-"));
	roots.push(root);
	mkdirSync(join(root, "src-tauri"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "valoutils", version }, null, "\t") + "\n");
	writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ productName: "ValoUtils", version }, null, "\t") + "\n");
	writeFileSync(join(root, "src-tauri", "Cargo.toml"), `[package]\nname = "valoutils"\nversion = "${version}"\n\n[dependencies]\nserde = "1"\n`);
	writeFileSync(join(root, "src-tauri", "Cargo.lock"), `version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "valoutils"\nversion = "${version}"\n`);
	return root;
}

function run(root: string, ...args: string[]) {
	return Bun.spawnSync([process.execPath, "run", script, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("version check", () => {
	test("accepts four matching versions without editing files", () => {
		const root = fixture();
		const paths = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
		const before = paths.map((path) => readFileSync(join(root, path), "utf8"));
		const result = run(root, "--check", "1.2.3");
		expect(result.exitCode).toBe(0);
		expect(paths.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(before);
	});

	test("rejects a prefixed version", () => {
		const result = run(fixture(), "--check", "v1.2.3");
		expect(result.exitCode).not.toBe(0);
	});

	test("reports a mismatched file", () => {
		const root = fixture();
		writeFileSync(join(root, "src-tauri", "Cargo.toml"), `[package]\nname = "valoutils"\nversion = "9.9.9"\n`);
		const result = run(root, "--check", "1.2.3");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("src-tauri/Cargo.toml");
	});
});
```

- [ ] **Step 2: Run the tests and verify the missing CLI causes failure**

Run: `bun test scripts/release-version.test.ts`

Expected: FAIL because `scripts/release-version.ts` does not exist.

- [ ] **Step 3: Implement parsing, version reads, checks, and updates**

Create `scripts/release-version.ts`. Use `node:fs`, `node:path`, and `node:child_process`; keep `import.meta.main` as the only entry point with process side effects. Match the `[package]` block in `Cargo.toml` and the `[[package]]` block whose name is `valoutils` in `Cargo.lock`, replacing one `version` field in each. Parse and write JSON with tab indentation and one trailing newline. Throw file-specific errors for missing or duplicate matches.

```ts
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type VersionState = Record<
	"package.json" | "src-tauri/tauri.conf.json" | "src-tauri/Cargo.toml" | "src-tauri/Cargo.lock",
	string
>;

export function parseInvocation(args: string[]) {
	const mode = args[0] === "--check" ? "check" : "release";
	const values = mode === "check" ? args.slice(1) : args;
	if (values.length !== 1 || !VERSION.test(values[0])) {
		throw new Error("Usage: bun run version [--check] MAJOR.MINOR.PATCH");
	}
	return { mode, version: values[0] } as const;
}
```

Implement `readVersions`, `assertVersions`, and `updateVersionFiles`, then make `--check` call only `readVersions` and `assertVersions` before printing `Version metadata matches <version>`.

- [ ] **Step 4: Run the focused tests and verify green**

Run: `bun test scripts/release-version.test.ts`

Expected: all version-check tests PASS.

- [ ] **Step 5: Add failing tests for update scope**

Import `updateVersionFiles` in the test file. Assert that an update changes all four ValoUtils versions to `2.0.0`, preserves the unrelated `serde` version, keeps tab-indented JSON, and throws when the `valoutils` lockfile package is absent.

- [ ] **Step 6: Run the tests and verify the new assertions fail**

Run: `bun test scripts/release-version.test.ts`

Expected: FAIL because update behavior is incomplete or does not enforce the package match.

- [ ] **Step 7: Complete the minimal update implementation and rerun tests**

Run: `bun test scripts/release-version.test.ts`

Expected: all tests PASS.

- [ ] **Step 8: Commit Task 1**

```powershell
git add -- scripts/release-version.ts scripts/release-version.test.ts
git diff --cached --check
git commit -m "feat: add release version metadata tool"
```

### Task 2: Safe local release commit and tag

**Files:**
- Modify: `scripts/release-version.ts`
- Modify: `scripts/release-version.test.ts`

**Interfaces:**
- Consumes: release invocation `<MAJOR.MINOR.PATCH>` in a clean Git repository.
- Produces: synchronized files, commit `chore(release): v<version>`, annotated tag `v<version>`, and no network operations.

- [ ] **Step 1: Write failing real-Git integration tests**

Extend the fixture helper to initialize Git, configure a fixture-only identity, stage the files, and create an initial commit. Add tests that release mode updates all four files, creates the expected commit and annotated tag, does not create a remote, rejects a dirty worktree before editing, and rejects an existing tag.

```ts
function git(root: string, ...args: string[]) {
	const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function initializeGit(root: string) {
	git(root, "init");
	git(root, "config", "user.name", "Release Test");
	git(root, "config", "user.email", "release-test@example.invalid");
	git(root, "add", ".");
	git(root, "commit", "-m", "initial");
}
```

Check `git log -1 --pretty=%s`, `git tag --list v2.0.0`, `git cat-file -t v2.0.0`, and `git remote` in assertions.

- [ ] **Step 2: Run the tests and verify release-mode failure**

Run: `bun test scripts/release-version.test.ts`

Expected: FAIL because release mode does not run the Git safety checks or create the commit and tag.

- [ ] **Step 3: Implement Git orchestration**

Add a checked `git(root, args)` wrapper using `spawnSync`. Before editing, require empty output from `git status --porcelain --untracked-files=all` and require `git tag --list v<version>` to be empty. After updating and verifying, run these exact operations:

```ts
git(root, ["add", "--", ...Object.keys(readVersions(root))]);
git(root, ["commit", "-m", `chore(release): v${version}`]);
git(root, ["tag", "-a", `v${version}`, "-m", `ValoUtils v${version}`]);
```

Print the commit hash and `git push origin HEAD:master --follow-tags`. Do not invoke any push command.

- [ ] **Step 4: Run the integration tests and verify green**

Run: `bun test scripts/release-version.test.ts`

Expected: all tests PASS, including dirty-tree and existing-tag rejection.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- scripts/release-version.ts scripts/release-version.test.ts
git diff --cached --check
git commit -m "feat: create local release commits and tags"
```

### Task 3: Package commands and tagged CI gate

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/build.yml`
- Test: `scripts/release-version.test.ts`

**Interfaces:**
- Consumes: `bun run version <version>`, `bun run version:check <version>`, and `github.ref_name` for `v*` tags.
- Produces: local release entry points and a pre-build CI failure when tag metadata differs.

- [ ] **Step 1: Add package-script assertions**

Add a test that reads the real repository `package.json` and expects:

```ts
expect(pkg.scripts.version).toBe("bun scripts/release-version.ts");
expect(pkg.scripts["version:check"]).toBe("bun scripts/release-version.ts --check");
```

- [ ] **Step 2: Run the test and verify red**

Run: `bun test scripts/release-version.test.ts`

Expected: FAIL because the package scripts do not exist.

- [ ] **Step 3: Add package commands**

Add these entries under `scripts` in `package.json`:

```json
"version": "bun scripts/release-version.ts",
"version:check": "bun scripts/release-version.ts --check"
```

- [ ] **Step 4: Add the tagged CI check before Build & Publish**

Insert this step before `Build & Publish` in `.github/workflows/build.yml`:

```yaml
      - name: Verify release version
        if: startsWith(github.ref, 'refs/tags/v')
        shell: pwsh
        run: |
          $releaseVersion = '${{ github.ref_name }}'.Substring(1)
          bun run version:check $releaseVersion
```

- [ ] **Step 5: Run focused verification**

Run:

```powershell
bun test scripts/release-version.test.ts
bun run version:check 1.0.4
```

Expected: all tests PASS and the repository metadata check prints `Version metadata matches 1.0.4`.

- [ ] **Step 6: Verify a mismatch fails without editing files**

Run: `bun run version:check 9.9.9`

Expected: nonzero exit code listing all version files that do not contain `9.9.9`; `git diff` remains unchanged apart from the implementation work and the user's pre-existing changes.

- [ ] **Step 7: Run frontend and Rust verification**

Run:

```powershell
bun run build:vite
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both commands exit 0. Record any pre-existing full Rust test failures separately; do not hide or repair unrelated missing replay fixtures as part of this feature.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- package.json .github/workflows/build.yml scripts/release-version.test.ts
git diff --cached --check
git commit -m "ci: verify tagged release versions"
```

### Task 4: Final review without creating a real release

**Files:**
- Review: `scripts/release-version.ts`
- Review: `scripts/release-version.test.ts`
- Review: `package.json`
- Review: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: the completed implementation.
- Produces: verification evidence and release usage instructions; no production tag.

- [ ] **Step 1: Run all feature checks**

```powershell
bun test scripts/release-version.test.ts
bun run version:check 1.0.4
bun run build:vite
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: every command exits 0.

- [ ] **Step 2: Confirm the CLI cannot push**

Run: `rg -n "git push|\[.?push.?\]" scripts/release-version.ts`

Expected: only the printed manual instruction contains `git push`; no spawned Git argument list contains `push`.

- [ ] **Step 3: Inspect the final diff and repository state**

Run:

```powershell
git diff --check
git status --short
git diff -- scripts/release-version.ts scripts/release-version.test.ts package.json .github/workflows/build.yml
```

Expected: no whitespace errors, no unexpected files, and the user's unrelated changes remain intact.

- [ ] **Step 4: Document usage in the handoff**

Provide these commands without executing them:

```powershell
bun run version 1.0.5
git show --stat HEAD
git show v1.0.5 --no-patch
git push origin HEAD:master --follow-tags
```

Do not create `v1.0.5` during implementation because the current working tree contains unrelated uncommitted changes and the user has not requested an actual release version.
