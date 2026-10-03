import { invoke } from "@tauri-apps/api/core";
import type { RiotClientInfo, TokensResponse } from "@/types/riot-client";
import type { SettingsResponse } from "@/types/settings";

export const getInfo = () => invoke<RiotClientInfo>("client_info_get");
export const getTokens = () => invoke<TokensResponse>("tokens_get");
export const getSettings = () => invoke<SettingsResponse>("settings_get");
