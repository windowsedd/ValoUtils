import type { FriendProfileData, FriendProfileResponse } from "@/types/friend-profile";
import { acceptedFriendProfile } from "./friends/friend-profile-state";

export type MatchPlayerProfileBridge = {
  send: (channel: string, ...args: unknown[]) => void;
  on: (channel: string, callback: (message: string) => void) => void;
  removeListener: (channel: string, callback: (message: string) => void) => void;
};

type MatchPlayerProfileCallbacks = {
  onProfile: (profile: FriendProfileData) => void;
  onError: (
    code: "invalidPlayer" | "loginRequired" | "unavailable" | "malformed",
    detail?: string,
  ) => void;
};

export const subscribeMatchPlayerProfile = (
  puuid: string,
  callbacks: MatchPlayerProfileCallbacks,
  bridge: MatchPlayerProfileBridge = window.Main,
) => {
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    bridge.removeListener("friend:profile:get", onResponse);
  };
  const onResponse = (message: string) => {
    if (!active) return;
    let response: FriendProfileResponse;
    try {
      response = JSON.parse(message) as FriendProfileResponse;
    } catch {
      cleanup();
      callbacks.onError("malformed");
      return;
    }

    const accepted = acceptedFriendProfile(puuid, response);
    if (accepted) {
      cleanup();
      callbacks.onProfile(accepted);
      return;
    }
    if (!response.success) {
      cleanup();
      callbacks.onError(response.code, response.error);
    }
  };

  bridge.on("friend:profile:get", onResponse);
  bridge.send("friend:profile:get", puuid);
  return cleanup;
};
