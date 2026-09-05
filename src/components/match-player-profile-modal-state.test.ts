import { describe, expect, test } from "bun:test";
import type { FriendProfileData } from "@/types/friend-profile";
import {
  subscribeMatchPlayerProfile,
  type MatchPlayerProfileBridge,
} from "./match-player-profile-modal-state";

const profile: FriendProfileData = {
  currentTier: 18,
  currentRR: 42,
  peakTier: 20,
  peakSeasonId: "act-one",
  currentSeasonId: "act-two",
  competitiveSeasons: [],
  matches: [],
};

const fakeBridge = () => {
  let listener: ((message: string) => void) | undefined;
  const sent: unknown[][] = [];
  const removed: Array<(message: string) => void> = [];
  const bridge: MatchPlayerProfileBridge = {
    send: (...args) => sent.push(args),
    on: (_channel, callback) => {
      listener = callback;
    },
    removeListener: (_channel, callback) => {
      removed.push(callback);
    },
  };
  return { bridge, sent, removed, emit: (message: string) => listener?.(message) };
};

describe("match player profile request lifecycle", () => {
  test("requests the selected PUUID and accepts only its matching response", () => {
    const fake = fakeBridge();
    const loaded: FriendProfileData[] = [];
    const errors: string[] = [];
    subscribeMatchPlayerProfile(
      "player-a",
      {
        onProfile: (value) => loaded.push(value),
        onError: (code) => errors.push(code),
      },
      fake.bridge,
    );

    expect(fake.sent).toEqual([["friend:profile:get", "player-a"]]);
    fake.emit(JSON.stringify({ success: true, puuid: "player-b", profile }));
    expect(loaded).toEqual([]);
    fake.emit(JSON.stringify({ success: true, puuid: "player-a", profile }));
    expect(loaded).toEqual([profile]);
    expect(errors).toEqual([]);
    expect(fake.removed).toHaveLength(1);
  });

  test("reports malformed and backend error responses", () => {
    const malformed = fakeBridge();
    const malformedErrors: string[] = [];
    subscribeMatchPlayerProfile(
      "player-a",
      {
        onProfile: () => {},
        onError: (code) => malformedErrors.push(code),
      },
      malformed.bridge,
    );
    malformed.emit("not-json");
    expect(malformedErrors).toEqual(["malformed"]);

    const unavailable = fakeBridge();
    const backendErrors: string[] = [];
    subscribeMatchPlayerProfile(
      "player-a",
      {
        onProfile: () => {},
        onError: (code) => backendErrors.push(code),
      },
      unavailable.bridge,
    );
    unavailable.emit(JSON.stringify({ success: false, code: "unavailable", error: "offline" }));
    expect(backendErrors).toEqual(["unavailable"]);
  });

  test("removes its exact listener during cleanup", () => {
    const fake = fakeBridge();
    const cleanup = subscribeMatchPlayerProfile(
      "player-a",
      {
        onProfile: () => {},
        onError: () => {},
      },
      fake.bridge,
    );
    cleanup();
    expect(fake.removed).toHaveLength(1);
  });
});
