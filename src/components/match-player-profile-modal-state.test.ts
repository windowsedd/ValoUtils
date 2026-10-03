import { expect, test } from "bun:test";
import type { FriendProfileData, FriendProfileResponse } from "@/types/friend-profile";
import { subscribeMatchPlayerProfile } from "./match-player-profile-modal-state";

const profile: FriendProfileData = {
  currentTier: 18, currentRR: 42, rankShields: 1, peakTier: 20,
  peakSeasonId: "act-one", currentSeasonId: "act-two", competitiveSeasons: [], matches: [],
};
const deferred = () => {
  let resolve!: (value: FriendProfileResponse) => void;
  const promise = new Promise<FriendProfileResponse>(yes => { resolve = yes; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test("parallel profile requests receive only their own result, including failures", async () => {
  const a = deferred(), b = deferred();
  const loaded: FriendProfileData[] = [], errors: string[] = [];
  const request = (puuid: string) => puuid === "player-a" ? a.promise : b.promise;
  subscribeMatchPlayerProfile("player-a", { onProfile: value => loaded.push(value), onError: () => {} }, request);
  subscribeMatchPlayerProfile("player-b", { onProfile: () => {}, onError: code => errors.push(code) }, request);
  b.resolve({ success: false, code: "unavailable", error: "offline" });
  a.resolve({ success: true, puuid: "player-a", profile });
  await flush();
  expect(loaded).toEqual([profile]);
  expect(errors).toEqual(["unavailable"]);
});

test("cleanup ignores a late result and a transport rejection becomes an error", async () => {
  const late = deferred();
  const loaded: FriendProfileData[] = [], errors: string[] = [];
  const cleanup = subscribeMatchPlayerProfile("player-a", { onProfile: value => loaded.push(value), onError: code => errors.push(code) }, () => late.promise);
  cleanup();
  late.resolve({ success: true, puuid: "player-a", profile });
  subscribeMatchPlayerProfile("player-b", { onProfile: () => {}, onError: code => errors.push(code) }, () => Promise.reject("transport failed"));
  await flush();
  expect(loaded).toEqual([]);
  expect(errors).toEqual(["unavailable"]);
});
