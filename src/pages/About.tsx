import CustomButton from "@/components/button.tsx";
import { openUrl } from "@/util";
import { useEffect, useState } from "react";
import { FaDiscord, FaGithub, FaHeart, FaTwitter } from "react-icons/fa6";
import { FaSync } from "react-icons/fa";
import { useTranslation } from "react-i18next";

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
		<div className="h-full flex flex-col px-6 py-6 animate-fade-in gap-4">

			{/* Hero */}
			<div className="glass-strong relative overflow-hidden rounded-2xl flex-1 flex flex-col items-center justify-center gap-3 px-8 py-10">
				<div className="absolute -top-16 -left-16 w-64 h-64 rounded-full bg-[#ff4655]/10 blur-3xl pointer-events-none" />
				<div className="absolute -bottom-16 -right-16 w-64 h-64 rounded-full bg-[#9d4dff]/10 blur-3xl pointer-events-none" />

				<p className="text-xs uppercase tracking-[0.35em] text-gray-500 z-10">{t("about.rebuildVersion")}</p>
				<h1 className="text-8xl font-bold gradient-text leading-none z-10">ValoUtils</h1>
				<p className="text-gray-400 text-base z-10">{t("about.tagline")}</p>

				<div className="divider-gradient w-32 my-2 z-10" />

				<div className="flex items-center gap-3 z-10">
					<button
						onClick={() => openUrl("https://github.com/windowsedd/ValoUtils")}
						className="w-11 h-11 rounded-full glass flex items-center justify-center text-gray-300 hover:text-white hover:bg-white/10 transition-all duration-200"
					>
						<FaGithub className="text-xl" />
					</button>
					<button
						onClick={() => openUrl("https://x.com/windowsedd/")}
						className="w-11 h-11 rounded-full glass flex items-center justify-center text-gray-300 hover:text-white hover:bg-white/10 transition-all duration-200"
					>
						<FaTwitter className="text-xl" />
					</button>
					<button
						onClick={() => openUrl("https://discord.gg/valoutils")}
						className="w-11 h-11 rounded-full glass flex items-center justify-center text-gray-300 hover:text-white hover:bg-white/10 transition-all duration-200"
					>
						<FaDiscord className="text-xl" />
					</button>
				</div>
			</div>

			{/* Stats row */}
			<div className="grid grid-cols-2 gap-4 shrink-0">
				<div className="glass-strong rounded-xl px-5 py-4 flex items-center gap-3">
					<FaHeart className="text-[#ff4655] text-lg shrink-0" />
					<div>
						<p className="text-xs text-gray-500 uppercase tracking-wider">{t("about.madeBy")}</p>
						<button
							onClick={() => openUrl("https://github.com/windowsedd")}
							className="font-bold gradient-text-blue hover:opacity-80 transition-opacity"
						>
							windowsed
						</button>
					</div>
				</div>
				<div className="glass-strong rounded-xl px-5 py-4 flex items-center gap-3">
					<div className="w-2 h-2 rounded-full bg-green-400" />
					<div>
						<p className="text-xs text-gray-500 uppercase tracking-wider">{t("about.version")}</p>
						<p className="font-bold text-white">{version ?? "—"}</p>
					</div>
				</div>
			</div>

			{/* Update CTA */}
			<div className="shrink-0">
				<CustomButton
					className="w-full h-12"
					color="danger"
					showStatusColor={false}
					onPress={() => window.Main.send("update:check")}
				>
					<FaSync className="mr-2" />
					<span className="font-semibold">{t("about.checkForUpdates")}</span>
				</CustomButton>
			</div>

			{/* Disclaimer */}
			<p className="text-center text-gray-600 text-xs shrink-0">
				{t("about.disclaimer")}
			</p>
		</div>
	);
};

export default About;
