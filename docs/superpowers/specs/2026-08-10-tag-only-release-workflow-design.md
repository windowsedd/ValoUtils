# Tag-Only Release Workflow Design

## Goal

Run the Build & Release workflow only when a maintainer pushes a `v*` Git tag. A commit pushed to `master` must not start this workflow.

## Workflow

`.github/workflows/build.yml` will use one trigger:

```yaml
on:
  push:
    tags: ["v*"]
```

The job will install Bun, Rust, and project dependencies; verify that the tag version matches all four committed version fields; then use `tauri-apps/tauri-action` to build, sign, and publish a draft GitHub Release.

The workflow will remove branch-push, pull-request, and manual-dispatch triggers. It will also remove the unsigned NSIS build and temporary artifact-upload steps because no non-tag run remains.

## Failure Behavior

The version check runs before Tauri. A mismatched tag fails without starting the build. Build or signing failures leave the draft release workflow failed for inspection.

## Verification

- Parse the workflow YAML and confirm the only event is a `push` with `tags: ["v*"]`.
- Confirm the workflow contains `Verify release version` and `Build & Publish`.
- Confirm it no longer contains the unsigned build or artifact-upload steps.
- Run `bun run version:check 1.0.4` against the current repository metadata.
