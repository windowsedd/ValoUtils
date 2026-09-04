import CustomButton from "@/components/button";
import { useDynamicModal } from "@/components/dynamic-modal";
import { navbarLayout } from "@/components/navbar-layout";
import { ParsedSettingsViewer } from "@/components/parsed-settings-viewer";
import { useEffect, useRef, useState } from "react";
import { LuCheck, LuChevronDown, LuEye, LuSmartphone, LuUser, LuUserX } from "react-icons/lu";
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
		if (!window.Main) return;
		window.Main.removeAllListeners("userinfo:get");
		window.Main.on("userinfo:get", (message: string) => {
			window.Main.removeAllListeners("userinfo:get");
			const data = JSON.parse(message);
			if (data.error || !data.acct) {
				setInfo({ status: "offline" });
				return;
			}
			setInfo({
				status: "online",
				username: `${data.acct.game_name}#${data.acct.tag_line}`,
			});
		});
		window.Main.send("userinfo:get");
	};

	useEffect(() => {
		fetchStatus();
		const interval = setInterval(fetchStatus, 10000);
		return () => {
			clearInterval(interval);
			window.Main.removeAllListeners("userinfo:get");
		};
	}, []);

	useEffect(() => {
		if (!window.Main) return;
		const applyPresence = (message: string) => {
			try {
				const data = JSON.parse(message);
				if (data?.success && data.presence) setPresence(data.presence);
			} catch {
				/* Keep the last known relay state. */
			}
		};
		window.Main.on("presence:status-get", applyPresence);
		window.Main.on("presence:status-set", applyPresence);
		window.Main.on("presence:status-changed", applyPresence);
		window.Main.send("presence:status-get");
		const interval = setInterval(() => window.Main.send("presence:status-get"), 4000);
		return () => {
			clearInterval(interval);
			window.Main.removeAllListeners("presence:status-get");
			window.Main.removeAllListeners("presence:status-set");
			window.Main.removeAllListeners("presence:status-changed");
		};
	}, []);

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
		window.Main.send("presence:status-set", mode);
		window.Main.send("analytics:track", "presence_mode", JSON.stringify({ mode }));
		setMenuOpen(false);
	};

	const viewSettings = () => {
		setMenuOpen(false);
		return new Promise<void>((resolve, reject) => {
			window.Main.removeAllListeners("settings:current:view");
			window.Main.on("settings:current:view", (message: string) => {
				window.Main.removeAllListeners("settings:current:view");
				const data = JSON.parse(message);
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
			});
			window.Main.send("settings:current:view");
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
						<span className={`absolute bottom-1.5 right-1.5 h-2.5 w-2.5 rounded-full border-2 border-(--sidebar) ${dot[info.status]}`} aria-hidden="true" />
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
					<div className="px-2.5 py-2">
						<p className="truncate text-[12px] font-semibold text-(--text-primary)">{accountLabel}</p>
						<p className={`mt-0.5 text-[11px] ${presence ? presenceColor[presence.mode] : "text-(--text-muted)"}`}>
							{presenceLabel}
						</p>
					</div>

					{info.status === "online" && (
						<CustomButton
							size="sm"
							showStatusColor={false}
							modalOnError={false}
							className="!h-8 !min-w-0 w-full !justify-start gap-2 !rounded-[6px] !bg-transparent px-2.5 text-[12px] !text-(--text-secondary) hover:!bg-(--surface-hover)"
							onClickLoading={viewSettings}
						>
							<LuEye className="text-(--accent-selected)" />
							{t("riotStatus.viewSettings")}
						</CustomButton>
					)}

					<div className="mt-1 border-t border-(--line) pt-1">
						<p className="px-2.5 py-1 text-[10px] uppercase tracking-widest text-(--text-muted)">{t("riotStatus.presenceControl")}</p>
						{(["online", "offline", "mobile"] as PresenceMode[]).map((mode) => (
							<button
								key={mode}
								type="button"
								role="menuitemradio"
								aria-checked={presence?.mode === mode}
								disabled={!presence || presence.activeConnections < 1}
								onClick={() => setMode(mode)}
								className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12px] text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-40"
							>
								<span className={presenceColor[mode]}>{presenceIcon[mode]}</span>
								<span className="flex-1">{t(`riotStatus.presence.${mode}`)}</span>
								{presence?.mode === mode && <LuCheck className="text-(--accent-selected)" />}
							</button>
						))}
					</div>

					{(!presence || presence.activeConnections < 1) && (
						<p className={`${navbarLayout.statusMessage} text-(--signal-warn)`}>
							{t("riotStatus.relayRequired")}
						</p>
					)}
					{presence?.lastWarning && (
						<p className={`${navbarLayout.statusMessage} text-(--signal-neg)`}>
							{presence.lastWarning}
						</p>
					)}
				</div>
			)}
		</div>
	);
};

export default RiotStatusBar;
