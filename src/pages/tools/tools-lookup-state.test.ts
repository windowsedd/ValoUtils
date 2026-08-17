import { describe, expect, test } from "bun:test";
import type { FriendProfileData } from "@/types/friend-profile";
import {
	applyToolsProfileError,
	applyToolsProfileSuccess,
	applyToolsResolveError,
	applyToolsResolveSuccess,
	beginToolsLookup,
	initialToolsLookupState,
} from "./tools-lookup-state";

const profileA: FriendProfileData = {
	currentTier: 22,
	currentRR: 10,
	peakTier: 23,
	peakSeasonId: "old",
	currentSeasonId: "current",
	competitiveSeasons: [],
	matches: [],
};

const profileB: FriendProfileData = {
	...profileA,
	currentTier: 24,
	currentRR: 80,
};

const playerA = { puuid: "player-a", gameName: "TenZ", tagLine: "SEN" };
const playerB = { puuid: "player-b", gameName: "Asuna", tagLine: "100T" };

describe("tools player lookup state", () => {
	test("starts idle with no player or error", () => {
		expect(initialToolsLookupState()).toEqual({
			status: "idle",
			error: null,
			player: null,
			pendingPlayer: null,
			profile: null,
		});
	});

	test("keeps a previous successful profile while a new lookup is in flight", () => {
		const ready = applyToolsProfileSuccess(
			applyToolsResolveSuccess(beginToolsLookup(initialToolsLookupState()), playerA),
			profileA,
		);
		const searching = beginToolsLookup(ready);
		expect(searching.status).toBe("resolving");
		expect(searching.error).toBeNull();
		expect(searching.player).toEqual(playerA);
		expect(searching.profile).toBe(profileA);
	});

	test("shows resolve failures inline without clearing the last successful result", () => {
		const ready = applyToolsProfileSuccess(
			applyToolsResolveSuccess(beginToolsLookup(initialToolsLookupState()), playerA),
			profileA,
		);
		const failed = applyToolsResolveError(beginToolsLookup(ready), "playerNotFound");
		expect(failed.status).toBe("ready");
		expect(failed.error).toBe("playerNotFound");
		expect(failed.player).toEqual(playerA);
		expect(failed.profile).toBe(profileA);
		expect(failed.pendingPlayer).toBeNull();
	});

	test("commits a new player only after the profile request succeeds", () => {
		const ready = applyToolsProfileSuccess(
			applyToolsResolveSuccess(beginToolsLookup(initialToolsLookupState()), playerA),
			profileA,
		);
		const pending = applyToolsResolveSuccess(beginToolsLookup(ready), playerB);
		expect(pending.status).toBe("loadingProfile");
		expect(pending.player).toEqual(playerA);
		expect(pending.pendingPlayer).toEqual(playerB);
		expect(pending.profile).toBe(profileA);

		const failed = applyToolsProfileError(pending, "unavailable");
		expect(failed.status).toBe("ready");
		expect(failed.error).toBe("unavailable");
		expect(failed.player).toEqual(playerA);
		expect(failed.profile).toBe(profileA);
		expect(failed.pendingPlayer).toBeNull();

		const replaced = applyToolsProfileSuccess(pending, profileB);
		expect(replaced.status).toBe("ready");
		expect(replaced.error).toBeNull();
		expect(replaced.player).toEqual(playerB);
		expect(replaced.profile).toBe(profileB);
	});

	test("first-time failures stay empty and surface the error code", () => {
		const failed = applyToolsResolveError(
			beginToolsLookup(initialToolsLookupState()),
			"loginRequired",
		);
		expect(failed.status).toBe("idle");
		expect(failed.error).toBe("loginRequired");
		expect(failed.player).toBeNull();
		expect(failed.profile).toBeNull();
	});
});
