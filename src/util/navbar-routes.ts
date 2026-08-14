import type { Route } from "@/types/router";

export const partitionNavbarRoutes = (
  routes: Route[],
  limit = 6,
  settingsId = "settings",
) => {
  const settingsRoute = routes.find(({ id }) => id === settingsId);
  const navigationRoutes = routes.filter(({ id }) => id !== settingsId);

  return {
    directRoutes: navigationRoutes.slice(0, limit),
    overflowRoutes: navigationRoutes.slice(limit),
    settingsRoute,
  };
};

export const isOverflowRouteSelected = (overflowRoutes: Route[], selectedId: string) =>
  overflowRoutes.some(({ id }) => id === selectedId);

export const shouldDismissNavbarOverflow = (key: string) => key === "Escape";
