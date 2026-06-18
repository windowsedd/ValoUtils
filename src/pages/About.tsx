import CustomButton from "@/components/button.tsx";
import { openUrl } from "@/util";
import { useEffect, useState } from "react";
import { FaDiscord, FaGithub, FaTwitter } from "react-icons/fa6";

const About = () => {
	const [version, setVersion] = useState<string | null>("Loading...");
	useEffect(() => {
		if (window.Main) {
			window.Main.on("version", (version: string) => {
				setVersion(version);
			});
			window.Main.send("version");
			return () => {
				window.Main.removeAllListeners("version");
			};
		}
	}, []);

	return (
		<div className="px-6 py-6 animate-fade-in">
			<div className="max-w-4xl mx-auto">
				{/* Hero Section */}
				<div className="glass-strong p-6 mb-6 card-hover">
					<div className="text-center">
						<h1 className="text-5xl font-bold mb-2 gradient-text">ValoUtils</h1>
						<p className="text-lg text-gray-400 mb-4">Rebuild Version</p>
						<div className="divider-gradient mb-4"></div>
						<p className="text-base text-gray-300">Your ultimate Valorant utility companion</p>
					</div>
				</div>

				{/* Creator + Version */}
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
					<div className="glass p-4 card-hover flex items-center justify-center">
						<div className="flex items-center justify-center gap-2 flex-wrap">
							<span className="text-gray-400">Made with</span>
							<span className="text-xl">❤️</span>
							<span className="text-gray-400">by</span>
							<button
								onClick={() => {
									openUrl("https://github.com/windowsedd");
								}}
								className="text-xl font-bold gradient-text-blue hover:scale-110 transition-transform duration-300"
							>
								windowsed
							</button>
						</div>
					</div>
					<div className="glass p-4 flex items-center justify-center">
						<div className="flex items-center justify-center gap-2">
							<span className="text-gray-400">Version</span>
							<span className="text-xl font-bold text-white">{version}</span>
						</div>
					</div>
				</div>

				{/* Social Links */}
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
					<CustomButton
						className="btn-glow h-12"
						onPress={() => {
							openUrl("https://github.com/windowsedd/ValoUtils");
						}}
					>
						<div className="flex items-center gap-3 text-lg">
							<FaGithub className="text-2xl" />
							<span>GitHub</span>
						</div>
					</CustomButton>
					<CustomButton
						className="btn-glow h-12"
						onPress={() => {
							openUrl("https://x.com/windowsedd/");
						}}
					>
						<div className="flex items-center gap-3 text-lg">
							<FaTwitter className="text-2xl" />
							<span>Twitter</span>
						</div>
					</CustomButton>
					<CustomButton
						className="btn-glow h-12"
						onPress={() => {
							openUrl("https://discord.gg/valoutils");
						}}
					>
						<div className="flex items-center gap-3 text-lg">
							<FaDiscord className="text-2xl" />
							<span>Discord</span>
						</div>
					</CustomButton>
				</div>

				{/* Update Button */}
				<div className="glass-strong p-6 card-hover">
					<CustomButton
						className="w-full h-14 animate-glow"
						color="danger"
						onPress={() => {
							window.Main.send("update:check");
						}}
					>
						<span className="text-lg font-semibold">Check for Updates</span>
					</CustomButton>
				</div>

				{/* Footer */}
				<div className="mt-6 mb-2 text-center">
					<div className="divider-gradient mb-4"></div>
					<p className="text-gray-500 text-sm">ValoUtils is not affiliated with Riot Games or Valorant</p>
				</div>
			</div>
		</div>
	);
};

export default About;
