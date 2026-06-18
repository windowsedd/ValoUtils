import AlertContainer from "@/components/alert-container.tsx";
import RiotClientWatcher from "@/components/riot-client-watcher.tsx";
import { Router, RouterProvider } from "@/components/router";
import SettingsProfiles from "@/pages/SettingsProfiles.tsx";
import { fetcher } from "@/util/swr";
import { Toast } from "@heroui/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { FaCogs, FaQuestion } from "react-icons/fa";
import { SWRConfig } from "swr";
import { DynamicModalProvider } from "./components/dynamic-modal";
import "./index.css";
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
								title: "Profiles",
								id: "profiles",
								icon: <FaCogs />,
								component: <SettingsProfiles />,
							},
							{
								title: "About",
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
