import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Route } from "@/types/router";
import RiotStatusBar from "@/components/riot-status-bar";
import { NavbarRail } from "@/components/navbar-rail";
import { useTranslation } from "react-i18next";
import { partitionNavbarRoutes, shouldDismissNavbarOverflow } from "@/util/navbar-routes";
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
	const [overflowOpen, setOverflowOpen] = useState(false);
	const overflowRef = useRef<HTMLDivElement>(null);
	const overflowMenuRef = useRef<HTMLDivElement>(null);
	const { directRoutes, overflowRoutes, settingsRoute } = partitionNavbarRoutes(routes);

	const selectRoute = (routeId: string) => {
		goTo(routeId);
		setOverflowOpen(false);
		window.Main.send("analytics:track", "tab_change", JSON.stringify({ tab: routeId }));
	};

	useEffect(() => {
		if (!overflowOpen) return;
		const closeOutside = (event: PointerEvent) => {
			const target = event.target as Node;
			if (
				!overflowRef.current?.contains(target) &&
				!overflowMenuRef.current?.contains(target)
			) {
				setOverflowOpen(false);
			}
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (!event.defaultPrevented && shouldDismissNavbarOverflow(event.key)) {
				setOverflowOpen(false);
			}
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [overflowOpen]);

	return (
		<div
			className="flex h-full min-h-0 w-full overflow-hidden"
			data-router-layout="command-rail"
		>
			<NavbarRail
				directRoutes={directRoutes}
				overflowRoutes={overflowRoutes}
				settingsRoute={settingsRoute}
				selectedId={selectedId}
				overflowOpen={overflowOpen}
				overflowRef={overflowRef}
				overflowMenuRef={overflowMenuRef}
				moreLabel={t("nav.more")}
				translate={t}
				onSelect={selectRoute}
				onOverflowOpenChange={setOverflowOpen}
				statusControl={<RiotStatusBar compact />}
			/>
			<main className="min-w-0 flex-1 overflow-y-auto">{body}</main>
		</div>
	);
};

export { Router, RouterProvider, useRouter };
