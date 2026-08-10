# Release Version Command Design

## Goal

Add a local command that synchronizes the ValoUtils version metadata, creates a release commit, and creates the matching annotated Git tag. The command stops before pushing so the maintainer can inspect the commit and tag.

## Interface

Run the command from the repository root:

```powershell
bun run version 1.0.5
```

The argument must be a plain semantic version in `MAJOR.MINOR.PATCH` form. The command derives the tag name as `v1.0.5`; callers do not include the `v` prefix.

## Files

- `scripts/release-version.ts` owns argument validation, repository checks, file updates, verification, commit creation, tag creation, and terminal output. Its `--check` mode performs read-only version verification for CI.
- `scripts/release-version.test.ts` tests the version parsing and file-update behavior without modifying the real repository.
- `package.json` exposes `bun run version` for releases and `bun run version:check` for read-only verification.
- `.github/workflows/build.yml` verifies tagged releases before starting the Tauri build.

The command updates these version locations:

- `package.json` top-level `version`
- `src-tauri/tauri.conf.json` top-level `version`
- `src-tauri/Cargo.toml` package `version`
- `src-tauri/Cargo.lock` version for the `valoutils` package

## Execution Flow

1. Parse one version argument and reject missing, extra, prefixed, or malformed values.
2. Confirm the current directory belongs to this repository by checking the four target files.
3. Require a clean Git worktree before changing files.
4. Reject a version whose `v<version>` tag already exists.
5. Update the two JSON files while preserving their tab-indented style and trailing newline.
6. Replace only the package-version fields in the two Cargo files.
7. Read all four files again and confirm that every version equals the requested value.
8. Stage only the four version files.
9. Create commit `chore(release): v<version>`.
10. Create annotated tag `v<version>` with message `ValoUtils v<version>`.
11. Print the resulting commit and the manual push command `git push origin HEAD:master --follow-tags`, which works even when the release commit was created on a differently named local branch.

The script does not push, publish a GitHub Release, or change branches. GitHub Actions handles the release after the maintainer pushes the tag.

## CI Validation

For a tag such as `v1.0.5`, GitHub Actions removes the `v` prefix and compares `1.0.5` with all four committed version fields. The job fails before `tauri-apps/tauri-action` runs when a field is missing or differs from the tag. CI reads the files but does not edit them, create commits, move tags, or push to `master`.

CI invokes the read-only form as `bun run version:check 1.0.5`. This mode skips the clean-worktree and existing-tag checks because Actions checks out the release tag itself.

Branch and pull-request builds do not require a tag comparison. They continue building the versions present in the checked-out commit.

## Failure Handling

The command exits before editing when input validation, repository validation, worktree cleanliness, or tag validation fails. If a file update or Git command fails after editing starts, it reports the failing operation and leaves the changes visible for inspection. It does not reset files or delete tags automatically.

## Testing

Unit tests use temporary fixture files to cover valid version updates, malformed versions, missing package entries, and replacement scope. Tests do not invoke `git commit`, `git tag`, or `git push`.

Verification runs:

```powershell
bun test scripts/release-version.test.ts
bun run version:check 1.0.5
bun run build:vite
```

The CI check tests a matching version and a deliberate mismatch. The mismatch must return a nonzero exit code before the release build step.

The repository's existing Rust fixture failures remain outside this feature. The release command's clean-worktree check prevents a release while those deletions or any other local changes remain uncommitted.
