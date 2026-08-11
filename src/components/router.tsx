import React, { createContext, Key, useContext, useEffect, useMemo, useState } from "react";
import { Tabs } from "@heroui/react";
import { Route } from "@/types/router";
import RiotStatusBar from "@/components/riot-status-bar";
import { useTranslation } from "react-i18next";
import { navbarLayout } from "@/components/navbar-layout";
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
	allRoutes: Route[];
};

const RouterContext = createContext<RouterContextValue>({ routes: [], allRoutes: [] });

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

	useEffect(() => {
		const onConfigLoaded = (message: string) => {
			window.Main.removeListener("config:get-all", onConfigLoaded);
			try {
				setHiddenTabs(normalizeHiddenTabs(JSON.parse(message)?.hiddenTabs));
			} catch {
				setHiddenTabs([]);
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
		};
		window.addEventListener("valoutils:config-changed", onConfigChanged);
		return () => window.removeEventListener("valoutils:config-changed", onConfigChanged);
	}, []);

	const routes = useMemo(
		() => filterVisibleRoutes(allRoutes, hiddenTabs),
		[allRoutes, hiddenTabs],
	);

	return (
		<RouterContext.Provider value={{ routes, allRoutes }}>
			{children}
		</RouterContext.Provider>
	);
};

const Router = () => {
	const { routes } = useContext(RouterContext);
	const { selectedId, body, goTo } = useRouter();
	const { t } = useTranslation();

	return (
		<>
			<div className={navbarLayout.root}>
				<div className={navbarLayout.tabsViewport}>
				<Tabs
					variant="secondary"
					selectedKey={selectedId}
					onSelectionChange={(key: Key) => {
						const routeId = key as string;
						goTo(routeId);
						window.Main.send(
							"analytics:track",
							"tab_change",
							JSON.stringify({
								tab: routeId,
							})
						);
					}}
				>
					<Tabs.ListContainer>
						<Tabs.List
							aria-label="Options"
							className={navbarLayout.tabsList}
						>
							{routes.map((route) => (
								<Tabs.Tab key={route.id} id={route.id} className={navbarLayout.tab}>
									<div className="flex items-center space-x-2">
										{route.icon}
										<span>{t(route.title)}</span>
									</div>
									<Tabs.Indicator className="w-full bg-[#22d3ee]!" />
								</Tabs.Tab>
							))}
						</Tabs.List>
					</Tabs.ListContainer>
				</Tabs>
				</div>
				<div className={navbarLayout.status}>
					<RiotStatusBar />
				</div>
			</div>
			<div className="flex-1 overflow-y-auto">{body}</div>
		</>
	);
};

export { Router, RouterProvider, useRouter };
