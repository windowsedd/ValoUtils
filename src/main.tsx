import AlertContainer from "@/components/alert-container.tsx";
import RiotClientWatcher from "@/components/riot-client-watcher.tsx";
import { Router, RouterProvider } from "@/components/router";
import SettingsProfiles from "@/pages/SettingsProfiles.tsx";
import PlayerCareer from "@/pages/PlayerCareer.tsx";
import Friends from "@/pages/Friends.tsx";
import Chat from "@/pages/Chat.tsx";
import Matches from "@/pages/Matches.tsx";
import Replays from "@/pages/Replays.tsx";
import Settings from "@/pages/Settings.tsx";
import { fetcher } from "@/util/swr";
import { Toast } from "@heroui/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { FaCogs, FaComments, FaQuestion, FaTrophy, FaFilm } from "react-icons/fa";
import { FaGear, FaUserGroup, FaClockRotateLeft, FaRobot, FaCrosshairs } from "react-icons/fa6";
import DummyBotPage from "@/pages/DummyBot.tsx";
import LiveGame from "@/pages/LiveGame.tsx";
import { SWRConfig } from "swr";
import { DynamicModalProvider } from "./components/dynamic-modal";
import "./index.css";
import "./i18n/config";
import "./util/tauri-bridge";
import About from "./pages/About.tsx";

// WebView2 shows the browser's own context menu (Back / Refresh / Save as /
// Inspect …) on right-click, which is meaningless in a desktop app. Suppress
// it everywhere except in text fields, where the native copy/paste menu is
// still useful.
window.addEventListener("contextmenu", (event) => {
	const target = event.target as HTMLElement | null;
	if (target?.closest("input, textarea, [contenteditable='true']")) return;
	event.preventDefault();
});

const AppShell = () => {
	return (
		<React.StrictMode>
			<SWRConfig
				value={{
					fetcher,
					refreshInterval: 10000,
				}}
			>
				<DynamicModalProvider>
				{/* Corner placement — the default ("bottom") centres a 460px-wide
				    toast, which lands squarely on top of the full-width
				    "Check for Updates" button at the bottom of the About page. */}
				<Toast.Provider placement="bottom end" />
				<AlertContainer>
					<RouterProvider
						routes={[
							{
								title: "nav.profiles",
								id: "profiles",
								icon: <FaCogs />,
								component: <SettingsProfiles />,
							},
							{
								title: "nav.career",
								id: "career",
								icon: <FaTrophy />,
								component: <PlayerCareer />,
							},
							{
								title: "nav.matches",
								id: "matches",
								icon: <FaClockRotateLeft />,
								component: <Matches />,
							},
							{
								title: "nav.liveGame",
								id: "live-game",
								icon: <FaCrosshairs />,
								component: <LiveGame />,
							},
							{
								title: "nav.friends",
								id: "friends",
								icon: <FaUserGroup />,
								component: <Friends />,
							},
							{
								title: "nav.chat",
								id: "chat",
								icon: <FaComments />,
								component: <Chat />,
							},
							{
								title: "nav.replays",
								id: "replays",
								icon: <FaFilm />,
								component: <Replays />,
							},
							{
								title: "nav.settings",
								id: "settings",
								icon: <FaGear />,
								component: <Settings />,
							},
							{
								title: "nav.about",
								id: "about",
								icon: <FaQuestion />,
								component: <About />,
							},
							{
								title: "nav.dummyBot",
								id: "fake-player",
								icon: <FaRobot />,
								component: <DummyBotPage />,
							},
						]}
					>
						<RiotClientWatcher>
							<div className="flex flex-col h-screen bg-black overflow-hidden">
								<Router />
							</div>
						</RiotClientWatcher>
					</RouterProvider>
				</AlertContainer>
				</DynamicModalProvider>
			</SWRConfig>
		</React.StrictMode>
	);
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<AppShell />);

postMessage({ payload: "removeLoading" }, "*");
