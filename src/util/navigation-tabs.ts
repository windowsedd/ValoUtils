import type { Route } from "@/types/router";

export const normalizeHiddenTabs = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === "string"))];
};

export const filterVisibleRoutes = (
	routes: Route[],
	hiddenTabs: readonly string[],
): Route[] => {
	const hidden = new Set(hiddenTabs);
	return routes.filter((route) => route.id === "settings" || !hidden.has(route.id));
};

export const setTabHidden = (
	hiddenTabs: readonly string[],
	routeId: string,
	hidden: boolean,
): string[] => {
	if (routeId === "settings") return [...hiddenTabs];
	if (hidden) return [...new Set([...hiddenTabs, routeId])];
	return hiddenTabs.filter((id) => id !== routeId);
};

export const resolveSelectedRouteId = (routes: Route[], selectedId: string): string =>
	routes.some((route) => route.id === selectedId) ? selectedId : (routes[0]?.id ?? "");
