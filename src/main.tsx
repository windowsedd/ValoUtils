import AlertContainer from "@/components/alert-container.tsx";
import RiotClientWatcher from "@/components/riot-client-watcher.tsx";
import { Router, RouterProvider } from "@/components/router";
import SettingsProfiles from "@/pages/SettingsProfiles.tsx";
import PlayerCareer from "@/pages/PlayerCareer.tsx";
import Replays from "@/pages/Replays.tsx";
import Settings from "@/pages/Settings.tsx";
import { fetcher } from "@/util/swr";
import { Toast } from "@heroui/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { FaCogs, FaQuestion, FaTrophy, FaFilm } from "react-icons/fa";
import { FaGear } from "react-icons/fa6";
import { SWRConfig } from "swr";
import { DynamicModalProvider } from "./components/dynamic-modal";
import "./index.css";
import "./i18n/config";
import About from "./pages/About.tsx";
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<SWRConfig
			value={{
				fetcher,
				refreshInterval: 10000,
			}}
		>
			<DynamicModalProvider>
				<Toast.Provider />
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

postMessage({ payload: "removeLoading" }, "*");
