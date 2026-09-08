import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Route } from "@/types/router";
import RiotStatusBar from "@/components/riot-status-bar";
import { NavbarRail } from "@/components/navbar-rail";
import { RouteErrorBoundary } from "@/components/route-error-boundary";
import { useTranslation } from "react-i18next";
import { partitionNavbarRoutes } from "@/util/navbar-routes";
import {
	filterVisibleRoutes,
	normalizeHiddenTabs,
	resolveSelectedRouteId,
} from "@/util/navigation-tabs";

type RouterProps = {
	routes: Route[];
};

type RouterContextValue = {
	routes: Route[];
	/** Whether the user has asked for the Logs tab on the rail. */
	showLogsTab: boolean;
	allRoutes: Route[];
};

const RouterContext = createContext<RouterContextValue>({
	routes: [],
	showLogsTab: false,
	allRoutes: [],
});

export const useConfiguredRoutes = () => useContext(RouterContext).allRoutes;

// Custom hook to use the router context
const useRouter = () => {
	const routerContext = useContext(RouterContext);

	if (!routerContext) {
		throw new Error("useRouter must be used within a RouterProvider");
	}

	const [selectedId, setSelectedId] = useState<string>(routerContext.routes[0]?.id ?? "");
	const resolvedSelectedId = resolveSelectedRouteId(routerContext.routes, selectedId);
	const body = routerContext.routes.find((route) => route.id === resolvedSelectedId)?.component;

	useEffect(() => {
		if (resolvedSelectedId !== selectedId) setSelectedId(resolvedSelectedId);
	}, [resolvedSelectedId, selectedId]);

	const goTo = (id: string) => {
		const routeIndex = routerContext.routes.findIndex((route) => route.id === id);
		if (routeIndex !== -1) {
			console.log(`Going to route with id "${id}"`);
			setSelectedId(id);
		} else {
			console.error(`Route with id "${id}" not found.`);
		}
	};

	const goToIndex = (index: number) => {
		const route = routerContext.routes[index];
		if (route) {
			setSelectedId(route.id);
		} else {
			console.error(`Route with index "${index}" not found.`);
		}
	};

	return { selectedId: resolvedSelectedId, body, goTo, goToIndex };
};
const RouterProvider: React.FC<
	RouterProps & {
		children: React.ReactNode | React.ReactNode[];
	}
> = ({ routes: allRoutes, children }) => {
	const [hiddenTabs, setHiddenTabs] = useState<string[]>([]);
	const [showLogsTab, setShowLogsTab] = useState(false);

	useEffect(() => {
		const onConfigLoaded = (message: string) => {
			window.Main.removeListener("config:get-all", onConfigLoaded);
			try {
				const config = JSON.parse(message);
				setHiddenTabs(normalizeHiddenTabs(config?.hiddenTabs));
				setShowLogsTab(config?.showLogsTab === true);
			} catch {
				setHiddenTabs([]);
				setShowLogsTab(false);
			}
		};
		window.Main.on("config:get-all", onConfigLoaded);
		window.Main.send("config:get-all");
		return () => window.Main.removeListener("config:get-all", onConfigLoaded);
	}, []);

	useEffect(() => {
		const onConfigChanged = (event: Event) => {
			const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
			if (detail?.key === "hiddenTabs") setHiddenTabs(normalizeHiddenTabs(detail.value));
			if (detail?.key === "showLogsTab") setShowLogsTab(detail.value === true);
		};
		window.addEventListener("valoutils:config-changed", onConfigChanged);
		return () => window.removeEventListener("valoutils:config-changed", onConfigChanged);
	}, []);

	const routes = useMemo(
		() => filterVisibleRoutes(allRoutes, hiddenTabs),
		[allRoutes, hiddenTabs],
	);
	return (
		<RouterContext.Provider value={{ routes, showLogsTab, allRoutes }}>
			{children}
		</RouterContext.Provider>
	);
};

const Router = () => {
	const { routes, showLogsTab } = useContext(RouterContext);
	const { selectedId, body, goTo } = useRouter();
	const { t } = useTranslation();
	const { directRoutes, logsRoute, settingsRoute } = partitionNavbarRoutes(
		routes,
		"settings",
		showLogsTab,
	);

	const selectRoute = (routeId: string) => {
		goTo(routeId);
		window.Main.send("analytics:track", "tab_change", JSON.stringify({ tab: routeId }));
	};

	return (
		<div
			className="flex h-full min-h-0 w-full overflow-hidden"
			data-router-layout="command-rail"
		>
			<NavbarRail
				directRoutes={directRoutes}
				logsRoute={logsRoute}
				settingsRoute={settingsRoute}
				selectedId={selectedId}
				translate={t}
				onSelect={selectRoute}
				statusControl={<RiotStatusBar compact />}
			/>
			<main className="min-w-0 flex-1 overflow-y-auto">
				<RouteErrorBoundary key={selectedId} label={selectedId}>
					{body}
				</RouteErrorBoundary>
			</main>
		</div>
	);
};

export { Router, RouterProvider, useRouter };
