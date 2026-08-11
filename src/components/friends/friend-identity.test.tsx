import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as friendIdentityModule from "./friend-identity";

const identity = {
	gameName: "ALEKSANDAR",
	tagLine: "4830",
	displayName: "ALEKSANDAR#4830",
	note: "  我能架住  ",
};

const api = friendIdentityModule as typeof friendIdentityModule & {
  FriendIdentity?: (props: { person: typeof identity; showNote: boolean }) => ReactNode;
	matchesFriendSearch?: (person: typeof identity, search: string) => boolean;
	matchesFriendRequestSearch?: (person: typeof identity, search: string) => boolean;
};

describe("FriendIdentity", () => {
	test("renders a trimmed Riot note as an outlined pill", () => {
		expect(api.FriendIdentity).toBeDefined();
		if (!api.FriendIdentity) return;
		const FriendIdentity = api.FriendIdentity;
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
		expect(api.FriendIdentity).toBeDefined();
		if (!api.FriendIdentity) return;
		const FriendIdentity = api.FriendIdentity;
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
		expect(api.matchesFriendSearch).toBeDefined();
		if (!api.matchesFriendSearch) return;
		expect(api.matchesFriendSearch(identity, "aleks")).toBe(true);
		expect(api.matchesFriendSearch(identity, "我能")).toBe(true);
		expect(api.matchesFriendSearch(identity, "missing")).toBe(false);
	});

	test("does not search friend-request notes", () => {
		expect(api.matchesFriendRequestSearch).toBeDefined();
		if (!api.matchesFriendRequestSearch) return;
		expect(api.matchesFriendRequestSearch(identity, "aleks")).toBe(true);
		expect(api.matchesFriendRequestSearch(identity, "我能")).toBe(false);
	});
});
