import { navbarLayout } from "@/components/navbar-layout";
import type { Route } from "@/types/router";
import type { ReactNode } from "react";
import valoUtilsIcon from "../../src-tauri/icons/icon.png";

type NavbarRailProps = {
  directRoutes: Route[];
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

const RailRouteButton = ({ route, active, translate, onSelect }: RailRouteButtonProps) => {
  const label = translate(route.title);

  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      data-tooltip={label}
      className={`${navbarLayout.railButton} ${active ? navbarLayout.railButtonActive : navbarLayout.railButtonInactive}`}
      onClick={() => onSelect(route.id)}
    >
      {active && <span className={navbarLayout.railSelectionMarker} aria-hidden="true" />}
      <span className={navbarLayout.railIcon} aria-hidden="true">{route.icon}</span>
      <span className={navbarLayout.tooltip} role="tooltip">{label}</span>
    </button>
  );
};

export const NavbarRail = ({
  directRoutes,
  settingsRoute,
  selectedId,
  translate,
  onSelect,
  statusControl,
}: NavbarRailProps) => (
  <aside className={navbarLayout.rail} data-command-rail="compact">
    <div className={navbarLayout.railMark} aria-label="ValoUtils">
      <img
        src={valoUtilsIcon}
        alt=""
        aria-hidden="true"
        data-brand-mark="valoutils-icon"
        className="h-10 w-10 object-contain"
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
  </aside>
);
