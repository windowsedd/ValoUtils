import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaGlobe, FaRocket, FaCode, FaChartBar, FaLanguage, FaKey, FaArrowUpRightFromSquare, FaCopy, FaCheck, FaGear, FaEye, FaEyeSlash, FaRobot, FaBook, FaComments } from "react-icons/fa6";
import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import { useConfiguredRoutes } from "@/components/router";
import SwaggerPage from "@/pages/SwaggerPage";
import { normalizeHiddenTabs, setTabHidden } from "@/util/navigation-tabs";
import {
	displayTranslationLanguage,
	getTranslationLanguages,
	normalizeTranslationSelection,
	switchTranslationProvider,
	type TranslationProvider,
} from "@/util/translation-languages";

const LANGUAGES = [
	{ code: "en", label: "EN", name: "English" },
	{ code: "ko", label: "한국어", name: "Korean" },
	{ code: "zh-TW", label: "繁中", name: "Traditional Chinese" },
];

type AppConfig = {
	autoUpdate: boolean;
	openDevTools: boolean;
	presenceEnabled: boolean;
	presenceMode: "online" | "offline" | "mobile";
	presenceStartup: "online" | "offline" | "mobile" | "last";
	presenceMucEnabled: boolean;
	translatorProvider: TranslationProvider;
	translatorSourceLanguage: string;
	translatorTargetLanguage: string;
	deeplApiKey: string;
	hiddenTabs: string[];
};

