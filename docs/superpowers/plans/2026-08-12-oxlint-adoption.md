# Oxlint Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken ESLint package script with an Oxlint check that passes on the current frontend code.

**Architecture:** A root `.oxlintrc.json` owns lint policy and keeps `bun run lint` as the stable developer interface. Oxlint checks `src` with its native ESLint, TypeScript, Unicorn, Oxc, and React plugins; TypeScript continues to perform type checking during `build:vite`.

**Tech Stack:** Bun, Oxlint 1.76.0, React 19, TypeScript 6

## Global Constraints

- Do not add Oxfmt, type-aware linting, `oxlint-tsgolint`, editor settings, or a CI job.
- Do not change runtime behavior while resolving lint findings.
- Preserve all unrelated working-tree changes.
- Use Bun for dependency and script commands.

---

### Task 1: Install and Configure Oxlint

**Files:**
- Create: `.oxlintrc.json`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: Bun's package manager and the existing `bun run lint` script name.
- Produces: `bun run lint`, a repository-root command that checks `src` and returns nonzero for every diagnostic.

- [ ] **Step 1: Confirm the existing lint command is broken**

Run: `bun run lint`

Expected: FAIL because the script invokes the uninstalled `eslint` executable.

- [ ] **Step 2: Install the reviewed Oxlint release**

Run: `bun add --dev oxlint@1.76.0`

Expected: `package.json` gains `"oxlint": "^1.76.0"` in `devDependencies`, and Bun updates `bun.lock`.

- [ ] **Step 3: Add the root lint configuration**

Create `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": {
    "correctness": "error"
  },
  "plugins": ["eslint", "react", "unicorn", "typescript", "oxc"],
  "env": {
    "browser": true,
    "es2020": true
  },
  "options": {
    "denyWarnings": true,
    "reportUnusedDisableDirectives": "error"
  }
}
```

- [ ] **Step 4: Replace the package script**

In `package.json`, replace:

```json
"lint": "eslint src --ext ts,tsx --report-unused-disable-directives --max-warnings 0"
```

with:

```json
"lint": "oxlint src"
```

- [ ] **Step 5: Run the new lint command and capture the migration baseline**

Run: `bun run lint`

Expected: Oxlint runs successfully but exits nonzero with the known frontend findings addressed in Task 2. It must not report an invalid configuration, missing plugin, or unmatched path.

- [ ] **Step 6: Commit the tooling migration**

```bash
git add .oxlintrc.json package.json bun.lock
git commit -m "build: replace eslint script with oxlint"
```

### Task 2: Resolve the Oxlint Baseline

**Files:**
- Modify: `src/pages/Matches.tsx`
- Modify: `src/pages/Friends.tsx`
- Modify: `src/pages/IPCTest.tsx`
- Modify: `src/components/riot-client-watcher.tsx`
- Modify: `src/components/button.tsx`
- Modify: `src/pages/SettingsProfiles.tsx`
- Modify: `src/components/live-game/use-live-game-assets.ts`
- Modify: `src/components/crosshair-svg-generator.tsx`
- Modify: `src/components/replay-viewer.tsx`

**Interfaces:**
- Consumes: The `bun run lint` command from Task 1 and existing component APIs.
- Produces: Source code that passes Oxlint without changing public component props or IPC behavior.

- [ ] **Step 1: Apply the behavior-preserving mechanical fixes**

Make these exact changes:

- Add `t` to the existing effect dependency arrays in `Matches.tsx` and `Friends.tsx`.
- Add `showModal` and `closeModal` to the existing effect dependency arrays in `IPCTest.tsx` and `riot-client-watcher.tsx`.
- Rename the destructured but intentionally accepted binding to `modalOnError: _modalOnError = true` in `button.tsx`; keep the prop in `CustomButtonProps` for caller compatibility.
- Replace `new Array<T>(length).fill(value)` with `Array<T>(length).fill(value)` in `use-live-game-assets.ts` and `replay-viewer.tsx`.
- Remove redundant `!!` operators from the five `if` conditions reported in `crosshair-svg-generator.tsx`. Do not replace the conditions with `includes`, because that would change their current truthiness behavior.
- Add `actorIdx` to the dependency array of the canvas `render` callback and `replayId` to the dependency array of `exportJson` in `replay-viewer.tsx`.

- [ ] **Step 2: Preserve the URL-value cache contract explicitly**

The `useImageCache` hook intentionally keys its memo by URL values because callers construct arrays during render. Replace the function with:

