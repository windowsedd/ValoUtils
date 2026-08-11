import { describe, expect, test } from "bun:test";
import type { FriendMatch } from "@/types/friend-profile";
import { availableFriendQueues, filterFriendMatches } from "./friend-match-filter";

const match = (matchId: string, queueId: string): FriendMatch => ({
	matchId,
	startMillis: 0,
	queueId,
	tierBefore: null,
	tierAfter: null,
	rankedRatingAfter: null,
	rrEarned: null,
});

describe("friend match queue filter", () => {
	test("lists unique queues and keeps All Modes as the default", () => {
		const matches = [match("1", "competitive"), match("2", "unrated"), match("3", "competitive")];
		expect(availableFriendQueues(matches)).toEqual(["competitive", "unrated"]);
		expect(filterFriendMatches(matches, "all").map((item) => item.matchId)).toEqual(["1", "2", "3"]);
	});

	test("filters before limiting the result to fifteen matches", () => {
		const matches = Array.from({ length: 40 }, (_, index) => match(String(index), index % 2 ? "unrated" : "deathmatch"));
		const filtered = filterFriendMatches(matches, "unrated");
		expect(filtered).toHaveLength(15);
		expect(filtered.every((item) => item.queueId === "unrated")).toBe(true);
	});
});
