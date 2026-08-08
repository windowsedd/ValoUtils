import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseGameSettings } from "@/util/settings-parser";
import { BoolSetting, FloatSetting, IntSetting, RawGameSettings } from "@/types/valorant-settings";
import { CrosshairSVG, generateCrosshair, SniperCrosshairSVG } from "@/components/crosshair-svg-generator";
import { mapRiotCrosshairProfile } from "@/util/crosshair-mapper";
import CustomButton from "@/components/button";

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------
// Keyboard key glyphs/abbreviations are universal — kept untranslated.

const KEY_LABELS: Record<string, string> = {
    None: "—",
    Zero: "0", One: "1", Two: "2", Three: "3", Four: "4",
    Five: "5", Six: "6", Seven: "7", Eight: "8", Nine: "9",
    MouseScrollUp: "Scroll Up",
    MouseScrollDown: "Scroll Down",
    ThumbMouseButton: "Mouse 4",
    ThumbMouseButton2: "Mouse 5",
    LeftMouseButton: "LMB",
    RightMouseButton: "RMB",
    MiddleMouseButton: "MMB",
    SpaceBar: "Space",
    LeftShift: "L Shift", RightShift: "R Shift",
    LeftControl: "L Ctrl", RightControl: "R Ctrl",
    LeftAlt: "L Alt", RightAlt: "R Alt",
    CapsLock: "Caps Lock",
    Tab: "Tab",
    BackSpace: "Backspace",
    Enter: "Enter",
    Escape: "Esc",
    F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5",
    F6: "F6", F7: "F7", F8: "F8", F9: "F9", F10: "F10",
    F11: "F11", F12: "F12",
    Tilde: "`",
    Minus: "-", Equals: "=",
    LeftBracket: "[", RightBracket: "]",
    Backslash: "\\", Semicolon: ";", Apostrophe: "'",
    Comma: ",", Period: ".", Slash: "/",
};

function fmtKey(key: string): string {
    if (!key || key === "None") return "—";
    return KEY_LABELS[key] ?? key;
}

// ---------------------------------------------------------------------------
// Row primitives
// ---------------------------------------------------------------------------

type TabId = "general" | "controls" | "crosshair" | "audio" | "video" | "raw";

const TAB_IDS: TabId[] = ["general", "controls", "crosshair", "audio", "video", "raw"];

function SectionHeader({ label }: { label: string }) {
    return (
        <div className="text-xs font-bold text-gray-500 uppercase tracking-[0.15em] pt-5 pb-1.5 px-3 first:pt-2">
            {label}
        </div>
    );
}

function ToggleRow({ label, value, note }: { label: string; value: boolean | undefined; note?: string }) {
    const { t } = useTranslation();
    if (value === undefined) return null;
    return (
        <div className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] rounded-sm">
            <div>
                <span className="text-sm text-gray-200">{label}</span>
                {note && <p className="text-xs text-gray-500 mt-0.5">{note}</p>}
            </div>
            <div className="flex gap-1 shrink-0">
                <span
                    className={`text-[11px] font-bold px-3 py-1 rounded-sm border tracking-wider ${
                        value
                            ? "bg-[#ff4655]/15 text-[#ff4655] border-[#ff4655]/40"
                            : "bg-white/5 text-gray-600 border-white/10"
                    }`}
                >
                    {t("settingsViewer.on")}
                </span>
                <span
                    className={`text-[11px] font-bold px-3 py-1 rounded-sm border tracking-wider ${
                        !value
                            ? "bg-white/10 text-white border-white/25"
                            : "bg-white/5 text-gray-600 border-white/10"
                    }`}
                >
                    {t("settingsViewer.off")}
                </span>
            </div>
        </div>
    );
}

function SliderRow({
    label, value, min = 0, max = 1, decimals = 2, unit = "",
}: {
    label: string; value: number | undefined; min?: number; max?: number; decimals?: number; unit?: string;
}) {
    if (value === undefined) return null;
    const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    return (
        <div className="flex items-center justify-between gap-4 px-3 py-2 hover:bg-white/[0.03] rounded-sm">
            <span className="text-sm text-gray-200 shrink-0">{label}</span>
            <div className="flex items-center gap-3 min-w-0 flex-1 max-w-52">
                <div className="relative flex-1 h-[3px] bg-white/10 rounded-full">
                    <div
                        className="absolute top-0 left-0 h-full bg-white/80 rounded-full"
                        style={{ width: `${pct}%` }}
                    />
                    <div
                        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-sm border border-white/40"
                        style={{ left: `calc(${pct}% - 6px)` }}
                    />
                </div>
                <span className="text-sm text-white font-mono w-14 text-right shrink-0">
                    {value.toFixed(decimals)}{unit}
                </span>
            </div>
        </div>
    );
}

