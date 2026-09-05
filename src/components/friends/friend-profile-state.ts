import type { FriendProfileData, FriendProfileResponse } from "@/types/friend-profile";

export const acceptedFriendProfile = (
  requestedPuuid: string,
  response: FriendProfileResponse,
): FriendProfileData | null =>
  response.success && response.puuid.toLowerCase() === requestedPuuid.toLowerCase()
    ? response.profile
    : null;
