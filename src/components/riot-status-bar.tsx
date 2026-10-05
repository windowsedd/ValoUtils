import { listenEvent, reportIpcError } from "@/util/ipc";
import { invoke } from "@tauri-apps/api/core";
import CustomButton from "@/components/button";
import { useDynamicModal } from "@/components/dynamic-modal";
import { navbarLayout } from "@/components/navbar-layout";
import { ParsedSettingsViewer } from "@/components/parsed-settings-viewer";
import { useCallback,  useEffect, useRef, useState  } from "react";
import { LuChevronDown, LuEye, LuSmartphone, LuTriangleAlert, LuUser, LuUserX } from "react-icons/lu";
import { useTranslation } from "react-i18next";

type Status = "loading" | "offline" | "online";

type StatusInfo = {
	status: Status;
	username?: string;
};

type PresenceMode = "online" | "offline" | "mobile";

type PresenceInfo = {
	mode: PresenceMode;
	relayRunning: boolean;
	relayPort: number | null;
	activeConnections: number;
	upstreamReady: boolean;
	lastWarning: string | null;
};

type RiotStatusBarProps = {
	compact?: boolean;
};

const presenceColor: Record<PresenceMode, string> = {
	online: "text-(--signal-pos)",
	offline: "text-(--text-muted)",
	mobile: "text-(--accent-selected)",
};

const presenceIcon: Record<PresenceMode, React.ReactNode> = {
	online: <LuUser />,
	offline: <LuUserX />,
	mobile: <LuSmartphone />,
};

const dot: Record<Status, string> = {
	loading: "bg-(--signal-warn) animate-pulse",
	offline: "bg-(--signal-neg)",
	online: "bg-(--signal-pos)",
};

