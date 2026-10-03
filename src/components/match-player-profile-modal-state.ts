import { invoke } from "@tauri-apps/api/core";
import type { FriendProfileData, FriendProfileResponse } from "@/types/friend-profile";
import { acceptedFriendProfile } from "./friends/friend-profile-state";

export type MatchPlayerProfileErrorCode = "invalidPlayer" | "loginRequired" | "unavailable" | "malformed" | "rateLimited";
type MatchPlayerProfileCallbacks = {
  onProfile: (profile: FriendProfileData) => void;
  onError: (code: MatchPlayerProfileErrorCode, detail?: string, retryInSeconds?: number | null) => void;
};

export const subscribeMatchPlayerProfile = (
  puuid: string,
  callbacks: MatchPlayerProfileCallbacks,
  request: (puuid: string) => Promise<FriendProfileResponse> = (id) => invoke("friend_profile_get", { args: [id] }),
) => {
  let active = true;
  request(puuid).then(response => {
    if (!active) return;
    active = false;
    const accepted = acceptedFriendProfile(puuid, response);
    if (accepted) callbacks.onProfile(accepted);
    else if (!response.success) callbacks.onError(response.code, response.error, response.code === "rateLimited" ? response.retryInSeconds : undefined);
    else callbacks.onError("malformed");
  }).catch(error => {
    if (!active) return;
    active = false;
    callbacks.onError("unavailable", String(error));
  });
  return () => { active = false; };
};
