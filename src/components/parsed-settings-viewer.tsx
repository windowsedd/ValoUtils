import { useMemo, useState } from "react";
import { parseGameSettings } from "@/util/settings-parser";
import { BoolSetting, FloatSetting, IntSetting, RawGameSettings } from "@/types/valorant-settings";
import { CrosshairSVG, generateCrosshair, SniperCrosshairSVG } from "@/components/crosshair-svg-generator";
import { mapRiotCrosshairProfile } from "@/util/crosshair-mapper";
import CustomButton from "@/components/button";

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

const COLOR_BLIND_LABELS: Record<number, string> = {
    0: "No (Default Red)",
    1: "Yellow (Deuteranopia)",
    2: "Blue (Tritanopia)",
    3: "Purple (Protanopia)",
};

const PERF_DISPLAY_LABELS: Record<number, string> = {
    0: "Off",
    1: "Text",
    2: "Graph",
    3: "Text + Graph",
};

const ACTION_LABELS: Record<string, string> = {
    Activate_Primary: "Equip Primary",
    Activate_Secondary: "Equip Secondary",
    Activate_Melee: "Equip Melee",
    Activate_Ability1: "Ability 1",
    Activate_Ability2: "Ability 2",
    Activate_Ability3: "Ability 3",
    Activate_Ultimate: "Ultimate",
    Jump: "Jump",
    Crouch: "Crouch",
    Walk: "Walk",
    Dash: "Dash",
    PrevWeapon: "Previous Weapon",
    NextWeapon: "Next Weapon",
    Ghost: "Ghost / Spectate",
    OpenBuyMenu: "Buy Menu",
    VOICE_TeamPTTAction: "Team Voice (PTT)",
    VOICE_PartyPTTAction: "Party Voice (PTT)",
    Interact: "Interact / Plant",
    Reload: "Reload",
    Inspect: "Inspect Weapon",
    Map: "Open Map",
    Scoreboard: "Scoreboard",
};

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

const TABS: { id: TabId; label: string }[] = [
    { id: "general", label: "GENERAL" },
    { id: "controls", label: "CONTROLS" },
    { id: "crosshair", label: "CROSSHAIR" },
    { id: "audio", label: "AUDIO" },
    { id: "video", label: "VIDEO" },
    { id: "raw", label: "RAW JSON" },
];

function SectionHeader({ label }: { label: string }) {
    return (
        <div className="text-xs font-bold text-gray-500 uppercase tracking-[0.15em] pt-5 pb-1.5 px-3 first:pt-2">
            {label}
        </div>
    );
}

function Divider() {
    return <div className="mx-3 border-t border-white/5" />;
}

