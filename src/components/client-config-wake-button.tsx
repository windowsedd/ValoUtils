import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPower } from "react-icons/lu";
import { reportIpcError } from "@/util/ipc";

export const ClientConfigWakeButton = ({ running, disabled = false, from, onReady }: {
	running: boolean | null;
	disabled?: boolean;
	from: string;
	onReady: () => void;
}) => {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (running !== false) return null;
	const wake = async () => {
		setBusy(true);
		setError(null);
		invoke("analytics_track", { args: ["client_config:wake", JSON.stringify({ from })] }).catch(reportIpcError);
		try {
			const result = await invoke<{ success: boolean; running?: boolean; error?: string }>("client_config_start");
			if (result.success && result.running) onReady();
			else setError(result.error || t("common.configWakeFailed"));
		} catch {
			setError(t("common.configWakeFailed"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-[11px] text-(--text-muted)">{t("common.configServerDown")}</span>
				<button type="button" onClick={wake} disabled={busy || disabled}
					className="flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-(--accent-border) bg-(--accent-soft) px-3 text-[12px] font-medium text-(--accent-selected) hover:bg-(--accent-soft-hover) disabled:cursor-not-allowed disabled:opacity-40">
					<LuPower className="h-3 w-3" aria-hidden="true" />
					{t(busy ? "common.configWaking" : "common.configWake")}
				</button>
			</div>
			{error && <p role="alert" className="text-[11px] text-(--signal-neg)">{error}</p>}
		</div>
	);
};
