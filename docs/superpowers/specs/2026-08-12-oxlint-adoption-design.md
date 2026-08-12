# Oxlint Adoption Design

## Goal

Replace the repository's unusable ESLint command with a working Oxlint command for the React and TypeScript frontend. Keep this first adoption small enough to review without mixing in formatting or build changes.

## Scope

- Add `oxlint` as a development dependency through Bun.
- Replace the `lint` package script with an Oxlint command that checks `src` and fails on warnings.
- Add a root Oxlint configuration for the TypeScript and React code in `src`.
- Enable reporting for unused disable directives.
- Fix source findings that prevent the new lint command from passing, provided each fix preserves runtime behavior.
- Update the repository guide so it no longer says that linting is broken.

This change will not add Oxfmt, type-aware linting, `oxlint-tsgolint`, editor settings, or a new CI job. The existing TypeScript build remains responsible for type checking.

## Configuration

Use Oxlint's native TypeScript and React support. Start from its correctness rules and enable the React plugin. Keep the configuration explicit and short so later changes can tighten rules based on project needs.

The package script will retain the existing `bun run lint` interface. It will target `src`, report unused disable comments, and treat warnings as failures. Developers and automation therefore receive a nonzero exit status for every reported finding.

## Handling Findings

Run Oxlint after configuration. Fix mechanical or clear correctness findings in the files it reports. Do not refactor unrelated code or suppress valid findings to produce a green result. If Oxlint reports a rule that conflicts with an intentional project pattern, document and disable that rule in the root configuration.

## Verification

The change is complete when all of these commands succeed:

```text
bun run lint
bun run build:vite
```

Review the final diff to confirm that Bun's lockfile contains Oxlint, the package script invokes Oxlint, the configuration stays within the agreed scope, and existing unrelated working-tree changes remain untouched.