const Toggle = ({
	checked,
	onChange,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
}) => (
	<button
		role="switch"
		aria-checked={checked}
		onClick={() => onChange(!checked)}
		className={`relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer rounded-full border border-transparent transition-[background-color,box-shadow] duration-150 focus:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] ${
			checked ? "bg-(--accent)" : "bg-(--control)"
		}`}
	>
		<span
			className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[#d7d7de] shadow-none transition-transform duration-150 ${
				checked ? "translate-x-[14px]" : "translate-x-[1px]"
			}`}
		/>
	</button>
);

type SettingRowProps = {
	icon: React.ReactNode;
	label: string;
	description: string;
	badge?: string;
	right: React.ReactNode;
};

const SettingRow = ({ icon, label, description, badge, right }: SettingRowProps) => (
	<div className="flex items-center justify-between gap-4 py-2.5 border-b border-(--line) last:border-0">
		<div className="flex items-start gap-3 min-w-0">
			<div className="text-(--text-muted) mt-0.5 shrink-0 text-[13px]">{icon}</div>
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<p className="text-[12px] font-medium text-(--text-primary)">{label}</p>
					{badge && (
						<span className="text-[10px] font-medium px-1.5 py-0.5 rounded-[5px] bg-(--accent-soft) text-(--accent-selected)">
							{badge}
						</span>
					)}
				</div>
				<p className="text-[11px] text-(--text-muted) mt-0.5">{description}</p>
			</div>
		</div>
		<div className="shrink-0">{right}</div>
	</div>
);

const Settings = () => {
	const { t, i18n } = useTranslation();
	const configuredRoutes = useConfiguredRoutes();
	const configurableRoutes = configuredRoutes.filter((route) => route.id !== "settings");
	const [currentLang, setCurrentLang] = useState(i18n.language);
	const [clientPort, setClientPort] = useState<number | null>(null);
	const [clientPassword, setClientPassword] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [revealPassword, setRevealPassword] = useState(false);
	const [view, setView] = useState<"settings" | "api-reference">("settings");
	const [appConfig, setAppConfig] = useState<AppConfig>({
		autoUpdate: true,
		openDevTools: false,
		presenceEnabled: true,
		presenceMode: "offline",
		presenceStartup: "last",
		presenceMucEnabled: true,
		translatorProvider: "google",
		translatorSourceLanguage: "auto",
		translatorTargetLanguage: "en",
		deeplApiKey: "",
		hiddenTabs: [],
	});
	const [analytics, setAnalytics] = useState(() => localStorage.getItem("valoutils-analytics") !== "false");

	useEffect(() => {
		if (!window.Main) return;
		const onConfigLoaded = (msg: string) => {
			window.Main.removeListener("config:get-all", onConfigLoaded);
			try {
				const config = JSON.parse(msg) as Partial<AppConfig>;
				const translation = normalizeTranslationSelection({
					provider: config.translatorProvider,
					sourceLanguage: config.translatorSourceLanguage,
					targetLanguage: config.translatorTargetLanguage,
				});
				setAppConfig((current) => ({
					...current,
					...config,
					translatorProvider: translation.provider,
					translatorSourceLanguage: translation.sourceLanguage,
					translatorTargetLanguage: translation.targetLanguage,
					hiddenTabs: normalizeHiddenTabs(config.hiddenTabs),
				}));
				for (const [key, value] of Object.entries({
					translatorProvider: translation.provider,
					translatorSourceLanguage: translation.sourceLanguage,
					translatorTargetLanguage: translation.targetLanguage,
				})) {
					if (config[key as keyof AppConfig] !== value) {
						window.Main.send("config:set", key, value);
					}
				}
			} catch {
				setAppConfig((current) => ({ ...current, hiddenTabs: [] }));
			}
		};
		window.Main.on("config:get-all", onConfigLoaded);
		window.Main.send("config:get-all");
		return () => { window.Main.removeListener("config:get-all", onConfigLoaded); };
	}, []);

	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("client_info:get", (msg: string) => {
			window.Main.removeAllListeners("client_info:get");
			try {
				const info = JSON.parse(msg);
				if (info?.port) setClientPort(info.port);
				if (info?.password) setClientPassword(info.password);
			} catch { /* ignore */ }
		});
		window.Main.send("client_info:get");
		return () => { window.Main.removeAllListeners("client_info:get"); };
	}, []);

	const changeLang = (code: string) => {
		i18n.changeLanguage(code);
		localStorage.setItem("valoutils-lang", code);
		setCurrentLang(code);
	};

	const setConfig = (key: string, value: boolean | string | string[]) => {
		window.Main.send("config:set", key, value);
		setAppConfig((prev) => ({ ...prev, [key]: value }));
		window.dispatchEvent(
			new CustomEvent("valoutils:config-changed", { detail: { key, value } }),
		);
	};

	const setConfigs = (values: Partial<AppConfig>) => {
		for (const [key, value] of Object.entries(values)) {
			window.Main.send("config:set", key, value);
			window.dispatchEvent(
				new CustomEvent("valoutils:config-changed", {
					detail: { key, value },
				}),
			);
		}
		setAppConfig((previous) => ({ ...previous, ...values }));
	};

	const changeTranslatorProvider = (provider: TranslationProvider) => {
		const next = switchTranslationProvider(
			{
				provider: appConfig.translatorProvider,
				sourceLanguage: appConfig.translatorSourceLanguage,
				targetLanguage: appConfig.translatorTargetLanguage,
			},
			provider,
		);
		setConfigs({
			translatorProvider: next.provider,
			translatorSourceLanguage: next.sourceLanguage,
			translatorTargetLanguage: next.targetLanguage,
		});
	};

	const setRouteHidden = (routeId: string, hidden: boolean) => {
		const nextHiddenTabs = setTabHidden(appConfig.hiddenTabs, routeId, hidden);
		setConfig("hiddenTabs", nextHiddenTabs);
	};

	const setAnalyticsOpt = (enabled: boolean) => {
		localStorage.setItem("valoutils-analytics", String(enabled));
		setAnalytics(enabled);
	};

	const setPresence = (action: string, value?: boolean | string) => {
		window.Main.send("presence:status-set", action, ...(value === undefined ? [] : [value]));
		setAppConfig(prev => ({
			...prev,
			...(action === "enable" ? { presenceEnabled: true } : {}),
			...(action === "disable" ? { presenceEnabled: false } : {}),
			...(action === "muc" ? { presenceMucEnabled: Boolean(value) } : {}),
			...(action === "startup" ? { presenceStartup: value as AppConfig["presenceStartup"] } : {}),
			...(["online", "offline", "mobile"].includes(action) ? { presenceEnabled: true, presenceMode: action as AppConfig["presenceMode"] } : {}),
		}));
	};

	if (view === "api-reference") return <SwaggerPage onBack={() => setView("settings")} />;

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader icon={<FaGear className="text-[#ff4655] text-lg" />} title={t("settings.title")} />

			<div className={pageBodyClass}>

			<SectionCard title={t("settings.sectionGeneral")} accent="#ff4655">
					<div className="flex flex-col px-1">
				{/* Language */}
				<SettingRow
					icon={<FaGlobe />}
					label={t("settings.language")}
					description={t("settings.languageDesc")}
					right={
						<div className="flex gap-2">
							{LANGUAGES.map((lang) => (
								<button
									key={lang.code}
									onClick={() => changeLang(lang.code)}
									title={lang.name}
									className={`px-2.5 py-1 rounded-[5px] text-[11px] font-medium transition-[background-color,border-color,color] duration-150 ${
										currentLang === lang.code
											? "bg-(--accent-soft) text-(--accent-selected) border border-(--accent-border)"
											: "text-(--text-secondary) hover:text-(--text-primary) border border-(--border) hover:bg-(--surface-hover)"
									}`}
								>
									{lang.label}
								</button>
							))}
						</div>
					}
				/>
					</div>
				</SectionCard>

				<SectionCard title={t("settings.sectionTranslation")} accent="#8064e9">
					<div className="flex flex-col px-1">
				<SettingRow
					icon={<FaLanguage />}
					label={t("settings.translatorProvider")}
					description={t("settings.translatorProviderDesc")}
					right={
						<div className="flex gap-2">
							{(["google", "deepl"] as const).map((provider) => (
								<button
									key={provider}
									onClick={() => changeTranslatorProvider(provider)}
									className={`px-2.5 py-1 rounded-[5px] text-[11px] font-medium uppercase transition-[background-color,border-color,color] duration-150 ${
										appConfig.translatorProvider === provider
											? "bg-(--accent-soft) text-(--accent-selected) border border-(--accent-border)"
											: "text-(--text-secondary) hover:text-(--text-primary) border border-(--border) hover:bg-(--surface-hover)"
									}`}
								>
									{provider}
								</button>
							))}
						</div>
					}
				/>
				<SettingRow
					icon={<FaGlobe />}
					label={t("settings.translationLanguages")}
					description={t("settings.translationLanguagesDesc")}
					right={
						<div className="flex flex-wrap items-center justify-end gap-2 max-w-[32rem]">
							<select
								aria-label={t("settings.translationFrom")}
								value={appConfig.translatorSourceLanguage}
								onChange={(event) =>
									setConfig("translatorSourceLanguage", event.target.value)
								}
								className="max-w-48 h-7 px-2 rounded-[6px] border border-(--border) bg-(--control) text-[12px] text-(--text-primary) outline-none focus:border-(--accent) focus:shadow-[0_0_0_2px_var(--accent-soft)]"
							>
								<option value="auto">{t("settings.translationAuto")}</option>
								{getTranslationLanguages(
									appConfig.translatorProvider,
									"source",
								).map((language) => (
									<option key={language.code} value={language.code}>
										{displayTranslationLanguage(language, i18n.language)}
									</option>
								))}
							</select>
							<span aria-hidden="true" className="text-gray-500">→</span>
							<select
								aria-label={t("settings.translationTo")}
								value={appConfig.translatorTargetLanguage}
								onChange={(event) =>
									setConfig("translatorTargetLanguage", event.target.value)
								}
								className="max-w-48 h-7 px-2 rounded-[6px] border border-(--border) bg-(--control) text-[12px] text-(--text-primary) outline-none focus:border-(--accent) focus:shadow-[0_0_0_2px_var(--accent-soft)]"
							>
								{getTranslationLanguages(
									appConfig.translatorProvider,
									"target",
								).map((language) => (
									<option key={language.code} value={language.code}>
										{displayTranslationLanguage(language, i18n.language)}
									</option>
								))}
							</select>
						</div>
					}
				/>

				<SettingRow
					icon={<FaKey />}
					label={t("settings.deeplApiKey")}
					description={t("settings.deeplApiKeyDesc")}
					right={
						<input
							type="password"
							value={appConfig.deeplApiKey}
							onChange={(event) => setConfig("deeplApiKey", event.target.value)}
							className="w-56 h-7 px-2 rounded-[6px] border border-(--border) bg-(--control) text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent) focus:shadow-[0_0_0_2px_var(--accent-soft)]"
							placeholder="DeepL key"
						/>
					}
				/>
					</div>
				</SectionCard>

				<SectionCard title={t("settings.sectionApp")} accent="#a78bfa">
					<div className="flex flex-col px-1">
				<SettingRow
					icon={<FaRocket />}
					label={t("settings.autoUpdate")}
					description={t("settings.autoUpdateDesc")}
					right={
						<Toggle
							checked={appConfig.autoUpdate}
							onChange={(v) => setConfig("autoUpdate", v)}
						/>
					}
				/>

				<SettingRow
					icon={<FaCode />}
					label={t("settings.devTools")}
					description={t("settings.devToolsDesc")}
					badge={t("settings.restartRequired")}
					right={
						<Toggle
							checked={appConfig.openDevTools}
							onChange={(v) => setConfig("openDevTools", v)}
						/>
					}
				/>
					</div>
				</SectionCard>

				<SectionCard title={t("settings.sectionNavigation")} accent="#8064e9">
					<div className="flex flex-col px-1">
						{configurableRoutes.map((route) => (
							<SettingRow
								key={route.id}
								icon={route.icon ?? <FaEyeSlash />}
								label={t("settings.hideTab", { tab: t(route.title) })}
								description={t("settings.hideTabDesc")}
								right={
									<Toggle
										checked={appConfig.hiddenTabs.includes(route.id)}
										onChange={(hidden) => setRouteHidden(route.id, hidden)}
									/>
								}
							/>
						))}
					</div>
				</SectionCard>

				<SectionCard title={t("settings.sectionAnalytics")} accent="#4ade80">
					<div className="flex flex-col px-1">
				<SettingRow
					icon={<FaChartBar />}
					label={t("settings.analyticsToggle")}
					description={t("settings.analyticsDesc")}
					right={
						<Toggle checked={analytics} onChange={setAnalyticsOpt} />
					}
				/>
					</div>
				</SectionCard>

				<SectionCard title={t("settings.sectionDeveloper")} accent="#6b7280">
					<div className="flex flex-col px-1">
				<SettingRow icon={<FaRobot />} label="Presence masking" description="Allow Bot commands to rewrite your Riot presence." right={<Toggle checked={appConfig.presenceEnabled} onChange={v => setPresence(v ? "enable" : "disable")} />} />
				<SettingRow icon={<FaRobot />} label="Lobby / MUC forwarding" description="Forward lobby presence while masking is active." right={<Toggle checked={appConfig.presenceMucEnabled} onChange={v => setPresence("muc", v)} />} />
				<SettingRow icon={<FaRobot />} label="Startup presence" description="Choose the status used when the relay starts." right={<select value={appConfig.presenceStartup} onChange={event => setPresence("startup", event.target.value)} className="h-7 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[11px] text-(--text-primary) outline-none focus:border-(--accent) focus:shadow-[0_0_0_2px_var(--accent-soft)]"><option value="last">Remember last</option><option value="online">Online</option><option value="offline">Offline</option><option value="mobile">Mobile</option></select>} />
				<SettingRow
					icon={<FaBook />}
					label={t("nav.apiReference")}
					description={t("apiReference.subtitle")}
					right={<button onClick={() => setView("api-reference")} className="h-7 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[11px] font-medium text-(--text-primary) hover:bg-(--surface-hover)">{t("settings.open")}</button>}
				/>

				<SettingRow
					icon={<FaComments />}
					label={t("settings.chatApiLabel")}
					description={
						clientPort
							? `https://127.0.0.1:${clientPort}/chat/v6/messages`
							: t("settings.clientNotRunning")
					}
					right={
						<div className="flex gap-2 items-center">
							<code className="text-[11px] text-(--text-secondary) bg-(--control) border border-(--border) px-2 py-1 rounded-[5px]">
								{clientPort ?? "—"}
							</code>
							<button
								onClick={() => {
									if (!clientPort) return;
									window.Main.send("open_url", `https://127.0.0.1:${clientPort}/chat/v6/messages`);
								}}
								disabled={!clientPort}
								className="flex h-7 items-center gap-1.5 px-2.5 rounded-[6px] text-[11px] font-medium border border-(--border) bg-(--control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,border-color,color] duration-150"
							>
								<FaArrowUpRightFromSquare className="w-3 h-3" />
								{t("settings.open")}
							</button>
							<button
								onClick={() => {
									if (!clientPort) return;
									window.Main.send("clipboard:set", `https://127.0.0.1:${clientPort}/chat/v6/messages`);
									setCopied("chat");
									setTimeout(() => setCopied(null), 2000);
								}}
								disabled={!clientPort}
								className="flex h-7 items-center gap-1.5 px-2.5 rounded-[6px] text-[11px] font-medium border border-(--border) bg-(--control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,border-color,color] duration-150"
							>
								{copied === "chat" ? <FaCheck className="w-3 h-3 text-green-400" /> : <FaCopy className="w-3 h-3" />}
								{copied === "chat" ? t("settings.copied") : t("common.copy")}
							</button>
						</div>
					}
				/>

				<SettingRow
					icon={<FaCode />}
					label={t("settings.swaggerLabel")}
					description={
						clientPort
							? `https://127.0.0.1:${clientPort}/swagger/v3/openapi.json`
							: t("settings.clientNotRunning")
					}
					right={
						<div className="flex gap-2">
							<button
								onClick={() => {
									if (!clientPort) return;
									window.Main.send("open_url", `https://127.0.0.1:${clientPort}/swagger/v3/openapi.json`);
								}}
								disabled={!clientPort}
								className="flex h-7 items-center gap-1.5 px-2.5 rounded-[6px] text-[11px] font-medium border border-(--border) bg-(--control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,border-color,color] duration-150"
							>
								<FaArrowUpRightFromSquare className="w-3 h-3" />
								{t("settings.open")}
							</button>
							<button
								onClick={() => {
									if (!clientPort) return;
									const url = `https://127.0.0.1:${clientPort}/swagger/v3/openapi.json`;
									window.Main.send("clipboard:set", url);
									setCopied("url");
									setTimeout(() => setCopied(null), 2000);
								}}
								disabled={!clientPort}
								className="flex h-7 items-center gap-1.5 px-2.5 rounded-[6px] text-[11px] font-medium border border-(--border) bg-(--control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,border-color,color] duration-150"
							>
								{copied === "url" ? <FaCheck className="w-3 h-3 text-green-400" /> : <FaCopy className="w-3 h-3" />}
								{copied === "url" ? t("settings.copied") : t("common.copy")}
							</button>
						</div>
					}
				/>

				<SettingRow
					icon={<FaKey />}
					label={t("settings.clientPasswordLabel")}
					description={clientPassword ? t("settings.clientPasswordDesc") : t("settings.clientNotRunningShort")}
					right={
						<div className="flex gap-2 items-center">
							<code className="text-[11px] text-(--text-secondary) bg-(--control) border border-(--border) px-2 py-1 rounded-[5px] max-w-50 truncate">
								{clientPassword ? (revealPassword ? clientPassword : "•".repeat(12)) : "—"}
							</code>
							<button
								onClick={() => setRevealPassword((v) => !v)}
								disabled={!clientPassword}
								aria-label={revealPassword ? t("settings.hide") : t("settings.reveal")}
								className="flex h-7 items-center px-2 rounded-[6px] text-[11px] border border-(--border) bg-(--control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,color] duration-150"
							>
								{revealPassword ? <FaEyeSlash className="w-3 h-3" /> : <FaEye className="w-3 h-3" />}
							</button>
							<button
								onClick={() => {
									if (!clientPassword) return;
									window.Main.send("clipboard:set", clientPassword);
									setCopied("pwd");
									setTimeout(() => setCopied(null), 2000);
								}}
								disabled={!clientPassword}
								className="flex h-7 items-center gap-1.5 px-2.5 rounded-[6px] text-[11px] font-medium border border-(--border) bg-(--control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,border-color,color] duration-150"
							>
								{copied === "pwd" ? <FaCheck className="w-3 h-3 text-green-400" /> : <FaCopy className="w-3 h-3" />}
								{copied === "pwd" ? t("settings.copied") : t("common.copy")}
							</button>
						</div>
					}
				/>
				</div>
				</SectionCard>
			</div>
		</div>
	);
};

export default Settings;
