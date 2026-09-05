import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    blocks = blocks.filter(({ text }) => /^name[ \t]*=[ \t]*"valoutils"[ \t]*$/m.test(text));
  }
  if (blocks.length !== 1) {
    throw new Error(`${path}: expected one ValoUtils package section, found ${blocks.length}`);
  }
  return blocks[0];
}

function versionFromPackageFile(content: string, path: VersionPath) {
  const block = packageBlock(content, path);
  const matches = [...block.text.matchAll(/^version[ \t]*=[ \t]*"([^"]+)"[ \t]*$/gm)];
  if (matches.length !== 1) {
    throw new Error(`${path}: expected one package version, found ${matches.length}`);
  }
  return matches[0][1];
}

function replacePackageVersion(content: string, path: VersionPath, version: string) {
  const block = packageBlock(content, path);
  const matches = [...block.text.matchAll(/^version[ \t]*=[ \t]*"([^"]+)"[ \t]*$/gm)];
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
    "src-tauri/tauri.conf.json": readJsonVersion(root, "src-tauri/tauri.conf.json"),
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
      mismatches.map((path) => `${path}: expected ${expected}, found ${versions[path]}`).join("\n"),
    );
  }
}

export function updateVersionFiles(root: string, version: string) {
  if (!VERSION.test(version)) {
    throw new Error("Version must use MAJOR.MINOR.PATCH format");
  }
  readVersions(root);
  for (const path of ["package.json", "src-tauri/tauri.conf.json"] as const) {
    const absolutePath = join(root, path);
    const value = JSON.parse(readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
    value.version = version;
    writeFileSync(absolutePath, JSON.stringify(value, null, "\t") + "\n");
  }
  for (const path of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"] as const) {
    const absolutePath = join(root, path);
    const content = readFileSync(absolutePath, "utf8");
    writeFileSync(absolutePath, replacePackageVersion(content, path, version));
  }
}

function git(root: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function createRelease(root: string, version: string) {
  if (git(root, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("The Git worktree must be clean before creating a release");
  }
  const tag = `v${version}`;
  if (git(root, ["tag", "--list", tag])) {
    throw new Error(`The tag ${tag} already exists`);
  }

  updateVersionFiles(root, version);
  assertVersions(readVersions(root), version);
  git(root, ["add", "--", ...VERSION_PATHS]);
  try {
    git(root, ["commit", "-m", `chore(release): ${tag}`]);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        "Release files were updated and staged, but the commit failed. " +
        "Inspect them with git diff --cached and resolve the Git error before committing.",
    );
  }
  try {
    git(root, ["tag", "-a", tag, "-m", `ValoUtils ${tag}`]);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `The release commit was created, but tag ${tag} failed. ` +
        `Resolve the Git signing error, then create it with git tag -a ${tag} -m "ValoUtils ${tag}".`,
    );
  }
  const commit = git(root, ["rev-parse", "HEAD"]);
  console.log(`Created ${tag} at ${commit}`);
  console.log("Review the release, then push it with:");
  console.log("git push origin HEAD:master --follow-tags");
}

function main() {
  const { mode, version } = parseInvocation(Bun.argv.slice(2));
  const root = process.cwd();
  if (mode === "check") {
    assertVersions(readVersions(root), version);
    console.log(`Version metadata matches ${version}`);
    return;
  }
  createRelease(root, version);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
