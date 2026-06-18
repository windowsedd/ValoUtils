import {
    BoolSetting,
    FloatSetting,
    IntSetting,
    KeybindMap,
    ParsedGameSettings,
    RawGameSettings,
    StringSetting,
} from "@/types/valorant-settings";

const BOOL_KEYS = new Set<string>(Object.values(BoolSetting));
const FLOAT_KEYS = new Set<string>(Object.values(FloatSetting));
const INT_KEYS = new Set<string>(Object.values(IntSetting));
const STRING_KEYS = new Set<string>(Object.values(StringSetting));

/**
 * Converts the raw decoded Ares.PlayerSettings JSON into a strongly-typed
 * ParsedGameSettings object. Unknown setting keys are collected separately
 * rather than silently dropped so callers can inspect them.
 */
export function parseGameSettings(raw: RawGameSettings): ParsedGameSettings {
    const bools: Partial<Record<BoolSetting, boolean>> = {};
    const unknownBools = [];
    for (const entry of raw.boolSettings ?? []) {
        if (BOOL_KEYS.has(entry.settingEnum)) {
            bools[entry.settingEnum as BoolSetting] = entry.value;
        } else {
            unknownBools.push(entry);
        }
    }

    const floats: Partial<Record<FloatSetting, number>> = {};
    const unknownFloats = [];
    for (const entry of raw.floatSettings ?? []) {
        if (FLOAT_KEYS.has(entry.settingEnum)) {
            floats[entry.settingEnum as FloatSetting] = entry.value;
        } else {
            unknownFloats.push(entry);
        }
    }

    const ints: Partial<Record<IntSetting, number>> = {};
    const unknownInts = [];
    for (const entry of raw.intSettings ?? []) {
        if (INT_KEYS.has(entry.settingEnum)) {
            ints[entry.settingEnum as IntSetting] = entry.value;
        } else {
            unknownInts.push(entry);
        }
    }

    const strings: Partial<Record<StringSetting, string>> = {};
    const unknownStrings = [];
    for (const entry of raw.stringSettings ?? []) {
        if (STRING_KEYS.has(entry.settingEnum)) {
            strings[entry.settingEnum as StringSetting] = entry.value;
        } else {
            unknownStrings.push(entry);
        }
    }

    const keybinds: KeybindMap = {};
    for (const mapping of raw.actionMappings ?? []) {
        if (!keybinds[mapping.name]) keybinds[mapping.name] = [];
        keybinds[mapping.name].push(mapping);
    }

    return {
        bools,
        floats,
        ints,
        strings,
        keybinds,
        profileData: raw.settingsProfileData ?? [],
        profileNames: raw.settingsProfiles ?? [],
        roamingVersion: raw.roamingSetttingsVersion ?? 0,
        unknown: {
            bools: unknownBools,
            floats: unknownFloats,
            ints: unknownInts,
            strings: unknownStrings,
        },
    };
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

export function getBool(settings: ParsedGameSettings, key: BoolSetting): boolean | undefined {
    return settings.bools[key];
}

export function getFloat(settings: ParsedGameSettings, key: FloatSetting): number | undefined {
    return settings.floats[key];
}

export function getInt(settings: ParsedGameSettings, key: IntSetting): number | undefined {
    return settings.ints[key];
}

export function getString(settings: ParsedGameSettings, key: StringSetting): string | undefined {
    return settings.strings[key];
}

/** Returns all bindings for a given action (across all characters and bind slots). */
export function getKeybinds(settings: ParsedGameSettings, actionName: string) {
    return settings.keybinds[actionName] ?? [];
}
