# Hide ValoUtils Bot on Friends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide `ValoUtils Bot#BOT` only from the Friends tab and publish the result as `v1.0.5`.

**Architecture:** Export a pure Friends-page predicate for the exact Riot identity and derive one filtered roster before every Friends-page consumer. Keep backend and Chat data unchanged. Release by updating only the four canonical version files because unrelated worktree changes must remain untouched.

**Tech Stack:** React 19, TypeScript 6, Bun test, Tauri 2, Git.

## Global Constraints

- Work directly on the current `master` checkout.
- Preserve and never stage unrelated dirty or untracked files.
- Match `gameName` and `tagLine` case-insensitively after trimming.
- Hide only when both fields equal `ValoUtils Bot` and `BOT`.
- Do not change Chat or Rust friend responses.
- Release version is exactly `1.0.5`; annotated tag is exactly `v1.0.5`.

---

### Task 1: Friends-only roster filter

**Files:**
- Modify: `src/pages/Friends.tsx`
- Create: `src/pages/friends-list.test.ts`

**Interfaces:**
- Produces: `isVisibleFriend(friend: Pick<Friend, "gameName" | "tagLine">): boolean`.
- Consumes: the successful `friends:get` roster in the Friends page only.

- [ ] **Step 1: Write the failing identity test**

```ts
import { describe, expect, test } from "bun:test";
import { isVisibleFriend } from "./Friends";

describe("Friends visible roster", () => {
  test("hides only ValoUtils Bot#BOT", () => {
    expect(isVisibleFriend({ gameName: "ValoUtils Bot", tagLine: "BOT" })).toBe(false);
    expect(isVisibleFriend({ gameName: " valoutils bot ", tagLine: " bot " })).toBe(false);
    expect(isVisibleFriend({ gameName: "ValoUtils Bot", tagLine: "PLAYER" })).toBe(true);
    expect(isVisibleFriend({ gameName: "Another", tagLine: "BOT" })).toBe(true);
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test src/pages/friends-list.test.ts`

Expected: FAIL because `isVisibleFriend` is not exported.

- [ ] **Step 3: Implement the minimal filter**

```ts
export const isVisibleFriend = (friend: Pick<Friend, "gameName" | "tagLine">) =>
  friend.gameName.trim().toLowerCase() !== "valoutils bot" ||
  friend.tagLine.trim().toLowerCase() !== "bot";

const visibleFriends = useMemo(() => friends.filter(isVisibleFriend), [friends]);
```

Use `visibleFriends` for card IDs, search/grouping, total count, and selected-profile lookup. Do not change request lists or Chat files.

- [ ] **Step 4: Verify GREEN and regression coverage**

Run: `bun test src/pages/friends-list.test.ts tests/friend-notes-ui.test.ts tests/friend-profile-ui.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Build and commit**

Run: `bun run build:vite`

Expected: exit 0; existing Vite native-config and chunk-size warnings are acceptable.

```powershell
git add -- src/pages/Friends.tsx src/pages/friends-list.test.ts
git commit -m "fix: hide ValoUtils bot from friends"
```

### Task 2: Release v1.0.5

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Produces: matching application version `1.0.5`, annotated tag `v1.0.5`, and pushed `origin/master` plus tag.

- [ ] **Step 1: Run full pre-release verification**

Run: `bun test`

Expected: all tests PASS.

Run: `bun run build:vite`

Expected: exit 0.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: exit 0.

- [ ] **Step 2: Update only canonical version files**

Run the exported `updateVersionFiles(process.cwd(), "1.0.5")`, then:

Run: `bun run version:check 1.0.5`

Expected: `Version metadata matches 1.0.5`.

- [ ] **Step 3: Commit and tag the release**

```powershell
git add -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(release): v1.0.5"
git tag -a v1.0.5 -m "ValoUtils v1.0.5"
```

Verify the staged commit contains only the four version files and confirm unrelated dirty files remain unstaged.

- [ ] **Step 4: Push release**

Run: `git push origin HEAD:master --follow-tags`

Expected: `master` and annotated tag `v1.0.5` are accepted by `origin`.
