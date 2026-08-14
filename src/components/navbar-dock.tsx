import { navbarLayout } from "@/components/navbar-layout";
import type { Route } from "@/types/router";
import { isOverflowRouteSelected } from "@/util/navbar-routes";
import { useEffect, useRef, useState, type RefObject } from "react";
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

export const getOverflowMenuFocusIndex = (key: string, focusIndex: number, itemCount: number) => {
  if (itemCount === 0) return null;

  switch (key) {
    case "ArrowDown":
      return (focusIndex + 1) % itemCount;
    case "ArrowUp":
      return (focusIndex - 1 + itemCount) % itemCount;
    case "Home":
      return 0;
    case "End":
      return itemCount - 1;
    default:
      return null;
  }
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
  const [overflowFocusIndex, setOverflowFocusIndex] = useState(0);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const previousOverflowOpen = useRef(overflowOpen);

  useEffect(() => {
    const opening = overflowOpen && !previousOverflowOpen.current;

    if (opening && overflowFocusIndex !== 0) {
      setOverflowFocusIndex(0);
    }

    if (overflowOpen) {
      menuItemRefs.current[opening ? 0 : overflowFocusIndex]?.focus();
    }

    previousOverflowOpen.current = overflowOpen;
  }, [overflowFocusIndex, overflowOpen]);

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
            ref={moreTriggerRef}
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
              {overflowRoutes.map((route, index) => (
                <button
                  key={route.id}
                  type="button"
                  role="menuitem"
                  aria-current={route.id === selectedId ? "page" : undefined}
                  className={`${navbarLayout.overflowItem} ${route.id === selectedId ? navbarLayout.overflowItemActive : ""}`}
                  onClick={() => onSelect(route.id)}
                  onFocus={() => setOverflowFocusIndex(index)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onOverflowOpenChange(false);
                      moreTriggerRef.current?.focus();
                      return;
                    }

                    const nextFocusIndex = getOverflowMenuFocusIndex(
                      event.key,
                      index,
                      overflowRoutes.length,
                    );

                    if (nextFocusIndex !== null) {
                      event.preventDefault();
                      setOverflowFocusIndex(nextFocusIndex);
                    }
                  }}
                  ref={(element) => {
                    menuItemRefs.current[index] = element;
                  }}
                  tabIndex={index === overflowFocusIndex ? 0 : -1}
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
