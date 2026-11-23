import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaCheck, FaCopy, FaMobileScreen, FaQrcode, FaRotate } from "react-icons/fa6";
import { gooeyToast as toast } from "goey-toast";
import { reportIpcError } from "@/util/ipc";
import { SectionCard } from "@/components/section-card";
import { Switch } from "@/components/ui/switch";

type RemoteAddress = { ip: string; kind: "tailscale" | "lan"; url: string; qr?: string | null };

export type RemoteStatus = {
	success: boolean;
	enabled?: boolean;
	running?: boolean;
	port?: number | null;
	addresses?: RemoteAddress[];
	error?: string;
};

const buttonClass =
	"flex h-7 items-center gap-1.5 px-2.5 rounded-[6px] text-[11px] font-medium border border-(--border) bg-(--control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,border-color,color] duration-150";

const track = (event: string, props?: Record<string, unknown>) =>
	invoke("analytics_track", { args: props ? [event, JSON.stringify(props)] : [event] }).catch(reportIpcError);

export const RemoteSettings = () => {
	const { t } = useTranslation();
	const [status, setStatus] = useState<RemoteStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	/** The QR code carries the pairing secret, so it stays hidden until asked for. */
	const [reveal, setReveal] = useState(false);
	const [copied, setCopied] = useState(false);

	const apply = (reply: RemoteStatus) => {
		if (!reply.success) {
			toast.error(reply.error || t("remote.error"));
			return;
		}
		setStatus(reply);
	};

	const refresh = () => invoke<RemoteStatus>("remote_status").then(apply).catch(reportIpcError);

	useEffect(() => {
		let active = true;
		invoke<RemoteStatus>("remote_status")
			.then((reply) => {
				if (active) setStatus(reply);
			})
			.catch(reportIpcError);
		return () => {
			active = false;
		};
	}, []);

	const setEnabled = async (enabled: boolean) => {
		setBusy(true);
		try {
			apply(await invoke<RemoteStatus>("remote_set_enabled", { args: [enabled] }));
			if (!enabled) setReveal(false);
			track("remote:toggle", { enabled });
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy(false);
		}
	};

	const regenerate = async () => {
		try {
			apply(await invoke<RemoteStatus>("remote_regenerate_token"));
			toast.success(t("remote.regenerated"));
			track("remote:token-regenerate");
		} catch (error) {
			toast.error(String(error));
		}
	};

	const enabled = status?.enabled === true;
	const addresses = status?.addresses ?? [];
	const current = addresses.find((address) => address.ip === selected) ?? addresses[0];

	const copyLink = () => {
		if (!current) return;
		invoke("clipboard_set", { args: [current.url] }).catch(reportIpcError);
		track("remote:copy-link", { kind: current.kind });
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<SectionCard id="settings-remote" title={t("remote.section")} accent="#34d399">
			<div className="flex flex-col px-1">
				<div className="flex items-center justify-between gap-4 py-2.5 border-b border-(--line)">
					<div className="flex items-start gap-3 min-w-0">
						<FaMobileScreen className="text-(--text-muted) mt-0.5 shrink-0 text-[13px]" />
						<div className="min-w-0">
							<p className="text-[12px] font-medium text-(--text-primary)">{t("remote.enable")}</p>
							<p className="text-[11px] text-(--text-muted) mt-0.5">{t("remote.enableDesc")}</p>
						</div>
					</div>
					<Switch
						checked={enabled}
						onCheckedChange={setEnabled}
						disabled={busy || !status}
						aria-label={t("remote.enable")}
					/>
				</div>

				{enabled && status?.running && (
					<div className="flex flex-col gap-2.5 py-2.5 border-b border-(--line)">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="text-[11px] text-(--text-muted)">
								<span className="text-(--signal-pos)">●</span> {t("remote.running", { port: status.port })}
							</p>
							<div className="flex gap-1.5">
								<button type="button" onClick={refresh} className={buttonClass}>
									<FaRotate className="w-3 h-3" />
									{t("remote.refresh")}
								</button>
								<button type="button" onClick={regenerate} className={buttonClass}>
									{t("remote.regenerate")}
								</button>
							</div>
						</div>

						{addresses.length === 0 ? (
							<p className="text-[11px] text-(--signal-neg)">{t("remote.noAddress")}</p>
						) : (
							<>
								<div className="flex flex-wrap gap-1.5" role="radiogroup">
									{addresses.map((address) => {
										const active = address.ip === current?.ip;
										return (
											<button
												key={address.ip}
												type="button"
												role="radio"
												aria-checked={active}
												onClick={() => setSelected(address.ip)}
												className={`${buttonClass} ${active ? "border-(--accent)! text-(--text-primary)!" : ""}`}
											>
												{t(address.kind === "tailscale" ? "remote.tailscale" : "remote.lan")}
												<span className="font-mono text-(--text-muted)">{address.ip}</span>
											</button>
										);
									})}
								</div>
								<div className="flex items-start gap-3">
									<div className="relative size-[132px] shrink-0 overflow-hidden rounded-[8px] border border-(--border) bg-white">
										{current?.qr && (
											<img
												src={`data:image/svg+xml;utf8,${encodeURIComponent(current.qr)}`}
												alt=""
												className={`size-full transition-[filter] duration-200 ${reveal ? "" : "blur-md"}`}
												draggable={false}
											/>
										)}
										{!reveal && (
											<button
												type="button"
												onClick={() => {
													setReveal(true);
													track("remote:show-qr", { kind: current?.kind });
												}}
												className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40 text-[11px] font-medium text-white"
											>
												<FaQrcode className="w-4 h-4" />
												{t("remote.showQr")}
											</button>
										)}
									</div>
									<div className="flex min-w-0 flex-col gap-2">
										<p className="text-[11px] text-(--text-muted)">{t("remote.scanHint")}</p>
										<div className="flex flex-wrap gap-1.5">
											<button type="button" onClick={copyLink} className={buttonClass}>
												{copied ? <FaCheck className="w-3 h-3 text-green-400" /> : <FaCopy className="w-3 h-3" />}
												{copied ? t("settings.copied") : t("remote.copyLink")}
											</button>
											{reveal && (
												<button type="button" onClick={() => setReveal(false)} className={buttonClass}>
													{t("remote.hideQr")}
												</button>
											)}
										</div>
										<p className="text-[11px] text-(--text-muted)">{t("remote.firewall")}</p>
									</div>
								</div>
							</>
						)}
					</div>
				)}
				{enabled && status && !status.running && (
					<p className="py-2 text-[11px] text-(--signal-neg)">{t("remote.notRunning")}</p>
				)}
				<p className="py-2 text-[11px] text-(--text-muted)">{t("remote.privacy")}</p>
			</div>
		</SectionCard>
	);
};
