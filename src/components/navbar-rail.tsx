import { navbarLayout } from "@/components/navbar-layout";
import type { Route } from "@/types/router";
import { type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import valoUtilsIcon from "../../src-tauri/icons/icon.png";

type NavbarRailProps = {
  directRoutes: Route[];
  /** Present only while the user has asked for the Logs tab. */
  logsRoute?: Route;
  settingsRoute?: Route;
  selectedId: string;
  translate: (key: string) => string;
  onSelect: (id: string) => void;
  statusControl: ReactNode;
};

type RailRouteButtonProps = {
  route: Route;
  active: boolean;
  translate: (key: string) => string;
  onSelect: (id: string) => void;
};

/** Route button with a shadcn/ui Tooltip to its right (hover and keyboard focus). */
const RailRouteButton = ({ route, active, translate, onSelect }: RailRouteButtonProps) => {
  const label = translate(route.title);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          data-tooltip={label}
          className={`${navbarLayout.railButton} ${active ? navbarLayout.railButtonActive : navbarLayout.railButtonInactive}`}
          onClick={() => onSelect(route.id)}
        >
          <span className={navbarLayout.railIcon} aria-hidden="true">{route.icon}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className={navbarLayout.tooltip}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
};

export const NavbarRail = ({
  directRoutes,
  logsRoute,
  settingsRoute,
  selectedId,
  translate,
  onSelect,
  statusControl,
}: NavbarRailProps) => (
  <aside className={navbarLayout.rail} data-command-rail="compact">
    <div className={navbarLayout.dock} data-rail-dock="">
    <div className={navbarLayout.railMark} aria-label="ValoUtils">
      <img
        src={valoUtilsIcon}
        alt=""
        aria-hidden="true"
        data-brand-mark="valoutils-icon"
        className="h-8 w-8 object-contain"
      />
    </div>

    <nav className={navbarLayout.railNav} aria-label="Primary navigation">
      <div className={navbarLayout.railRoutes} data-rail-section="routes">
        {directRoutes.map((route) => (
          <RailRouteButton
            key={route.id}
            route={route}
            active={route.id === selectedId}
            translate={translate}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div className={navbarLayout.railBottom} data-rail-section="bottom">
        {logsRoute && (
          <RailRouteButton
            route={logsRoute}
            active={logsRoute.id === selectedId}
            translate={translate}
            onSelect={onSelect}
          />
        )}
        {settingsRoute && (
          <RailRouteButton
            route={settingsRoute}
            active={settingsRoute.id === selectedId}
            translate={translate}
            onSelect={onSelect}
          />
        )}
      </div>
    </nav>

    <div className={navbarLayout.railStatus}>{statusControl}</div>
    </div>
  </aside>
);