function SelectRow({ label, value }: { label: string; value: string | undefined }) {
    if (value === undefined) return null;
    return (
        <div className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] rounded-sm">
            <span className="text-sm text-gray-200">{label}</span>
            <span className="text-sm text-white bg-white/8 border border-white/15 px-3 py-0.5 rounded-sm">
                {value}
            </span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// GENERAL tab
// ---------------------------------------------------------------------------

function GeneralTab({ settings }: { settings: ReturnType<typeof parseGameSettings> }) {
    const { t } = useTranslation();
    const colorBlindMode = settings.ints[IntSetting.ColorBlindMode];
    const mouseSensitivity = settings.floats[FloatSetting.MouseSensitivity];
    const minimapSize = settings.floats[FloatSetting.MinimapSize];
    const minimapZoom = settings.floats[FloatSetting.MinimapZoom];
    const minimapRotates = settings.bools[BoolSetting.MinimapRotates];
    const minimapTranslates = settings.bools[BoolSetting.MinimapTranslates];

    const colorBlindLabel = colorBlindMode === undefined
        ? undefined
        : colorBlindMode >= 0 && colorBlindMode <= 3
            ? t(`settingsViewer.colorBlind.${colorBlindMode}`)
            : t("settingsViewer.colorBlind.fallback", { mode: colorBlindMode });

    return (
        <div>
            <SectionHeader label={t("settingsViewer.general.accessibility")} />
            <SelectRow label={t("settingsViewer.general.enemyHighlightColor")} value={colorBlindLabel} />

            <SectionHeader label={t("settingsViewer.general.mouse")} />
            <SliderRow label={t("settingsViewer.general.sensitivityAim")} value={mouseSensitivity} min={0} max={2} decimals={2} />

            <SectionHeader label={t("settingsViewer.general.map")} />
            {minimapRotates !== undefined && (
                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] rounded-sm">
                    <span className="text-sm text-gray-200">{t("settingsViewer.general.rotate")}</span>
                    <div className="flex gap-1">
                        {([["rotate", "settingsViewer.general.optRotate"], ["fixed", "settingsViewer.general.optFixed"]] as const).map(([key, labelKey]) => {
                            const active = key === "rotate" ? minimapRotates : !minimapRotates;
                            return (
                                <span key={key} className={`text-[11px] font-bold px-3 py-1 rounded-sm border tracking-wider ${active ? "bg-white/10 text-white border-white/25" : "bg-white/5 text-gray-600 border-white/10"}`}>
                                    {t(labelKey)}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}
            {minimapTranslates !== undefined && (
                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] rounded-sm">
                    <span className="text-sm text-gray-200">{t("settingsViewer.general.fixedOrientation")}</span>
                    <div className="flex gap-1">
                        {([["alwaysSame", "settingsViewer.general.optAlwaysSame"], ["basedOnSide", "settingsViewer.general.optBasedOnSide"]] as const).map(([key, labelKey]) => {
                            const active = key === "alwaysSame" ? !minimapTranslates : minimapTranslates;
                            return (
                                <span key={key} className={`text-[11px] font-bold px-3 py-1 rounded-sm border tracking-wider ${active ? "bg-white/10 text-white border-white/25" : "bg-white/5 text-gray-600 border-white/10"}`}>
                                    {t(labelKey)}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}
            <SliderRow label={t("settingsViewer.general.minimapSize")} value={minimapSize} min={0.6} max={2} decimals={2} />
            <SliderRow label={t("settingsViewer.general.minimapZoom")} value={minimapZoom} min={0.6} max={1.1} decimals={2} />

            <SectionHeader label={t("settingsViewer.general.gameplay")} />
            <ToggleRow label={t("settingsViewer.general.showCorpses")} value={settings.bools[BoolSetting.ShowCorpses]} />
            <ToggleRow label={t("settingsViewer.general.autoEquipStrongest")} value={settings.bools[BoolSetting.AutoEquipPrioritizeStrongest]} />
            <ToggleRow label={t("settingsViewer.general.autoEquipSkipsMelee")} value={settings.bools[BoolSetting.AutoEquipSkipsMelee]} />
            <ToggleRow label={t("settingsViewer.general.showFinalStats")} value={settings.bools[BoolSetting.ShowFinalStatsInScoreboard]} />
            <ToggleRow label={t("settingsViewer.general.spectatorCount")} value={settings.bools[BoolSetting.SpectatorCountWidgetVisible]} />
            <ToggleRow label={t("settingsViewer.general.showKeyboardShortcuts")} value={settings.bools[BoolSetting.ShowKeyboardShortcutsOnButtons]} />

            {settings.profileNames.length > 0 && (
                <>
                    <SectionHeader label={t("settingsViewer.general.settingsProfiles")} />
                    {settings.profileData.map((p, i) => (
                        <SelectRow key={i} label={t("settingsViewer.general.slot", { index: p.presetIndex })} value={p.profileName} />
                    ))}
                </>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// CONTROLS tab
// ---------------------------------------------------------------------------

function ControlsTab({ settings }: { settings: ReturnType<typeof parseGameSettings> }) {
    const { t } = useTranslation();
    // Separate global (None) bindings from character-specific
    const globalBindings: Record<string, { primary?: string; secondary?: string }> = {};
    const agentBindings: Record<string, Record<string, { primary?: string; secondary?: string }>> = {};

    for (const [action, mappings] of Object.entries(settings.keybinds)) {
        for (const m of mappings) {
            if (m.characterName === "None") {
                if (!globalBindings[action]) globalBindings[action] = {};
                if (m.bindIndex === 0) globalBindings[action].primary = m.key;
                else globalBindings[action].secondary = m.key;
            } else {
                if (!agentBindings[m.characterName]) agentBindings[m.characterName] = {};
                if (!agentBindings[m.characterName][action]) agentBindings[m.characterName][action] = {};
                if (m.bindIndex === 0) agentBindings[m.characterName][action].primary = m.key;
                else agentBindings[m.characterName][action].secondary = m.key;
            }
        }
    }

    const BindingRow = ({ action, binds }: { action: string; binds: { primary?: string; secondary?: string } }) => (
        <div className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] rounded-sm">
            <span className="text-sm text-gray-200">{t(`settingsViewer.actions.${action}`, action)}</span>
            <div className="flex gap-2">
                {[binds.primary, binds.secondary].map((k, i) => (
                    <span
                        key={i}
                        className={`text-xs font-mono px-3 py-0.5 rounded-sm border min-w-12 text-center ${
                            k && k !== "None"
                                ? "bg-white/10 text-white border-white/20"
                                : "bg-white/3 text-gray-600 border-white/8"
                        }`}
                    >
                        {fmtKey(k ?? "None")}
                    </span>
                ))}
            </div>
        </div>
    );

    return (
        <div>
            <SectionHeader label={t("settingsViewer.controls.globalKeybinds")} />
            <div className="flex justify-end gap-2 px-3 pb-1">
                <span className="text-[10px] text-gray-500 w-12 text-center">{t("settingsViewer.controls.key1")}</span>
                <span className="text-[10px] text-gray-500 w-12 text-center">{t("settingsViewer.controls.key2")}</span>
            </div>
            {Object.keys(globalBindings).length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">{t("settingsViewer.controls.noGlobalBindings")}</p>
            ) : (
                Object.entries(globalBindings).map(([action, binds]) => (
                    <BindingRow key={action} action={action} binds={binds} />
                ))
            )}

            {Object.entries(agentBindings).map(([agent, bindings]) => (
                <div key={agent}>
                    <SectionHeader label={t("settingsViewer.controls.agentOverrides", { agent })} />
                    {Object.entries(bindings).map(([action, binds]) => (
                        <BindingRow key={action} action={action} binds={binds} />
                    ))}
                </div>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// CROSSHAIR tab
// ---------------------------------------------------------------------------

function CrosshairTab({
    crosshairData,
}: {
    crosshairData: { currentProfile: number; profiles: any[] } | null;
}) {
    const { t } = useTranslation();
    const [selectedIndex, setSelectedIndex] = useState(crosshairData?.currentProfile ?? 0);
    const profiles = crosshairData?.profiles ?? [];
    const selectedProfile = profiles[selectedIndex];
    const mapped = selectedProfile ? mapRiotCrosshairProfile(selectedProfile) : null;

    if (profiles.length === 0) {
        return <p className="text-center text-gray-400 py-8">{t("settingsViewer.crosshair.noProfiles")}</p>;
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-center gap-2">
                <label htmlFor="ch-profile-select" className="text-sm text-gray-400">
                    {t("settingsViewer.crosshair.profile")}
                </label>
                <select
                    id="ch-profile-select"
                    className="glass px-3 py-1.5 rounded-md bg-transparent text-white text-sm"
                    value={selectedIndex}
                    onChange={(e) => setSelectedIndex(Number(e.target.value))}
                >
                    {profiles.map((p, i) => (
                        <option key={i} value={i} className="bg-black">
                            {p.profileName || t("settingsViewer.crosshair.profileFallback", { index: i + 1 })}
                            {i === crosshairData?.currentProfile ? ` ${t("settingsViewer.crosshair.active")}` : ""}
                        </option>
                    ))}
                </select>
            </div>

            {mapped && (
                <>
                    <h3 className="text-base font-semibold text-center gradient-text">{mapped.name}</h3>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="glass p-3 flex flex-col items-center gap-2">
                            <span className="text-xs text-gray-400">{t("settingsViewer.crosshair.primary")}</span>
                            <CrosshairSVG settings={mapped.primary} width={120} height={120} backgroundColor="#00000066" />
                        </div>
                        <div className="glass p-3 flex flex-col items-center gap-2">
                            <span className="text-xs text-gray-400">{t("settingsViewer.crosshair.sniper")}</span>
                            <SniperCrosshairSVG settings={mapped.sniper} width={120} height={120} backgroundColor="#00000066" />
                        </div>
                    </div>
                    <CustomButton
                        onClickLoading={() =>
                            new Promise<void>((resolve, reject) => {
                                if (window.Main) {
                                    window.Main.send("clipboard:set", generateCrosshair(mapped));
                                    resolve();
                                } else {
                                    reject("No window.Main");
                                }
                            })
                        }
                    >
                        {t("settingsViewer.crosshair.copyCode")}
                    </CustomButton>
                </>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// AUDIO tab
// ---------------------------------------------------------------------------

function AudioTab({ settings }: { settings: ReturnType<typeof parseGameSettings> }) {
    const { t } = useTranslation();
    const micVolume = settings.ints[IntSetting.MicVolume];
    const voiceVolume = settings.ints[IntSetting.VoiceVolume];
    const micSensitivity = settings.ints[IntSetting.MicSensitivityThreshold];

    return (
        <div>
            <SectionHeader label={t("settingsViewer.audio.master")} />
            <SliderRow label={t("settingsViewer.audio.overallVolume")} value={settings.floats[FloatSetting.OverallVolume]} min={0} max={1} decimals={2} />

            <SectionHeader label={t("settingsViewer.audio.music")} />
            <SliderRow label={t("settingsViewer.audio.musicVolume")} value={settings.floats[FloatSetting.AllMusicOverallVolume]} min={0} max={1} decimals={2} />
            <ToggleRow label={t("settingsViewer.audio.muteMusicUnfocused")} value={settings.bools[BoolSetting.MuteMusicOnAppWindowDeactivate]} />

            <SectionHeader label={t("settingsViewer.audio.voiceOver")} />
            <SliderRow label={t("settingsViewer.audio.voiceOverVolume")} value={settings.floats[FloatSetting.VoiceOverVolume]} min={0} max={1} decimals={2} />

            <SectionHeader label={t("settingsViewer.audio.voiceChat")} />
            <ToggleRow label={t("settingsViewer.audio.pushToTalk")} value={settings.bools[BoolSetting.PushToTalkEnabled]} />
            <ToggleRow label={t("settingsViewer.audio.customPartyVoice")} value={settings.bools[BoolSetting.CustomPartyVoiceChatEnabled]} />
            <ToggleRow label={t("settingsViewer.audio.enableHRTF")} value={settings.bools[BoolSetting.EnableHRTF]} />
            <ToggleRow label={t("settingsViewer.audio.voiceDucksMusic")} value={settings.bools[BoolSetting.VoipDucksMusicVolume]} />
            {voiceVolume !== undefined && (
                <SliderRow label={t("settingsViewer.audio.incomingVolume")} value={voiceVolume} min={0} max={100} decimals={0} />
            )}

            <SectionHeader label={t("settingsViewer.audio.microphone")} />
            {micVolume !== undefined && (
                <SliderRow label={t("settingsViewer.audio.micVolume")} value={micVolume} min={0} max={100} decimals={0} />
            )}
            {micSensitivity !== undefined && (
                <SliderRow label={t("settingsViewer.audio.micSensitivity")} value={micSensitivity} min={0} max={100} decimals={0} />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// VIDEO tab (performance stats)
// ---------------------------------------------------------------------------

function VideoTab({ settings }: { settings: ReturnType<typeof parseGameSettings> }) {
    const { t } = useTranslation();
    const fpsMode = settings.ints[IntSetting.PlayerPerfShowFrameRate];
    const serverFpsMode = settings.ints[IntSetting.PlayerPerfShowServerFrameRate];
    const packetLossMode = settings.ints[IntSetting.PlayerPerfShowPacketLossPercentage];
    const cpuMode = settings.ints[IntSetting.PlayerPerfShowInputLatencyCpu];
    const rhiMode = settings.ints[IntSetting.PlayerPerfShowRHIPresentTime];
    const firingErrorsMode = settings.ints[IntSetting.PlayerPerfShowFiringErrors];

    const perfLabel = (mode: number | undefined) =>
        mode !== undefined ? t(`settingsViewer.perfDisplay.${mode}`) : undefined;

    return (
        <div>
            <SectionHeader label={t("settingsViewer.video.performanceStats")} />
            <p className="text-xs text-gray-500 px-3 pb-2">{t("settingsViewer.video.performanceStatsDesc")}</p>
            <SelectRow label={t("settingsViewer.video.clientFps")} value={perfLabel(fpsMode)} />
            <SelectRow label={t("settingsViewer.video.serverFrameRate")} value={perfLabel(serverFpsMode)} />
            <SelectRow label={t("settingsViewer.video.packetLoss")} value={perfLabel(packetLossMode)} />
            <SelectRow label={t("settingsViewer.video.inputLatencyCpu")} value={perfLabel(cpuMode)} />
            <SelectRow label={t("settingsViewer.video.rhiPresentTime")} value={perfLabel(rhiMode)} />
            <SelectRow label={t("settingsViewer.video.shootingErrors")} value={perfLabel(firingErrorsMode)} />

            {settings.unknown.ints.length > 0 && (
                <>
                    <SectionHeader label={t("settingsViewer.video.otherUnrecognized")} />
                    {settings.unknown.ints.map((s, i) => (
                        <SelectRow key={i} label={s.settingEnum.split("::")[1] ?? s.settingEnum} value={String(s.value)} />
                    ))}
                </>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

function RawJsonTab({ rawSettings }: { rawSettings: RawGameSettings }) {
    return (
        <pre className="text-xs text-gray-300 whitespace-pre-wrap break-all leading-relaxed p-3 font-mono">
            {JSON.stringify(rawSettings, null, 2)}
        </pre>
    );
}

export interface ParsedSettingsViewerProps {
    rawSettings: RawGameSettings;
    crosshairData: { currentProfile: number; profiles: any[] } | null;
}

export function ParsedSettingsViewer({ rawSettings, crosshairData }: ParsedSettingsViewerProps) {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<TabId>("general");
    const settings = useMemo(() => parseGameSettings(rawSettings), [rawSettings]);

    return (
        <div className="flex flex-col min-h-0">
            {/* Tab bar */}
            <div className="flex border-b border-white/10 mb-1 gap-0 shrink-0">
                {TAB_IDS.map((id) => (
                    <button
                        key={id}
                        onClick={() => setActiveTab(id)}
                        className={`relative px-4 py-2.5 text-xs font-bold tracking-[0.12em] transition-colors cursor-pointer ${
                            activeTab === id
                                ? "text-white"
                                : "text-gray-500 hover:text-gray-300"
                        }`}
                    >
                        {t(`settingsViewer.tabs.${id}`)}
                        {activeTab === id && (
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#ff4655]" />
                        )}
                    </button>
                ))}
            </div>

            {/* Tab content — scrollable */}
            <div className="overflow-y-auto max-h-130 pr-1">
                {activeTab === "general" && <GeneralTab settings={settings} />}
                {activeTab === "controls" && <ControlsTab settings={settings} />}
                {activeTab === "crosshair" && <CrosshairTab crosshairData={crosshairData} />}
                {activeTab === "audio" && <AudioTab settings={settings} />}
                {activeTab === "video" && <VideoTab settings={settings} />}
                {activeTab === "raw" && <RawJsonTab rawSettings={rawSettings} />}
            </div>
        </div>
    );
}
