// Typed enums and interfaces for Valorant's Ares player settings format.
// Source structure: profile_settings.json (decoded from the Ares.PlayerSettings preference blob).

// ---------------------------------------------------------------------------
// Setting-name enums
// ---------------------------------------------------------------------------

export enum BoolSetting {
    AutoEquipPrioritizeStrongest      = "EAresBoolSettingName::AutoEquipPrioritizeStrongest",
    AutoEquipSkipsMelee               = "EAresBoolSettingName::AutoEquipSkipsMelee",
    ContextAwareModuleComplete        = "EAresBoolSettingName::ContextAwareModuleComplete",
    CrosshairDisplayCenterDot         = "EAresBoolSettingName::CrosshairDisplayCenterDot",
    CrosshairInnerLinesShowShootingError = "EAresBoolSettingName::CrosshairInnerLinesShowShootingError",
    CrosshairOuterLinesShowLines      = "EAresBoolSettingName::CrosshairOuterLinesShowLines",
    CustomPartyVoiceChatEnabled       = "EAresBoolSettingName::CustomPartyVoiceChatEnabled",
    EnableHRTF                        = "EAresBoolSettingName::EnableHRTF",
    FadeCrosshairWithFiringError      = "EAresBoolSettingName::FadeCrosshairWithFiringError",
    HasAcceptedCodeOfConduct          = "EAresBoolSettingName::HasAcceptedCodeOfConduct",
    HasEverAppliedRoamingSettings     = "EAresBoolSettingName::HasEverAppliedRoamingSettings",
    HasEverStartedAMatch              = "EAresBoolSettingName::HasEverStartedAMatch",
    HasSeenBTEModal                   = "EAresBoolSettingName::HasSeenBTEModal",
    HasSeenNewPlayerSettings          = "EAresBoolSettingName::HasSeenNewPlayerSettings",
    HasSeenPhotoSensitivityWarning    = "EAresBoolSettingName::HasSeenPhotoSensitivityWarning",
    HasSeenSettingsTutorial           = "EAresBoolSettingName::HasSeenSettingsTutorial",
    HasSeenTournamentsScreen          = "EAresBoolSettingName::HasSeenTournamentsScreen",
    MinimapRotates                    = "EAresBoolSettingName::MinimapRotates",
    MinimapTranslates                 = "EAresBoolSettingName::MinimapTranslates",
    MuteMusicOnAppWindowDeactivate    = "EAresBoolSettingName::MuteMusicOnAppWindowDeactivate",
    ObserversSeeBlinds                = "EAresBoolSettingName::ObserversSeeBlinds",
    PushToTalkEnabled                 = "EAresBoolSettingName::PushToTalkEnabled",
    ShootingRangeBotArmorEnabled      = "EAresBoolSettingName::ShootingRangeBotArmorEnabled",
    ShootingRangeBotStrafeEnabled     = "EAresBoolSettingName::ShootingRangeBotStrafeEnabled",
    ShowCorpses                       = "EAresBoolSettingName::ShowCorpses",
    ShowFinalStatsInScoreboard        = "EAresBoolSettingName::ShowFinalStatsInScoreboard",
    ShowKeyboardShortcutsOnButtons    = "EAresBoolSettingName::ShowKeyboardShortcutsOnButtons",
    SpectatorCountWidgetVisible       = "EAresBoolSettingName::SpectatorCountWidgetVisible",
    VoipDucksMusicVolume              = "EAresBoolSettingName::VoipDucksMusicVolume",
}

export enum FloatSetting {
    AllMusicOverallVolume              = "EAresFloatSettingName::AllMusicOverallVolume",
    CrosshairInnerLinesLineLength      = "EAresFloatSettingName::CrosshairInnerLinesLineLength",
    CrosshairInnerLinesLineLengthVertical = "EAresFloatSettingName::CrosshairInnerLinesLineLengthVertical",
    CrosshairInnerLinesLineOffset      = "EAresFloatSettingName::CrosshairInnerLinesLineOffset",
    GamepadBaseRotationSpeedX          = "EAresFloatSettingName::GamepadBaseRotationSpeedX",
    GamepadBaseRotationSpeedY          = "EAresFloatSettingName::GamepadBaseRotationSpeedY",
    GamepadLookStickInnerDeadzone      = "EAresFloatSettingName::GamepadLookStickInnerDeadzone",
    GamepadWalkStickInnerDeadzone      = "EAresFloatSettingName::GamepadWalkStickInnerDeadzone",
    MinimapSize                        = "EAresFloatSettingName::MinimapSize",
    MinimapZoom                        = "EAresFloatSettingName::MinimapZoom",
    MouseSensitivity                   = "EAresFloatSettingName::MouseSensitivity",
    ObserverRunSpeedModifier           = "EAresFloatSettingName::ObserverRunSpeedModifier",
    ObserverWalkSpeedModifier          = "EAresFloatSettingName::ObserverWalkSpeedModifier",
    OverallVolume                      = "EAresFloatSettingName::OverallVolume",
    VoiceOverVolume                    = "EAresFloatSettingName::VoiceOverVolume",
}

