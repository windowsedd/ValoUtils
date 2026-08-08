import CustomButton from "@/components/button.tsx";
import { PageHeader, SectionCard, SectionRow } from "@/components/section-card";
import { openUrl } from "@/util";
import { useEffect, useState } from "react";
import { FaDiscord, FaGithub, FaHeart, FaTwitter } from "react-icons/fa6";
import { FaSync } from "react-icons/fa";
import { useTranslation } from "react-i18next";

const LINKS = [
	{ icon: FaGithub, url: "https://github.com/windowsedd/ValoUtils", label: "GitHub" },
	{ icon: FaTwitter, url: "https://x.com/windowsedd/", label: "X" },
	{ icon: FaDiscord, url: "https://discord.gg/valoutils", label: "Discord" },
];

const About = () => {
	const [version, setVersion] = useState<string | null>(null);
	const { t } = useTranslation();

	useEffect(() => {
		if (window.Main) {
			window.Main.on("version", (v: string) => setVersion(v));
			window.Main.send("version");
			return () => window.Main.removeAllListeners("version");
		}
	}, []);

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<FaHeart className="text-[#ff4655] text-lg" />}
				title={t("nav.about")}
				subtitle={version ? `v${version}` : undefined}
			/>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 flex flex-col gap-4">
				{/* Wordmark — the one place on this page that gets to be loud */}
				<section className="glass rounded-2xl relative overflow-hidden flex flex-col items-center justify-center gap-2 px-8 py-10">
					<div className="absolute -top-16 -left-16 w-64 h-64 rounded-full bg-[#ff4655]/10 blur-3xl pointer-events-none" />
					<div className="absolute -bottom-16 -right-16 w-64 h-64 rounded-full bg-[#9d4dff]/10 blur-3xl pointer-events-none" />

					<p className="text-[10px] uppercase tracking-[0.35em] text-gray-600 z-10">{t("about.rebuildVersion")}</p>
					<h1 className="text-6xl font-bold gradient-text leading-none z-10">ValoUtils</h1>
					<p className="text-gray-500 text-sm z-10">{t("about.tagline")}</p>

					<div className="flex items-center gap-2 z-10 mt-3">
						{LINKS.map(({ icon: Icon, url, label }) => (
							<button
								key={url}
								onClick={() => openUrl(url)}
								aria-label={label}
								title={label}
								className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
							>
								<Icon className="text-lg" />
							</button>
						))}
					</div>
				</section>

				<SectionCard title={t("about.sectionApp")} accent="#ff4655">
					<SectionRow>
						<FaHeart className="text-[#ff4655] shrink-0 ml-1" />
						<div className="min-w-0 flex-1">
							<p className="text-sm font-semibold text-white">{t("about.madeBy")}</p>
							<button
								onClick={() => openUrl("https://github.com/windowsedd")}
								className="text-xs text-gray-500 hover:text-[#22d3ee] transition-colors"
							>
								windowsed
							</button>
						</div>
					</SectionRow>
					<SectionRow>
						<span className="w-2 h-2 rounded-full bg-green-400 shrink-0 ml-2 mr-1" />
						<div className="min-w-0 flex-1">
							<p className="text-sm font-semibold text-white">{t("about.version")}</p>
							<p className="text-xs text-gray-500 tabular-nums">{version ?? "—"}</p>
						</div>
						<CustomButton size="sm" onPress={() => window.Main.send("update:check")}>
							<FaSync className="mr-1.5" />
							{t("about.checkForUpdates")}
						</CustomButton>
					</SectionRow>
				</SectionCard>

				<SectionCard title={t("about.sectionLegal")} accent="#6b7280">
					<p className="px-3 py-1 text-xs text-gray-500 leading-relaxed">{t("about.disclaimer")}</p>
				</SectionCard>
			</div>
		</div>
	);
};

export default About;
