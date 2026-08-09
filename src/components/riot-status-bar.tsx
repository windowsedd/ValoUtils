import CustomButton from "@/components/button";
import { useDynamicModal } from "@/components/dynamic-modal";
import { ParsedSettingsViewer } from "@/components/parsed-settings-viewer";
import { useEffect, useRef, useState } from "react";
import { FaCheck, FaChevronDown, FaEye, FaMobileScreen, FaUser, FaUserSlash } from "react-icons/fa6";
import { useTranslation } from "react-i18next";
import { navbarLayout } from "@/components/navbar-layout";

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

const presenceColor: Record<PresenceMode, string> = {
	online: "text-green-400",
	offline: "text-gray-400",
	mobile: "text-cyan-400",
};

const presenceIcon: Record<PresenceMode, React.ReactNode> = {
	online: <FaUser />,
	offline: <FaUserSlash />,
	mobile: <FaMobileScreen />,
};

const dot: Record<Status, string> = {
	loading: "bg-yellow-400 animate-pulse",
	offline: "bg-red-500",
	online: "bg-green-400",
};

const RiotStatusBar = () => {
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
				/* keep the last known relay state */
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

	return (
		<div className="flex items-center gap-1.5 text-sm select-none whitespace-nowrap">
			<span className={`w-2 h-2 rounded-full shrink-0 ${dot[info.status]}`} />
			<span className="text-gray-300 truncate max-w-28 xl:max-w-45">
				{info.status === "online" ? info.username : label[info.status]}
			</span>
			{info.status === "online" && (
				<CustomButton
					size="sm"
					showStatusColor={false}
					modalOnError={false}
					className="min-w-0 w-7 h-7 p-0 ml-1 text-gray-400"
					onClickLoading={() =>
						new Promise<void>((resolve, reject) => {
							window.Main.removeAllListeners("settings:current:view");
							window.Main.on("settings:current:view", (message: string) => {
								window.Main.removeAllListeners("settings:current:view");
								const data = JSON.parse(message);
								if (data.error) {
									reject(data.error);
									return;
								}
								showModal({
									title: `Settings — ${info.username}`,
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
						})
					}
				>
					<FaEye />
				</CustomButton>
			)}
			<div ref={menuRef} className="relative ml-1 pl-2 border-l border-white/10">
				<button
					type="button"
					onClick={() => setMenuOpen((open) => !open)}
					className={`h-8 px-2 flex items-center gap-1.5 rounded-md hover:bg-white/5 transition-colors ${
						presence ? presenceColor[presence.mode] : "text-gray-600"
					}`}
					title={t("riotStatus.presenceControl")}
				>
					{presence ? presenceIcon[presence.mode] : <FaUserSlash />}
					<span className="text-xs capitalize">{presence ? t(`riotStatus.presence.${presence.mode}`) : "—"}</span>
					<FaChevronDown className="w-2.5 h-2.5 text-gray-600" />
				</button>
				{menuOpen && (
					<div className={navbarLayout.statusMenu}>
						{(["online", "offline", "mobile"] as PresenceMode[]).map((mode) => (
							<button
								key={mode}
								type="button"
								disabled={!presence || presence.activeConnections < 1}
								onClick={() => setMode(mode)}
								className="w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-gray-300 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
							>
								<span className={presenceColor[mode]}>{presenceIcon[mode]}</span>
								<span className="flex-1">{t(`riotStatus.presence.${mode}`)}</span>
								{presence?.mode === mode && <FaCheck className="text-cyan-400" />}
							</button>
						))}
						{(!presence || presence.activeConnections < 1) && (
							<p className={`${navbarLayout.statusMessage} text-amber-400/80`}>
								{t("riotStatus.relayRequired")}
							</p>
						)}
						{presence?.lastWarning && (
							<p className={`${navbarLayout.statusMessage} text-red-400`}>
								{presence.lastWarning}
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
};

export default RiotStatusBar;