export enum IntSetting {
    ColorBlindMode                     = "EAresIntSettingName::ColorBlindMode",
    LastAcceptedCodeOfConductVersion   = "EAresIntSettingName::LastAcceptedCodeOfConductVersion",
    MicSensitivityThreshold            = "EAresIntSettingName::MicSensitivityThreshold",
    MicVolume                          = "EAresIntSettingName::MicVolume",
    PlayerPerfPresetInfo               = "EAresIntSettingName::PlayerPerfPresetInfo",
    PlayerPerfShowFiringErrors         = "EAresIntSettingName::PlayerPerfShowFiringErrors",
    PlayerPerfShowFrameRate            = "EAresIntSettingName::PlayerPerfShowFrameRate",
    PlayerPerfShowInputLatencyCpu      = "EAresIntSettingName::PlayerPerfShowInputLatencyCpu",
    PlayerPerfShowPacketLossPercentage = "EAresIntSettingName::PlayerPerfShowPacketLossPercentage",
    PlayerPerfShowRHIPresentTime       = "EAresIntSettingName::PlayerPerfShowRHIPresentTime",
    PlayerPerfShowServerFrameRate      = "EAresIntSettingName::PlayerPerfShowServerFrameRate",
    VoiceVolume                        = "EAresIntSettingName::VoiceVolume",
}

export enum StringSetting {
    CrosshairColor             = "EAresStringSettingName::CrosshairColor",
    CrosshairProfileName       = "EAresStringSettingName::CrosshairProfileName",
    LastSeenSeasonalPopup      = "EAresStringSettingName::LastSeenSeasonalPopup",
    PlayerPerfPresetType       = "EAresStringSettingName::PlayerPerfPresetType",
    SavedCrosshairProfileData  = "EAresStringSettingName::SavedCrosshairProfileData",
}

// ---------------------------------------------------------------------------
// Raw Riot wire shapes (as returned by the preference API before parsing)
// ---------------------------------------------------------------------------

export interface RawBoolSetting {
    settingEnum: string;
    value: boolean;
}

export interface RawFloatSetting {
    settingEnum: string;
    value: number;
}

export interface RawIntSetting {
    settingEnum: string;
    value: number;
}

export interface RawStringSetting {
    settingEnum: string;
    value: string;
}

/** A single key binding entry. bindIndex 0 = primary, 1 = secondary. */
export interface ActionMapping {
    alt: boolean;
    bindIndex: number;
    characterName: string;
    cmd: boolean;
    ctrl: boolean;
    key: string;
    name: string;
    shift: boolean;
    tapHoldType: string;
}

export interface SettingsProfileEntry {
    presetIndex: number;
    profileName: string;
}

/** The raw decoded settings object (output of inflating the Ares.PlayerSettings blob). */
export interface RawGameSettings {
    actionMappings: ActionMapping[];
    axisMappings: unknown[];
    boolSettings: RawBoolSetting[];
    floatSettings: RawFloatSetting[];
    intSettings: RawIntSetting[];
    stringSettings: RawStringSetting[];
    roamingSetttingsVersion: number;
    settingsProfileData: SettingsProfileEntry[];
    settingsProfiles: string[];
}

// ---------------------------------------------------------------------------
// Parsed / strongly-typed settings object
// ---------------------------------------------------------------------------

/** Key bindings grouped by action name, then by bindIndex. */
export type KeybindMap = Record<string, ActionMapping[]>;

export interface ParsedGameSettings {
    /** Boolean settings keyed by enum value. */
    bools: Partial<Record<BoolSetting, boolean>>;
    /** Float settings keyed by enum value. */
    floats: Partial<Record<FloatSetting, number>>;
    /** Integer settings keyed by enum value. */
    ints: Partial<Record<IntSetting, number>>;
    /** String settings keyed by enum value. */
    strings: Partial<Record<StringSetting, string>>;
    /** All keybinds, grouped by action name. */
    keybinds: KeybindMap;
    /** Settings profile metadata list. */
    profileData: SettingsProfileEntry[];
    /** Names of non-default settings profiles. */
    profileNames: string[];
    /** Roaming settings version number. */
    roamingVersion: number;
    /** Unknown settings whose keys weren't in the known enums. */
    unknown: {
        bools: RawBoolSetting[];
        floats: RawFloatSetting[];
        ints: RawIntSetting[];
        strings: RawStringSetting[];
    };
}
