import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaGlobe, FaRocket, FaCode, FaChartBar } from "react-icons/fa6";

const LANGUAGES = [
	{ code: "en", label: "EN", name: "English" },
	{ code: "ko", label: "한국어", name: "Korean" },
	{ code: "zh-TW", label: "繁中", name: "Traditional Chinese" },
];

type AppConfig = { autoUpdate: boolean; openDevTools: boolean };

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
		className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
			checked ? "bg-[#22d3ee]" : "bg-white/10"
		}`}
	>
		<span
			className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200 ${
				checked ? "translate-x-5" : "translate-x-0"
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
	<div className="flex items-center justify-between gap-4 py-4 border-b border-white/5 last:border-0">
		<div className="flex items-start gap-3 min-w-0">
			<div className="text-gray-400 mt-0.5 shrink-0">{icon}</div>
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<p className="text-sm font-medium text-white">{label}</p>
					{badge && (
						<span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 uppercase tracking-wide">
							{badge}
						</span>
					)}
				</div>
				<p className="text-xs text-gray-500 mt-0.5">{description}</p>
			</div>
		</div>
		<div className="shrink-0">{right}</div>
	</div>
);

const SectionHeader = ({ title }: { title: string }) => (
	<p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1 mt-2 first:mt-0">
		{title}
	</p>
);

const Settings = () => {
	const { t, i18n } = useTranslation();
	const [currentLang, setCurrentLang] = useState(i18n.language);
	const [appConfig, setAppConfig] = useState<AppConfig>({ autoUpdate: true, openDevTools: false });
	const [analytics, setAnalytics] = useState(() => localStorage.getItem("valoutils-analytics") !== "false");

	useEffect(() => {
		if (!window.Main) return;
		window.Main.on("config:get-all", (msg: string) => {
			window.Main.removeAllListeners("config:get-all");
			setAppConfig(JSON.parse(msg));
		});
		window.Main.send("config:get-all");
		return () => { window.Main.removeAllListeners("config:get-all"); };
	}, []);

	const changeLang = (code: string) => {
		i18n.changeLanguage(code);
		localStorage.setItem("valoutils-lang", code);
		setCurrentLang(code);
	};

	const setConfig = (key: string, value: boolean) => {
		window.Main.send("config:set", key, value);
		setAppConfig((prev) => ({ ...prev, [key]: value }));
	};

	const setAnalyticsOpt = (enabled: boolean) => {
		localStorage.setItem("valoutils-analytics", String(enabled));
		setAnalytics(enabled);
	};

	return (
		<div className="px-6 py-8 h-full flex flex-col gap-5 animate-fade-in overflow-y-auto">
			<div className="glass-strong p-6 shrink-0">
				<h1 className="text-5xl font-bold gradient-text">{t("settings.title")}</h1>
			</div>

			<div className="glass-strong p-6 flex flex-col gap-0">
				<SectionHeader title={t("settings.sectionGeneral")} />

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
									className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${
										currentLang === lang.code
											? "bg-[#22d3ee]/20 text-[#22d3ee] border border-[#22d3ee]/40"
											: "text-gray-400 hover:text-gray-200 border border-white/10 hover:border-white/25"
									}`}
								>
									{lang.label}
								</button>
							))}
						</div>
					}
				/>
			</div>

			<div className="glass-strong p-6 flex flex-col gap-0">
				<SectionHeader title={t("settings.sectionApp")} />

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

			<div className="glass-strong p-6 flex flex-col gap-0">
				<SectionHeader title={t("settings.sectionAnalytics")} />

				<SettingRow
					icon={<FaChartBar />}
					label={t("settings.analyticsToggle")}
					description={t("settings.analyticsDesc")}
					right={
						<Toggle checked={analytics} onChange={setAnalyticsOpt} />
					}
				/>
			</div>
		</div>
	);
};

export default Settings;
