import CustomButton from "@/components/button.tsx";
import { PageHeader, SectionCard, SectionRow, pageBodyClass } from "@/components/section-card";
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

			<div className={pageBodyClass}>
				{/* Wordmark — the one place on this page that gets to be loud */}
				<section className="panel relative overflow-hidden flex flex-col items-center justify-center gap-2 px-8 py-10">
					<p className="text-[10px] uppercase tracking-[0.18em] text-(--text-muted) z-10">{t("about.rebuildVersion")}</p>
					<h1 className="text-6xl font-bold leading-none z-10 text-(--text-primary)">ValoUtils</h1>
					<p className="text-(--text-muted) text-[12px] z-10">{t("about.tagline")}</p>

					<div className="flex items-center gap-2 z-10 mt-3">
						{LINKS.map(({ icon: Icon, url, label }) => (
							<button
								key={url}
								onClick={() => openUrl(url)}
								aria-label={label}
								title={label}
								className="w-9 h-9 rounded-[6px] border border-(--border) bg-(--control) flex items-center justify-center text-(--text-muted) hover:text-(--text-primary) hover:bg-(--surface-hover) transition-colors duration-150"
							>
								<Icon className="text-[15px]" />
							</button>
						))}
					</div>
				</section>

				<SectionCard title={t("about.sectionApp")} accent="#ff4655">
					<SectionRow>
						<FaHeart className="text-[#ff4655] shrink-0 ml-1" />
						<div className="min-w-0 flex-1">
							<p className="text-[12px] font-medium text-(--text-primary)">{t("about.madeBy")}</p>
							<button
								onClick={() => openUrl("https://github.com/windowsedd")}
								className="text-[11px] text-(--text-muted) hover:text-(--accent-selected) transition-colors duration-150"
							>
								windowsed
							</button>
						</div>
					</SectionRow>
					<SectionRow>
						<span className="w-2 h-2 rounded-full bg-green-400 shrink-0 ml-2 mr-1" />
						<div className="min-w-0 flex-1">
							<p className="text-[12px] font-medium text-(--text-primary)">{t("about.version")}</p>
							<p className="text-[11px] text-(--text-muted) tabular-nums">{version ?? "—"}</p>
						</div>
						<CustomButton size="sm" onPress={() => window.Main.send("update:check")}>
							<FaSync className="mr-1.5" />
							{t("about.checkForUpdates")}
						</CustomButton>
					</SectionRow>
				</SectionCard>

				<SectionCard title={t("about.sectionLegal")} accent="#6b7280">
					<p className="px-3 py-1 text-[11px] text-(--text-muted) leading-relaxed">{t("about.disclaimer")}</p>
				</SectionCard>
			</div>
		</div>
	);
};

export default About;