const RiotStatusBar = ({ compact = false }: RiotStatusBarProps) => {
	const [info, setInfo] = useState<StatusInfo>({ status: "loading" });
	const [presence, setPresence] = useState<PresenceInfo | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const { showModal, closeModal } = useDynamicModal();
	const { t } = useTranslation();

	const label: Record<Status, string> = {
		loading: t("riotStatus.connecting"),
		offline: t("riotStatus.offline"),
		online: "",
	};

	const fetchStatus = () => {

		const applyUserInfo = (message: any) => {

			const data = message;
			if (data.error || !data.acct) {
				setInfo({ status: "offline" });
				return;
			}
			setInfo({
				status: "online",
				username: `${data.acct.game_name}#${data.acct.tag_line}`,
			});
		};
		invoke<any>("userinfo_get").then(applyUserInfo).catch(error => applyUserInfo({ success: false, error: String(error) }));
	};

	useEffect(() => {
		fetchStatus();
		const interval = setInterval(fetchStatus, 10000);
		return () => {
			clearInterval(interval);

		};
	}, []);

	const applyPresence = useCallback((message: any) => {
			try {
				const data = message;
				if (data?.success && data.presence) setPresence(data.presence);
			} catch {
				/* Keep the last known relay state. */
			}
		}, []);

	useEffect(() => {
		let active = true;

		const unlistenapplyPresence = listenEvent("presence:status-changed", applyPresence);
		invoke<any>("presence_status_get").then(reply => { if (active) applyPresence(reply); }).catch(error => { if (active) applyPresence({ success: false, error: String(error) }); });
		const interval = setInterval(() => invoke<any>("presence_status_get").then(reply => { if (active) applyPresence(reply); }).catch(error => { if (active) applyPresence({ success: false, error: String(error) }); }), 4000);
		return () => {active = false;

			clearInterval(interval);

			unlistenapplyPresence();
		};
	}, [applyPresence]);

	useEffect(() => {
		if (!menuOpen) return;
		const close = (event: MouseEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [menuOpen]);

	const setMode = (mode: PresenceMode) => {
		if (!presence || presence.activeConnections < 1) return;
		invoke<any>("presence_status_set", { args: [mode] }).then(applyPresence).catch(error => applyPresence({ success: false, error: String(error) }));
		invoke("analytics_track", { args: ["presence_mode", JSON.stringify({ mode })] }).catch(reportIpcError);
		setMenuOpen(false);
	};

	const viewSettings = () => {
		setMenuOpen(false);
		return new Promise<void>((resolve, reject) => {

			const showCurrentSettings = (message: any) => {

				const data = message;
				if (data.error) {
					reject(data.error);
					return;
				}
				showModal({
					title: `Settings - ${info.username}`,
					body: (
						<ParsedSettingsViewer
							rawSettings={data.settings}
							crosshairData={data.crosshairs ?? null}
						/>
					),
					footer: (
						<CustomButton
							className="w-full"
							color="danger"
							showStatusColor={false}
							onPress={() => {
								closeModal();
								resolve();
							}}
						>
							{t("common.close")}
						</CustomButton>
					),
					onClose: resolve,
				});
			};
			invoke<any>("settings_current_view").then(showCurrentSettings).catch(reject);
		});
	};

	const accountLabel = info.status === "online" ? info.username : label[info.status];
	const presenceLabel = presence
		? t(`riotStatus.presence.${presence.mode}`)
		: t("riotStatus.presence.offline");

	return (
		<div
			ref={menuRef}
			className="relative select-none whitespace-nowrap"
			data-status-layout={compact ? "compact" : "full"}
		>
			<button
				type="button"
				onClick={() => setMenuOpen((open) => !open)}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				aria-label={compact ? accountLabel : undefined}
				data-tooltip={compact ? accountLabel : undefined}
				className={compact ? navbarLayout.statusTriggerCompact : navbarLayout.statusTrigger}
				title={accountLabel}
			>
				{compact ? (
					<>
						<span className="grid h-7 w-7 place-items-center rounded-full bg-(--control) text-[15px]" aria-hidden="true">
							{info.status === "online" ? <LuUser /> : <LuUserX />}
						</span>
						<span className={`absolute bottom-1.5 right-1.5 h-2.5 w-2.5 rounded-full border-2 border-(--surface) ${dot[info.status]}`} aria-hidden="true" />
						{/* Suppressed while the menu is open — it is anchored to the same
						    corner and would sit on top of the menu's footer text. */}
						{!menuOpen && (
							<span className={navbarLayout.statusTooltip} role="tooltip">{accountLabel}</span>
						)}
					</>
				) : (
					<>
						<span className={`h-2 w-2 shrink-0 rounded-full ${dot[info.status]}`} />
						<span className="max-w-28 truncate xl:max-w-40">{accountLabel}</span>
						<span className={`grid h-6 w-6 shrink-0 place-items-center text-xs ${presence ? presenceColor[presence.mode] : "text-(--text-muted)"}`}>
							{presence ? presenceIcon[presence.mode] : <LuUserX />}
						</span>
						<LuChevronDown className={`h-2.5 w-2.5 shrink-0 text-(--text-muted) transition-transform ${menuOpen ? "rotate-180" : ""}`} />
					</>
				)}
			</button>

			{menuOpen && (
				<div className={compact ? navbarLayout.statusMenuCompact : navbarLayout.statusMenu} role="menu">
					<div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2.5">
						<span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-(--control) text-[16px] text-(--text-secondary)" aria-hidden="true">
							{info.status === "online" ? <LuUser /> : <LuUserX />}
							<span className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-(--surface) ${dot[info.status]}`} />
						</span>
						<div className="min-w-0">
							<p className={`truncate text-[13px] font-semibold ${info.status === "online" ? "text-(--text-primary)" : "text-(--text-secondary)"}`}>
								{accountLabel}
							</p>
							{/* The saved presence mode only describes you while you're signed in;
							    under "Riot Client offline" it would read as a contradiction. */}
							{info.status === "online" && (
								<p className={`mt-0.5 flex items-center gap-1 text-[11px] ${presence ? presenceColor[presence.mode] : "text-(--text-muted)"}`}>
									{presenceLabel}
								</p>
							)}
						</div>
					</div>

					{info.status === "online" && (
						<CustomButton
							size="sm"
							showStatusColor={false}
							modalOnError={false}
							className="!h-8 !min-w-0 w-full !justify-start gap-2 !rounded-[8px] !border-0 !bg-transparent px-2 text-[12px] !text-(--text-secondary) hover:!bg-(--surface-hover) hover:!text-(--text-primary)"
							onClickLoading={viewSettings}
						>
							<LuEye className="text-(--accent-selected)" />
							{t("riotStatus.viewSettings")}
						</CustomButton>
					)}

					<div className="mt-1 border-t border-(--line) px-1 pt-2.5 pb-1">
						<p className="px-1 pb-2 text-[10px] font-medium tracking-[0.08em] text-(--text-muted) uppercase">{t("riotStatus.presenceControl")}</p>
						<div className="grid grid-cols-3 gap-1.5" role="group" aria-label={t("riotStatus.presenceControl")}>
							{(["online", "offline", "mobile"] as PresenceMode[]).map((mode) => {
								const selected = presence?.mode === mode;
								return (
									<button
										key={mode}
										type="button"
										role="menuitemradio"
										aria-checked={selected}
										disabled={!presence || presence.activeConnections < 1}
										onClick={() => setMode(mode)}
										className={`flex flex-col items-center gap-1 rounded-[10px] border px-1 py-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
											selected
												? "border-(--accent-border) bg-(--accent-soft) text-(--text-primary)"
												: "border-(--border) text-(--text-secondary) enabled:hover:bg-(--surface-hover) enabled:hover:text-(--text-primary)"
										}`}
									>
										<span className={`text-[15px] ${presenceColor[mode]}`}>{presenceIcon[mode]}</span>
										<span>{t(`riotStatus.presence.${mode}`)}</span>
									</button>
								);
							})}
						</div>
					</div>

					{(!presence || presence.activeConnections < 1) && (
						<p className={`${navbarLayout.statusMessage} border-(--signal-warn)/25 bg-(--signal-warn)/8 text-(--signal-warn)`}>
							<LuTriangleAlert className="mt-px shrink-0" aria-hidden="true" />
							<span>{t("riotStatus.relayRequired")}</span>
						</p>
					)}
					{presence?.lastWarning && (
						<p className={`${navbarLayout.statusMessage} border-(--signal-neg)/25 bg-(--signal-neg)/8 text-(--signal-neg)`}>
							<LuTriangleAlert className="mt-px shrink-0" aria-hidden="true" />
							<span>{presence.lastWarning}</span>
						</p>
					)}
				</div>
			)}
		</div>
	);
};

export default RiotStatusBar;
