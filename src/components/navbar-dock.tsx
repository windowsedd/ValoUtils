import { navbarLayout } from "@/components/navbar-layout";
import type { Route } from "@/types/router";
import { isOverflowRouteSelected } from "@/util/navbar-routes";
import type { RefObject } from "react";
import { FaEllipsis } from "react-icons/fa6";

type NavbarDockProps = {
  dockRoutes: Route[];
  overflowRoutes: Route[];
  selectedId: string;
  overflowOpen: boolean;
  overflowRef: RefObject<HTMLDivElement | null>;
  moreLabel: string;
  translate: (key: string) => string;
  onSelect: (id: string) => void;
  onOverflowOpenChange: (open: boolean) => void;
};

export const NavbarDock = ({
  dockRoutes,
  overflowRoutes,
  selectedId,
  overflowOpen,
  overflowRef,
  moreLabel,
  translate,
  onSelect,
  onOverflowOpenChange,
}: NavbarDockProps) => {
  if (dockRoutes.length === 0) return null;

  const overflowSelected = isOverflowRouteSelected(overflowRoutes, selectedId);
  const tabClass = (active: boolean) =>
    `${navbarLayout.dockTab} ${active ? navbarLayout.dockTabActive : navbarLayout.dockTabInactive}`;

  return (
    <nav className={navbarLayout.dock} aria-label="Primary navigation">
      {dockRoutes.map((route) => (
        <button
          key={route.id}
          type="button"
          className={tabClass(route.id === selectedId)}
          aria-current={route.id === selectedId ? "page" : undefined}
          onClick={() => onSelect(route.id)}
        >
          {route.icon}
          <span>{translate(route.title)}</span>
        </button>
      ))}
      {overflowRoutes.length > 0 && (
        <div ref={overflowRef} className="relative">
          <button
            type="button"
            className={tabClass(overflowSelected)}
            aria-current={overflowSelected ? "page" : undefined}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onClick={() => onOverflowOpenChange(!overflowOpen)}
          >
            <FaEllipsis aria-hidden="true" />
            <span>{moreLabel}</span>
          </button>
          {overflowOpen && (
            <div className={navbarLayout.overflowMenu} role="menu">
              {overflowRoutes.map((route) => (
                <button
                  key={route.id}
                  type="button"
                  role="menuitem"
                  aria-current={route.id === selectedId ? "page" : undefined}
                  className={`${navbarLayout.overflowItem} ${route.id === selectedId ? navbarLayout.overflowItemActive : ""}`}
                  onClick={() => onSelect(route.id)}
                >
                  {route.icon}
                  <span>{translate(route.title)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
};
