import AlertContainer from "@/components/alert-container.tsx";
import RiotClientWatcher from "@/components/riot-client-watcher.tsx";
import { Router, RouterProvider } from "@/components/router";
import SettingsProfiles from "@/pages/SettingsProfiles.tsx";
import PlayerCareer from "@/pages/PlayerCareer.tsx";
import Friends from "@/pages/Friends.tsx";
import Matches from "@/pages/Matches.tsx";
import Replays from "@/pages/Replays.tsx";
import Settings from "@/pages/Settings.tsx";
import { fetcher } from "@/util/swr";
import { Toast } from "@heroui/react";
import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { FaCogs, FaQuestion, FaTrophy, FaFilm, FaBook } from "react-icons/fa";
import { FaGear, FaUserGroup, FaClockRotateLeft } from "react-icons/fa6";
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

const SwaggerPage = React.lazy(() => import("@/pages/SwaggerPage.tsx"));

class SwaggerErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
	constructor(props: { children: React.ReactNode }) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error: Error) {
		return { error: error.message };
	}
	render() {
		if (this.state.error) {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-2">
					<p className="text-red-400 text-sm font-medium">Failed to load Swagger UI</p>
					<p className="text-gray-500 text-xs">{this.state.error}</p>
				</div>
			);
		}
		return this.props.children;
	}
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
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
								title: "nav.friends",
								id: "friends",
								icon: <FaUserGroup />,
								component: <Friends />,
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
								title: "nav.apiReference",
								id: "swagger",
								icon: <FaBook />,
								component: <SwaggerErrorBoundary><Suspense fallback={<div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading…</div>}><SwaggerPage /></Suspense></SwaggerErrorBoundary>,
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
