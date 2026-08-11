# Friend Notes Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each accepted Riot friend's existing note as an outlined pill after their Riot ID and include that note in Friends search.

**Architecture:** Extract friend identity rendering and search matching from the large Friends page into one focused component module. The component trims and conditionally renders the read-only note pill; pure search helpers distinguish accepted friends from requests. `Friends.tsx` keeps polling and grouping behavior and only delegates identity rendering and matching.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS v4, Bun test runner

## Global Constraints

- Read notes only from the existing `Friend.note` field returned by `friends:get`.
- Add no IPC channel, write endpoint, local storage, translation string, icon, edit control, animation, or extra row height.
- Show notes for accepted friends in every Friends section and hide notes for friend requests.
- Use a transparent outlined pill with `border-white/10`, `text-gray-400`, `text-xs`, `rounded-full`, and compact horizontal padding.
- Trim note text, truncate overflow, and expose the full trimmed value in `title`.
- Keep existing friend-row click targets, focus rings, grouping, presence labels, and 10-second polling.

---

### Task 1: Add tested friend identity and search helpers

**Files:**
- Create: `src/components/friends/friend-identity.tsx`
- Create: `src/components/friends/friend-identity.test.tsx`

**Interfaces:**
- Consumes: identity fields `gameName`, `tagLine`, `displayName`, and `note` from `Friend` or `FriendRequest`.
- Produces: `FriendIdentity`, `matchesFriendSearch(friend, search)`, and `matchesFriendRequestSearch(request, search)`.

- [ ] **Step 1: Write failing component and search tests**

Create `friend-identity.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	FriendIdentity,
	matchesFriendRequestSearch,
	matchesFriendSearch,
} from "./friend-identity";

const identity = {
	gameName: "ALEKSANDAR",
	tagLine: "4830",
	displayName: "ALEKSANDAR#4830",
	note: "  我能架住  ",
};

describe("FriendIdentity", () => {
	test("renders a trimmed Riot note as an outlined pill", () => {
		const markup = renderToStaticMarkup(<FriendIdentity person={identity} showNote />);
		expect(markup).toContain("ALEKSANDAR");
		expect(markup).toContain("#4830");
		expect(markup).toContain('data-friend-note=""');
		expect(markup).toContain('title="我能架住"');
		expect(markup).toContain("rounded-full");
		expect(markup).toContain("border-white/10");
		expect(markup).toContain(">我能架住</span>");
	});

	test("omits empty notes and notes disabled for requests", () => {
		const empty = renderToStaticMarkup(
			<FriendIdentity person={{ ...identity, note: "   " }} showNote />,
		);
		const hidden = renderToStaticMarkup(<FriendIdentity person={identity} showNote={false} />);
		expect(empty).not.toContain("data-friend-note");
		expect(hidden).not.toContain("data-friend-note");
	});
});

describe("friend search", () => {
	test("matches accepted friends by Riot ID or note", () => {
		expect(matchesFriendSearch(identity, "aleks")).toBe(true);
		expect(matchesFriendSearch(identity, "我能")).toBe(true);
		expect(matchesFriendSearch(identity, "missing")).toBe(false);
	});

	test("does not search friend-request notes", () => {
		expect(matchesFriendRequestSearch(identity, "aleks")).toBe(true);
		expect(matchesFriendRequestSearch(identity, "我能")).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test and confirm RED**

```bash
bun test src/components/friends/friend-identity.test.tsx
```

Expected: FAIL because `friend-identity.tsx` does not exist.

- [ ] **Step 3: Implement the focused component and helpers**

Create `friend-identity.tsx`:

```tsx
import type { Friend, FriendRequest } from "@/types/friends";

type Identity = Pick<Friend | FriendRequest, "gameName" | "tagLine" | "displayName" | "note">;

const matches = (text: string, search: string) =>
	text.toLowerCase().includes(search.trim().toLowerCase());

export const matchesFriendSearch = (
	friend: Pick<Friend, "displayName" | "note">,
	search: string,
) => matches(`${friend.displayName} ${friend.note}`, search);

export const matchesFriendRequestSearch = (
	request: Pick<FriendRequest, "displayName">,
	search: string,
) => matches(request.displayName, search);

