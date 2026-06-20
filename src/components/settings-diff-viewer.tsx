import { parseGameSettings } from "@/util/settings-parser.ts";
import type { ActionMapping, RawGameSettings } from "@/types/valorant-settings.ts";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatKey(key: string): string {
    const name = (key.split("::")[1] ?? key).replace(/^[bfis](?=[A-Z])/, "");
    return name.replace(/([A-Z])/g, " $1").trim();
}

function formatAction(name: string): string {
    return name.replace(/_/g, " ");
}

function formatBool(v: boolean | undefined): string {
    return v === undefined ? "—" : v ? "ON" : "OFF";
}

function formatNum(v: number | undefined, decimals: number): string {
    if (v === undefined) return "—";
    return Number.isInteger(v) || decimals === 0 ? String(v) : v.toFixed(decimals);
}

function formatStr(v: string | undefined): string {
    if (!v) return "—";
    return v.length > 30 ? v.slice(0, 28) + "…" : v;
}

function formatBinding(m: ActionMapping): string {
    const mods = ([m.ctrl && "Ctrl", m.shift && "Shift", m.alt && "Alt"] as (string | false)[]).filter(Boolean);
    const key = m.key && m.key !== "None" ? m.key : null;
    return [...mods, key].filter(Boolean).join("+") || "—";
}

function formatKeybinds(bindings: ActionMapping[] | undefined): string {
    if (!bindings || bindings.length === 0) return "—";
    return bindings.map(formatBinding).join(" / ");
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

interface DiffEntry {
    key: string;
    label: string;
    valueA: string;
    valueB: string;
}

function diffRecords<K extends string, V>(
    a: Partial<Record<K, V>>,
    b: Partial<Record<K, V>>,
    format: (v: V | undefined) => string,
): DiffEntry[] {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)] as K[]);
    const out: DiffEntry[] = [];
    for (const key of keys) {
        const va = a[key];
        const vb = b[key];
        if (va !== vb) {
            out.push({ key, label: formatKey(key), valueA: format(va), valueB: format(vb) });
        }
    }
    return out.sort((x, y) => x.label.localeCompare(y.label));
}

// ---------------------------------------------------------------------------
// Row & section primitives
// ---------------------------------------------------------------------------

function DiffRow({ entry, isEven }: { entry: DiffEntry; isEven: boolean }) {
    return (
        <div className={`flex items-center px-3 py-2 gap-3 rounded-sm ${isEven ? "" : "bg-white/[0.025]"}`}>
            <span className="text-sm text-gray-300 flex-1 min-w-0 truncate" title={entry.key}>
                {entry.label}
            </span>
            <div className="flex items-center gap-2 shrink-0 text-[11px] font-mono">
                <span className="bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded-sm min-w-12 text-center">
                    {entry.valueA}
                </span>
                <span className="text-gray-600">→</span>
                <span className="bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-sm min-w-12 text-center">
                    {entry.valueB}
                </span>
            </div>
        </div>
    );
}

function Section({ title, diffs }: { title: string; diffs: DiffEntry[] }) {
    if (diffs.length === 0) return null;
    return (
        <div className="mb-3">
            <div className="px-3 pt-3 pb-1 text-[10px] font-bold text-gray-600 uppercase tracking-widest">
                {title} ({diffs.length})
            </div>
            {diffs.map((d, i) => <DiffRow key={d.key} entry={d} isEven={i % 2 === 0} />)}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface Props {
    nameA: string;
    nameB: string;
    rawA: RawGameSettings;
    rawB: RawGameSettings;
}

export function SettingsDiffViewer({ nameA, nameB, rawA, rawB }: Props) {
    const a = parseGameSettings(rawA);
    const b = parseGameSettings(rawB);

    const boolDiffs  = diffRecords(a.bools,   b.bools,   formatBool);
    const floatDiffs = diffRecords(a.floats,  b.floats,  (v) => formatNum(v, 4));
    const intDiffs   = diffRecords(a.ints,    b.ints,    (v) => formatNum(v, 0));
    const stringDiffs = diffRecords(a.strings, b.strings, (v) => formatStr(v));

    const keybindDiffs: DiffEntry[] = [];
    const allActions = new Set([...Object.keys(a.keybinds), ...Object.keys(b.keybinds)]);
    for (const action of allActions) {
        const ka = formatKeybinds(a.keybinds[action]);
        const kb = formatKeybinds(b.keybinds[action]);
        if (ka !== kb) {
            keybindDiffs.push({ key: action, label: formatAction(action), valueA: ka, valueB: kb });
        }
    }
    keybindDiffs.sort((x, y) => x.label.localeCompare(y.label));

    const total = boolDiffs.length + floatDiffs.length + intDiffs.length + stringDiffs.length + keybindDiffs.length;

    return (
        <div className="flex flex-col min-h-0">
            <div className="flex items-center justify-between px-1 pb-3 mb-1 border-b border-white/10">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <span className="text-red-400 truncate max-w-40" title={nameA}>{nameA}</span>
                    <span className="text-gray-600 text-xs font-normal">vs</span>
                    <span className="text-green-400 truncate max-w-40" title={nameB}>{nameB}</span>
                </div>
                <span className="text-xs text-gray-500 bg-white/5 px-2 py-0.5 rounded shrink-0">
                    {total} difference{total !== 1 ? "s" : ""}
                </span>
            </div>

            {total === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-gray-500">
                    <span className="text-4xl text-green-400/50">✓</span>
                    <span className="text-sm">Profiles are identical</span>
                </div>
            ) : (
                <div className="overflow-y-auto max-h-120 pr-1">
                    <Section title="Gameplay / Toggles" diffs={boolDiffs}  />
                    <Section title="Sliders"             diffs={floatDiffs} />
                    <Section title="Counters"            diffs={intDiffs}   />
                    <Section title="Text"                diffs={stringDiffs}/>
                    <Section title="Keybinds"            diffs={keybindDiffs}/>
                </div>
            )}
        </div>
    );
}
