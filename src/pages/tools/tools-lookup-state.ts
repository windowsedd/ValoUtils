import type { FriendProfileData } from "@/types/friend-profile";

export type ToolsLookupErrorCode =
	| "invalidInput"
	| "playerNotFound"
	| "loginRequired"
	| "unavailable";

export type ToolsResolvedPlayer = {
	puuid: string;
	gameName: string;
	tagLine: string;
};

export type ToolsLookupState = {
	status: "idle" | "resolving" | "loadingProfile" | "ready";
	error: ToolsLookupErrorCode | null;
	player: ToolsResolvedPlayer | null;
	pendingPlayer: ToolsResolvedPlayer | null;
	profile: FriendProfileData | null;
};

const settledStatus = (state: ToolsLookupState): ToolsLookupState["status"] =>
	state.player && state.profile ? "ready" : "idle";

export const initialToolsLookupState = (): ToolsLookupState => ({
	status: "idle",
	error: null,
	player: null,
	pendingPlayer: null,
	profile: null,
});

export const beginToolsLookup = (state: ToolsLookupState): ToolsLookupState => ({
	...state,
	status: "resolving",
	error: null,
	pendingPlayer: null,
});

export const applyToolsResolveSuccess = (
	state: ToolsLookupState,
	player: ToolsResolvedPlayer,
): ToolsLookupState => ({
	...state,
	status: "loadingProfile",
	error: null,
	pendingPlayer: player,
});

export const applyToolsResolveError = (
	state: ToolsLookupState,
	error: ToolsLookupErrorCode,
): ToolsLookupState => ({
	...state,
	status: settledStatus(state),
	error,
	pendingPlayer: null,
});

export const applyToolsProfileSuccess = (
	state: ToolsLookupState,
	profile: FriendProfileData,
): ToolsLookupState => ({
	...state,
	status: "ready",
	error: null,
	player: state.pendingPlayer ?? state.player,
	pendingPlayer: null,
	profile,
});

export const applyToolsProfileError = (
	state: ToolsLookupState,
	error: ToolsLookupErrorCode,
): ToolsLookupState => ({
	...state,
	status: settledStatus(state),
	error,
	pendingPlayer: null,
});