function ToggleRow({ label, value, note }: { label: string; value: boolean | undefined; note?: string }) {
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
                    ON
                </span>
                <span
                    className={`text-[11px] font-bold px-3 py-1 rounded-sm border tracking-wider ${
                        !value
                            ? "bg-white/10 text-white border-white/25"
                            : "bg-white/5 text-gray-600 border-white/10"
                    }`}
                >
                    OFF
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

function IntValueRow({ label, value }: { label: string; value: number | undefined }) {
    if (value === undefined) return null;
    return (
        <div className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] rounded-sm">
            <span className="text-sm text-gray-200">{label}</span>
            <span className="text-sm font-mono text-white bg-white/8 border border-white/15 px-3 py-0.5 rounded-sm min-w-10 text-center">
                {value}
            </span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// GENERAL tab
// ---------------------------------------------------------------------------

function GeneralTab({ settings }: { settings: ReturnType<typeof parseGameSettings> }) {
    const colorBlindMode = settings.ints[IntSetting.ColorBlindMode];
    const mouseSensitivity = settings.floats[FloatSetting.MouseSensitivity];
    const minimapSize = settings.floats[FloatSetting.MinimapSize];
    const minimapZoom = settings.floats[FloatSetting.MinimapZoom];
    const minimapRotates = settings.bools[BoolSetting.MinimapRotates];
    const minimapTranslates = settings.bools[BoolSetting.MinimapTranslates];

    return (
        <div>
            <SectionHeader label="Accessibility" />
            <SelectRow
                label="Enemy Highlight Color"
                value={colorBlindMode !== undefined ? COLOR_BLIND_LABELS[colorBlindMode] ?? `Mode ${colorBlindMode}` : undefined}
            />

            <SectionHeader label="Mouse" />
            <SliderRow label="Sensitivity: Aim" value={mouseSensitivity} min={0} max={2} decimals={2} />

            <SectionHeader label="Map" />
            {minimapRotates !== undefined && (
                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] rounded-sm">
                    <span className="text-sm text-gray-200">Rotate</span>
                    <div className="flex gap-1">
                        {(["ROTATE", "FIXED"] as const).map((opt) => {
                            const active = opt === "ROTATE" ? minimapRotates : !minimapRotates;
                            return (
                                <span key={opt} className={`text-[11px] font-bold px-3 py-1 rounded-sm border tracking-wider ${active ? "bg-white/10 text-white border-white/25" : "bg-white/5 text-gray-600 border-white/10"}`}>
                                    {opt}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}
            {minimapTranslates !== undefined && (
                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] rounded-sm">
                    <span className="text-sm text-gray-200">Fixed Orientation</span>
                    <div className="flex gap-1">
                        {["ALWAYS THE SAME", "BASED ON SIDE"].map((opt, i) => {
                            const active = i === 0 ? !minimapTranslates : minimapTranslates;
                            return (
                                <span key={opt} className={`text-[11px] font-bold px-3 py-1 rounded-sm border tracking-wider ${active ? "bg-white/10 text-white border-white/25" : "bg-white/5 text-gray-600 border-white/10"}`}>
                                    {opt}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}
            <SliderRow label="Minimap Size" value={minimapSize} min={0.6} max={2} decimals={2} />
            <SliderRow label="Minimap Zoom" value={minimapZoom} min={0.6} max={1.1} decimals={2} />

            <SectionHeader label="Gameplay" />
            <ToggleRow label="Show Corpses" value={settings.bools[BoolSetting.ShowCorpses]} />
            <ToggleRow label="Auto-Equip Strongest Weapon" value={settings.bools[BoolSetting.AutoEquipPrioritizeStrongest]} />
            <ToggleRow label="Auto-Equip Skips Melee" value={settings.bools[BoolSetting.AutoEquipSkipsMelee]} />
            <ToggleRow label="Show Final Stats in Scoreboard" value={settings.bools[BoolSetting.ShowFinalStatsInScoreboard]} />
            <ToggleRow label="Spectator Count Widget" value={settings.bools[BoolSetting.SpectatorCountWidgetVisible]} />
            <ToggleRow label="Show Keyboard Shortcuts" value={settings.bools[BoolSetting.ShowKeyboardShortcutsOnButtons]} />

            {settings.profileNames.length > 0 && (
                <>
                    <SectionHeader label="Settings Profiles" />
                    {settings.profileData.map((p, i) => (
                        <SelectRow key={i} label={`Slot ${p.presetIndex}`} value={p.profileName} />
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
            <span className="text-sm text-gray-200">{ACTION_LABELS[action] ?? action}</span>
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
            <SectionHeader label="Global Keybinds" />
            <div className="flex justify-end gap-2 px-3 pb-1">
                <span className="text-[10px] text-gray-500 w-12 text-center">KEY 1</span>
                <span className="text-[10px] text-gray-500 w-12 text-center">KEY 2</span>
            </div>
            {Object.keys(globalBindings).length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">No global bindings found.</p>
            ) : (
                Object.entries(globalBindings).map(([action, binds]) => (
                    <BindingRow key={action} action={action} binds={binds} />
                ))
            )}

            {Object.entries(agentBindings).map(([agent, bindings]) => (
                <div key={agent}>
                    <SectionHeader label={`${agent} (Agent Overrides)`} />
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
    const [selectedIndex, setSelectedIndex] = useState(crosshairData?.currentProfile ?? 0);
    const profiles = crosshairData?.profiles ?? [];
    const selectedProfile = profiles[selectedIndex];
    const mapped = selectedProfile ? mapRiotCrosshairProfile(selectedProfile) : null;

    if (profiles.length === 0) {
        return <p className="text-center text-gray-400 py-8">No crosshair profiles found.</p>;
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-center gap-2">
                <label htmlFor="ch-profile-select" className="text-sm text-gray-400">
                    Profile
                </label>
                <select
                    id="ch-profile-select"
                    className="glass px-3 py-1.5 rounded-md bg-transparent text-white text-sm"
                    value={selectedIndex}
                    onChange={(e) => setSelectedIndex(Number(e.target.value))}
                >
                    {profiles.map((p, i) => (
                        <option key={i} value={i} className="bg-black">
                            {p.profileName || `Profile ${i + 1}`}
                            {i === crosshairData?.currentProfile ? " (active)" : ""}
                        </option>
                    ))}
                </select>
            </div>

            {mapped && (
                <>
                    <h3 className="text-base font-semibold text-center gradient-text">{mapped.name}</h3>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="glass p-3 flex flex-col items-center gap-2">
                            <span className="text-xs text-gray-400">Primary</span>
                            <CrosshairSVG settings={mapped.primary} width={120} height={120} backgroundColor="#00000066" />
                        </div>
                        <div className="glass p-3 flex flex-col items-center gap-2">
                            <span className="text-xs text-gray-400">Sniper</span>
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
                        Copy Crosshair Code
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
    const micVolume = settings.ints[IntSetting.MicVolume];
    const voiceVolume = settings.ints[IntSetting.VoiceVolume];
    const micSensitivity = settings.ints[IntSetting.MicSensitivityThreshold];

    return (
        <div>
            <SectionHeader label="Master" />
            <SliderRow label="Overall Volume" value={settings.floats[FloatSetting.OverallVolume]} min={0} max={1} decimals={2} />

            <SectionHeader label="Music" />
            <SliderRow label="Music Volume" value={settings.floats[FloatSetting.AllMusicOverallVolume]} min={0} max={1} decimals={2} />
            <ToggleRow label="Mute Music When Game Unfocused" value={settings.bools[BoolSetting.MuteMusicOnAppWindowDeactivate]} />

            <SectionHeader label="Voice-Over" />
            <SliderRow label="Voice-Over Volume" value={settings.floats[FloatSetting.VoiceOverVolume]} min={0} max={1} decimals={2} />

            <SectionHeader label="Voice Chat" />
            <ToggleRow label="Push To Talk" value={settings.bools[BoolSetting.PushToTalkEnabled]} />
            <ToggleRow label="Custom Party Voice Chat" value={settings.bools[BoolSetting.CustomPartyVoiceChatEnabled]} />
            <ToggleRow label="Enable HRTF (Spatial Audio)" value={settings.bools[BoolSetting.EnableHRTF]} />
            <ToggleRow label="Voice Chat Ducks Music" value={settings.bools[BoolSetting.VoipDucksMusicVolume]} />
            {voiceVolume !== undefined && (
                <SliderRow label="Incoming Volume" value={voiceVolume} min={0} max={100} decimals={0} />
            )}

            <SectionHeader label="Microphone" />
            {micVolume !== undefined && (
                <SliderRow label="Mic Volume" value={micVolume} min={0} max={100} decimals={0} />
            )}
            {micSensitivity !== undefined && (
                <SliderRow label="Mic Sensitivity Threshold" value={micSensitivity} min={0} max={100} decimals={0} />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// VIDEO tab (performance stats)
// ---------------------------------------------------------------------------

function VideoTab({ settings }: { settings: ReturnType<typeof parseGameSettings> }) {
    const fpsMode = settings.ints[IntSetting.PlayerPerfShowFrameRate];
    const serverFpsMode = settings.ints[IntSetting.PlayerPerfShowServerFrameRate];
    const packetLossMode = settings.ints[IntSetting.PlayerPerfShowPacketLossPercentage];
    const cpuMode = settings.ints[IntSetting.PlayerPerfShowInputLatencyCpu];
    const rhiMode = settings.ints[IntSetting.PlayerPerfShowRHIPresentTime];
    const firingErrorsMode = settings.ints[IntSetting.PlayerPerfShowFiringErrors];

    return (
        <div>
            <SectionHeader label="Performance Stats" />
            <p className="text-xs text-gray-500 px-3 pb-2">Controls which stats are shown as text, graph, or both.</p>
            <SelectRow label="Client FPS" value={fpsMode !== undefined ? PERF_DISPLAY_LABELS[fpsMode] : undefined} />
            <SelectRow label="Server Frame Rate" value={serverFpsMode !== undefined ? PERF_DISPLAY_LABELS[serverFpsMode] : undefined} />
            <SelectRow label="Packet Loss %" value={packetLossMode !== undefined ? PERF_DISPLAY_LABELS[packetLossMode] : undefined} />
            <SelectRow label="Input Latency (CPU)" value={cpuMode !== undefined ? PERF_DISPLAY_LABELS[cpuMode] : undefined} />
            <SelectRow label="RHI Present Time" value={rhiMode !== undefined ? PERF_DISPLAY_LABELS[rhiMode] : undefined} />
            <SelectRow label="Shooting Errors" value={firingErrorsMode !== undefined ? PERF_DISPLAY_LABELS[firingErrorsMode] : undefined} />

            {settings.unknown.ints.length > 0 && (
                <>
                    <SectionHeader label="Other (unrecognized)" />
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
    const [activeTab, setActiveTab] = useState<TabId>("general");
    const settings = useMemo(() => parseGameSettings(rawSettings), [rawSettings]);

    return (
        <div className="flex flex-col min-h-0">
            {/* Tab bar */}
            <div className="flex border-b border-white/10 mb-1 gap-0 shrink-0">
                {TABS.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`relative px-4 py-2.5 text-xs font-bold tracking-[0.12em] transition-colors cursor-pointer ${
                            activeTab === tab.id
                                ? "text-white"
                                : "text-gray-500 hover:text-gray-300"
                        }`}
                    >
                        {tab.label}
                        {activeTab === tab.id && (
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
