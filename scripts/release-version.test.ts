import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function initializeGit(root: string) {
  git(root, "init");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "tag.gpgsign", "false");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
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
    expect(paths.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(before);
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
    expect(readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8")).toContain(
      'name = "serde"\nversion = "1.0.0"',
    );
    expect(readFileSync(join(root, "package.json"), "utf8")).toStartWith('{\n\t"name"');
  });

  test("rejects a lockfile without the ValoUtils package", () => {
    const root = fixture();
    writeFileSync(
      join(root, "src-tauri", "Cargo.lock"),
      'version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
    );

    expect(() => updateVersionFiles(root, "2.0.0")).toThrow("src-tauri/Cargo.lock");
  });

  test("rejects an invalid version before editing", () => {
    const root = fixture();
    const before = readVersions(root);

    expect(() => updateVersionFiles(root, "v2.0.0")).toThrow("MAJOR.MINOR.PATCH");
    expect(readVersions(root)).toEqual(before);
  });
});

describe("release mode", () => {
  test("creates a release commit and annotated tag without a remote", () => {
    const root = fixture();
    initializeGit(root);

    const result = run(root, "2.0.0");

    expect(result.exitCode).toBe(0);
    expect(readVersions(root)).toEqual({
      "package.json": "2.0.0",
      "src-tauri/tauri.conf.json": "2.0.0",
      "src-tauri/Cargo.toml": "2.0.0",
      "src-tauri/Cargo.lock": "2.0.0",
    });
    expect(git(root, "log", "-1", "--pretty=%s")).toBe("chore(release): v2.0.0");
    expect(git(root, "tag", "--list", "v2.0.0")).toBe("v2.0.0");
    expect(git(root, "cat-file", "-t", "v2.0.0")).toBe("tag");
    expect(git(root, "remote")).toBe("");
    expect(result.stdout.toString()).toContain("git push origin HEAD:master --follow-tags");
  });

  test("rejects a dirty worktree before editing", () => {
    const root = fixture();
    initializeGit(root);
    writeFileSync(join(root, "notes.txt"), "local change\n");
    const before = readVersions(root);

    const result = run(root, "2.0.0");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("worktree must be clean");
    expect(readVersions(root)).toEqual(before);
    expect(git(root, "log", "-1", "--pretty=%s")).toBe("initial");
  });

  test("rejects an existing tag before editing", () => {
    const root = fixture();
    initializeGit(root);
    git(root, "tag", "-a", "v2.0.0", "-m", "existing");
    const before = readVersions(root);

    const result = run(root, "2.0.0");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("tag v2.0.0 already exists");
    expect(readVersions(root)).toEqual(before);
    expect(git(root, "log", "-1", "--pretty=%s")).toBe("initial");
  });

  test("reports staged files when the release commit fails", () => {
    const root = fixture();
    initializeGit(root);
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = run(root, "2.0.0");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Release files were updated and staged, but the commit failed",
    );
    expect(git(root, "diff", "--cached", "--name-only").split("\n")).toEqual([
      "package.json",
      "src-tauri/Cargo.lock",
      "src-tauri/Cargo.toml",
      "src-tauri/tauri.conf.json",
    ]);
    expect(git(root, "log", "-1", "--pretty=%s")).toBe("initial");
  });

  test("reports an untagged release commit when tag creation fails", () => {
    const root = fixture();
    initializeGit(root);
    const failingGpg = join(root, ".git", "fail-gpg.sh");
    writeFileSync(failingGpg, "#!/bin/sh\nexit 1\n");
    chmodSync(failingGpg, 0o755);
    git(root, "config", "tag.gpgSign", "true");
    git(root, "config", "gpg.program", failingGpg.replaceAll("\\", "/"));

    const result = run(root, "2.0.0");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "The release commit was created, but tag v2.0.0 failed",
    );
    expect(git(root, "log", "-1", "--pretty=%s")).toBe("chore(release): v2.0.0");
    expect(git(root, "tag", "--list", "v2.0.0")).toBe("");
  });
});

describe("package commands", () => {
  test("exposes release and read-only check commands", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts.version).toBe("bun scripts/release-version.ts");
    expect(packageJson.scripts["version:check"]).toBe("bun scripts/release-version.ts --check");
  });
});
