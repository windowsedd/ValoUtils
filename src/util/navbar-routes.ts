import type { Route } from "@/types/router";

export const splitNavbarRoutes = (routes: Route[], limit = 5) => ({
  dockRoutes: routes.slice(0, limit),
  overflowRoutes: routes.slice(limit),
});

export const isOverflowRouteSelected = (overflowRoutes: Route[], selectedId: string) =>
  overflowRoutes.some(({ id }) => id === selectedId);