export const FriendIdentity = ({
	person,
	showNote,
}: {
	person: Identity;
	showNote: boolean;
}) => {
	const note = showNote ? person.note.trim() : "";
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<span className={`min-w-0 truncate ${note ? "max-w-[65%]" : "flex-1"}`}>
				{person.gameName ? (
					<>
						<span className="text-white">{person.gameName}</span>
						{person.tagLine && <span className="text-gray-600">#{person.tagLine}</span>}
					</>
				) : (
					<span className="text-gray-300">{person.displayName}</span>
				)}
			</span>
			{note && (
				<span
					data-friend-note=""
					title={note}
					className="min-w-0 max-w-[35%] shrink truncate rounded-full border border-white/10 px-2 py-0.5 text-xs font-normal text-gray-400"
				>
					{note}
				</span>
			)}
		</span>
	);
};
```

- [ ] **Step 4: Run the component test and confirm GREEN**

```bash
bun test src/components/friends/friend-identity.test.tsx
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit the isolated component**

```bash
git add src/components/friends/friend-identity.tsx src/components/friends/friend-identity.test.tsx
git commit -m "feat: render friend note tags"
```

---

### Task 2: Integrate notes into every accepted-friend row

**Files:**
- Modify: `src/pages/Friends.tsx`
- Test: `tests/friend-notes-ui.test.ts`

**Interfaces:**
- Consumes: `FriendIdentity`, `matchesFriendSearch`, and `matchesFriendRequestSearch` from Task 1.
- Produces: note pills in online, in-game, party, other-game, and offline accepted-friend rows; note-aware accepted-friend search; unchanged request rendering.

- [ ] **Step 1: Write a failing integration wiring test**

Create `tests/friend-notes-ui.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const friendsPage = readFileSync(join(import.meta.dir, "..", "src/pages/Friends.tsx"), "utf8");

describe("Friends note wiring", () => {
	test("uses note-aware search only for accepted friends", () => {
		expect(friendsPage).toContain("friends.filter((friend) => matchesFriendSearch(friend, search))");
		expect(friendsPage).toContain("matchesFriendRequestSearch(request, search)");
	});

	test("shows notes for accepted rows and hides them for requests", () => {
		expect(friendsPage).toContain("<FriendIdentity person={friend} showNote />");
		expect(friendsPage).toContain('showNote={"isOnline" in person}');
	});
});
```

- [ ] **Step 2: Run the integration test and confirm RED**

```bash
bun test tests/friend-notes-ui.test.ts
```

Expected: FAIL because `Friends.tsx` still defines `NameWithTag` and searches only `displayName`.

- [ ] **Step 3: Wire the component and search helpers into Friends**

Add the import:

```tsx
import {
	FriendIdentity,
	matchesFriendRequestSearch,
	matchesFriendSearch,
} from "@/components/friends/friend-identity";
```

Delete the local `NameWithTag` component and `matches` function. Update filtering:

```tsx
const visible = friends.filter((friend) => matchesFriendSearch(friend, search));
const incoming = requests.filter(
	(request) => request.direction === "incoming" && matchesFriendRequestSearch(request, search),
);
const outgoing = requests.filter(
	(request) => request.direction === "outgoing" && matchesFriendRequestSearch(request, search),
);
```

Use the identity component in the main friend row:

```tsx
<p className="min-w-0 text-sm font-semibold">
	<FriendIdentity person={friend} showNote />
</p>
```

Use it in `simpleRow`, where the runtime type check hides notes for requests and shows them for offline accepted friends:

```tsx
<p className="min-w-0 flex-1 text-sm">
	<FriendIdentity person={person} showNote={"isOnline" in person} />
</p>
```

- [ ] **Step 4: Run all Friend Notes tests**

```bash
bun test src/components/friends/friend-identity.test.tsx tests/friend-notes-ui.test.ts
```

Expected: 6 tests PASS.

- [ ] **Step 5: Run compiler and production build**

```bash
bunx tsc --noEmit
bun run build:vite
```

Expected: both commands exit 0. Vite may print the repository's existing native-config and bundle-size warnings.

- [ ] **Step 6: Commit the page integration**

```bash
git add src/pages/Friends.tsx tests/friend-notes-ui.test.ts
git commit -m "feat: show Riot notes in friends list"
```
