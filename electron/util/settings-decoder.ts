import { inflateRawSync } from "zlib";
import type { RawGameSettings } from "@/types/valorant-settings.ts";

/**
 * Decodes the base64+raw-deflate blob stored in `Ares.PlayerSettings` /
 * `profile.data` into the underlying settings JSON.
 */
export function decodeProfileData(data: string): RawGameSettings {
    const compressed = Buffer.from(data, "base64");
    const inflated = inflateRawSync(compressed);
    return JSON.parse(inflated.toString("utf-8")) as RawGameSettings;
}

export interface RiotCrosshairProfileData {
    currentProfile: number;
    profiles: any[];
}

/**
 * Pulls the `SavedCrosshairProfileData` string setting out of a decoded
 * settings object and parses its embedded JSON.
 */
export function extractCrosshairProfiles(decoded: RawGameSettings): RiotCrosshairProfileData | null {
    const entry = decoded?.stringSettings?.find(
        (s) => s.settingEnum === "EAresStringSettingName::SavedCrosshairProfileData"
    );
    if (!entry) {
        return null;
    }
    try {
        return JSON.parse(entry.value);
    } catch {
        return null;
    }
}
