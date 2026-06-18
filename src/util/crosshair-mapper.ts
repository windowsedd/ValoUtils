import type { CrosshairSettings, LineSettings, PrimarySettings, SniperSettings } from "@/components/crosshair-svg-generator";

interface RiotColor {
    r: number;
    g: number;
    b: number;
    a?: number;
}

interface RiotLineSettings {
    lineThickness: number;
    lineLength: number;
    lineLengthVertical: number;
    bAllowVertScaling: boolean;
    lineOffset: number;
    bShowMovementError: boolean;
    bShowShootingError: boolean;
    opacity: number;
    bShowLines: boolean;
    firingErrorScale: number;
    movementErrorScale: number;
}

interface RiotPrimarySettings {
    color: RiotColor;
    colorCustom: RiotColor;
    bUseCustomColor: boolean;
    bHasOutline: boolean;
    outlineThickness: number;
    outlineOpacity: number;
    centerDotSize: number;
    centerDotOpacity: number;
    bDisplayCenterDot: boolean;
    bFadeCrosshairWithFiringError: boolean;
    bFixMinErrorAcrossWeapons: boolean;
    innerLines: RiotLineSettings;
    outerLines: RiotLineSettings;
}

interface RiotSniperSettings {
    centerDotColor: RiotColor;
    centerDotColorCustom: RiotColor;
    bUseCustomCenterDotColor: boolean;
    centerDotSize: number;
    centerDotOpacity: number;
    bDisplayCenterDot: boolean;
}

export interface RiotCrosshairProfile {
    primary: RiotPrimarySettings;
    aDS: RiotPrimarySettings;
    sniper: RiotSniperSettings;
    bUsePrimaryCrosshairForADS: boolean;
    bUseCustomCrosshairOnAllPrimary: boolean;
    bUseAdvancedOptions: boolean;
    profileName: string;
}

function toHex(value: number): string {
    return Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0").toUpperCase();
}

function colorToHex(color?: RiotColor): string {
    if (!color) return "FFFFFF";
    return `${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function mapLine(line: RiotLineSettings): LineSettings {
    return {
        b: line.bShowLines,
        a: line.opacity,
        l: line.lineLength,
        v: line.lineLengthVertical,
        g: line.bAllowVertScaling,
        t: line.lineThickness,
        o: line.lineOffset,
        m: line.bShowMovementError,
        s: line.movementErrorScale,
        f: line.bShowShootingError,
        e: line.firingErrorScale,
    };
}

function mapPrimary(primary: RiotPrimarySettings): PrimarySettings {
    const color = primary.bUseCustomColor ? primary.colorCustom : primary.color;
    return {
        c: 8,
        u: colorToHex(color),
        h: primary.bHasOutline,
        o: primary.outlineOpacity,
        t: primary.outlineThickness,
        d: primary.bDisplayCenterDot,
        a: primary.centerDotOpacity,
        z: primary.centerDotSize,
        m: primary.bFixMinErrorAcrossWeapons,
        inner_lines: mapLine(primary.innerLines),
        outer_lines: mapLine(primary.outerLines),
    };
}

function mapSniper(sniper: RiotSniperSettings): SniperSettings {
    const color = sniper.bUseCustomCenterDotColor ? sniper.centerDotColorCustom : sniper.centerDotColor;
    return {
        d: sniper.bDisplayCenterDot,
        t: colorToHex(color),
        c: 8,
        s: sniper.centerDotSize,
        o: sniper.centerDotOpacity,
    };
}

/** Maps a single profile from Riot's `SavedCrosshairProfileData` into the shape used by the crosshair SVG generator. */
export function mapRiotCrosshairProfile(profile: RiotCrosshairProfile): CrosshairSettings {
    return {
        name: profile.profileName ?? "Crosshair Profile",
        override_all_primary_crosshairs_with_my_primary_crosshair: !!profile.bUseCustomCrosshairOnAllPrimary,
        use_advanced_options: !!profile.bUseAdvancedOptions,
        fade_crosshair_with_firing_error: !!profile.primary?.bFadeCrosshairWithFiringError,
        primary: mapPrimary(profile.primary),
        ads: mapPrimary(profile.aDS),
        ads_copy_primary: !!profile.bUsePrimaryCrosshairForADS,
        sniper: mapSniper(profile.sniper),
    };
}
