import { describe, expect, test } from "bun:test";
import type { FriendProfileData, FriendProfileResponse } from "@/types/friend-profile";
import { acceptedFriendProfile } from "./friend-profile-state";

const profile: FriendProfileData = {
	currentTier: 22,
	currentRR: 64,
	peakTier: 23,
	peakSeasonId: "old",
	currentSeasonId: "current",
	competitiveSeasons: [],
	matches: [],
};

describe("friend profile response state", () => {
	test("accepts only a successful response for the requested friend", () => {
		const response: FriendProfileResponse = { success: true, puuid: "friend-a", profile };
		expect(acceptedFriendProfile("friend-a", response)).toBe(profile);
		expect(acceptedFriendProfile("friend-b", response)).toBeNull();
	});

	test("does not cache failed responses", () => {
		const response: FriendProfileResponse = {
			success: false,
			code: "unavailable",
			error: "Private data",
		};
		expect(acceptedFriendProfile("friend-a", response)).toBeNull();
	});
});
