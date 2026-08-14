import type { Route } from "@/types/router";

export const partitionNavbarRoutes = (routes: Route[], settingsId = "settings") => ({
  directRoutes: routes.filter(({ id }) => id !== settingsId),
  settingsRoute: routes.find(({ id }) => id === settingsId),
});