```tsx
function useImageCache(urls: string[]) {
    const [, forceRender] = useState(0);
    // Callers create URL arrays during render, so object identity would rebuild
    // the cache on every image load. URL values define the cache identity.
    // oxlint-disable react-hooks/exhaustive-deps
    const cache = useMemo(() => {
        const next: Record<string, HTMLImageElement> = {};
        for (const url of new Set(urls.filter(Boolean))) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => forceRender(v => v + 1);
            img.src = url;
            next[url] = img;
        }
        return next;
    }, [urls.join('|')]);
    // oxlint-enable react-hooks/exhaustive-deps
    return cache;
}
```

- [ ] **Step 3: Remove the async Promise executor**

In `SettingsProfiles.tsx`, change the share-code button handler from a Promise with an async executor to an async handler. Perform input validation and `await getData(inputData)` before returning the callback-backed Promise:

```tsx
onClickLoading={async () => {
  if (!window.Main) throw "No window.Main";

  window.Main.send("analytics:track", "profile:add:load_share", "{}");
  const input = window.document.getElementById("share-code") as HTMLInputElement;
  const inputData = input.value;
  if (!inputData) throw t("profiles.noInputData");
  if (inputData.length != 10) throw t("profiles.invalidShareCode");

  const data = await getData(inputData);
  if (!data) throw t("profiles.invalidDataReturned");

  return new Promise<void>((resolve, reject) => {
    const save = () => {
      window.Main.on("settings:profile:add", (message: string) => {
        window.Main.removeAllListeners("settings:profile:add");
        const rawData = JSON.parse(message);
        if (rawData.error) {
          reject(rawData.error);
          reject_1();
          return;
        }
        refreshProfiles();
        resolve();
        closeModal();
        resolve_1();
      });
      window.Main.send("settings:profile:add", "clipboard");
    };

    const match = !data.match(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    if (data.length < 2500 || match) {
      window.Main.send(
        "analytics:track",
        "profile:add:load_clipboard:error",
        JSON.stringify({ length: data.length, match }),
      );
      showModal({
        title: t("profiles.doesntLookLikeProfile"),
        body: t("profiles.doesntLookLikeProfileBody"),
        footer: (
          <>
            <CustomButton
              className={"mr-4"}
              color={"danger"}
              onPress={() => {
                closeModal();
                reject();
                reject_1();
              }}
            >
              {t("common.cancel")}
            </CustomButton>
            <CustomButton onPress={save}>
              {t("common.continue")}
            </CustomButton>
          </>
        ),
        onClose: () => {
          reject();
          reject_1();
        },
      });
    } else {
      save();
    }
  });
}}
```

- [ ] **Step 4: Verify that every lint finding is resolved**

Run: `bun run lint`

Expected: PASS with zero warnings and zero errors.

- [ ] **Step 5: Verify TypeScript and the Vite production bundle**

Run: `bun run build:vite`

Expected: PASS; TypeScript emits no diagnostics and Vite writes the frontend bundle to `dist`.

- [ ] **Step 6: Review and commit the source fixes**

Run: `git diff --check`

Expected: no whitespace errors.

```bash
git add src/pages/Matches.tsx src/pages/Friends.tsx src/pages/IPCTest.tsx src/components/riot-client-watcher.tsx src/components/button.tsx src/pages/SettingsProfiles.tsx src/components/live-game/use-live-game-assets.ts src/components/crosshair-svg-generator.tsx src/components/replay-viewer.tsx
git commit -m "fix: resolve oxlint findings"
```

### Task 3: Update Repository Guidance and Run Final Verification

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: The passing `bun run lint` command from Tasks 1 and 2.
- Produces: Accurate contributor instructions for frontend linting.

- [ ] **Step 1: Document the working command**

Replace:

```markdown
Note: `bun run lint` references eslint but eslint is not installed (pre-existing).
```

with:

```markdown
`bun run lint` runs Oxlint against the React and TypeScript frontend in `src/`.
```

- [ ] **Step 2: Run final verification**

Run:

```text
bun run lint
bun run build:vite
```

Expected: both commands exit with status 0.

- [ ] **Step 3: Confirm scope and preserve user changes**

Run: `git status --short` and `git diff --stat HEAD~2`

Expected: the Oxlint files match this plan; the pre-existing `.gitignore`, design-document, certificate-script, and `valoutils-certificate-status` changes remain uncommitted and untouched.

- [ ] **Step 4: Commit the documentation update**

```bash
git add CLAUDE.md
git commit -m "docs: document oxlint command"
```
