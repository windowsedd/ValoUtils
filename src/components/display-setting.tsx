import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { LuRefreshCw } from "react-icons/lu";
import { useTranslation } from "react-i18next";

type DisplayInfo = {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
};

type DisplaySettings = { monitors: DisplayInfo[]; selected: string };
type DisplayResponse = ({ success: true } & DisplaySettings) | { success: false; error: string };

type Props = DisplaySettings & {
  busy: boolean;
  failed: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
};

export const DisplaySelect = ({ monitors, selected, busy, failed, onSelect, onRefresh }: Props) => {
  const { t } = useTranslation();
  const disconnected = selected !== "" && !monitors.some((monitor) => monitor.id === selected);

  return (
    <div className="w-64 max-w-full">
      <div className="flex items-center gap-2">
        <select
          aria-label={t("settings.openOnDisplay")}
          aria-busy={busy}
          disabled={busy}
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[12px] text-(--text-primary) outline-none focus:border-(--accent) focus:shadow-[0_0_0_2px_var(--accent-soft)] disabled:opacity-50"
        >
          <option value="">{t("settings.primaryDisplay")}</option>
          {disconnected && <option value={selected} disabled>{t("settings.disconnectedDisplay", { name: selected.replace(/^\\\\\.\\/, "") })}</option>}
          {monitors.map((monitor, index) => (
            <option key={monitor.id} value={monitor.id}>
              {monitor.name || t("settings.displayNumber", { number: index + 1 })} · {monitor.width} × {monitor.height}{monitor.primary ? ` · ${t("settings.displayPrimary")}` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          aria-label={t("settings.refreshDisplays")}
          title={t("settings.refreshDisplays")}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[6px] border border-(--border) text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-50"
        >
          <LuRefreshCw aria-hidden="true" className="text-xs" />
        </button>
      </div>
      {failed && <p role="alert" className="mt-1.5 text-[11px] text-red-400">{t("settings.displaySettingError")}</p>}
    </div>
  );
};

export const DisplaySetting = () => {
  const [settings, setSettings] = useState<DisplaySettings>({ monitors: [], selected: "" });
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  const request = useCallback(async (command: "display_get" | "display_set", selected?: string) => {
    const id = ++requestId.current;
    setBusy(true);
    setFailed(false);
    try {
      const message = await invoke<string>(command, command === "display_set" ? { args: [selected] } : undefined);
      const response = JSON.parse(message) as DisplayResponse;
      if (!response.success || !Array.isArray(response.monitors) || typeof response.selected !== "string") {
        throw new Error("Display request failed");
      }
      if (requestId.current === id) setSettings(response);
    } catch {
      if (requestId.current === id) setFailed(true);
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void request("display_get");
    return () => { requestId.current += 1; };
  }, [request]);

  return <DisplaySelect {...settings} busy={busy} failed={failed} onSelect={(id) => { void request("display_set", id); }} onRefresh={() => { void request("display_get"); }} />;
};
