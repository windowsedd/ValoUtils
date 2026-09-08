import type { Route } from "@/types/router";

/**
 * Split the rail into its two stacks.
 *
 * Logs is never one of the direct routes: it is opened by pressing the brand
 * mark, and only joins the bottom stack — beside Settings — when the user asks
 * for it. `showLogs` false leaves `logsRoute` undefined, which is what keeps a
 * diagnostics page out of everyone else's rail.
 */
export const partitionNavbarRoutes = (
  routes: Route[],
  settingsId = "settings",
  showLogs = false,
  logsId = "logs",
) => ({
  directRoutes: routes.filter(({ id }) => id !== settingsId && id !== logsId),
  logsRoute: showLogs ? routes.find(({ id }) => id === logsId) : undefined,
  settingsRoute: routes.find(({ id }) => id === settingsId),
});
