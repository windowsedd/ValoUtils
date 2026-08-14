import { navbarLayout } from "@/components/navbar-layout";
import type { Route } from "@/types/router";
import { isOverflowRouteSelected } from "@/util/navbar-routes";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FaEllipsis } from "react-icons/fa6";

type NavbarDockProps = {
  dockRoutes: Route[];
  overflowRoutes: Route[];
  selectedId: string;
  overflowOpen: boolean;
  overflowRef: RefObject<HTMLDivElement | null>;
  overflowMenuRef?: RefObject<HTMLDivElement | null>;
  moreLabel: string;
  translate: (key: string) => string;
  onSelect: (id: string) => void;
  onOverflowOpenChange: (open: boolean) => void;
};

const overflowMenuWidth = 192;
const overflowMenuMargin = 8;
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export const getOverflowMenuPosition = (
  anchor: Pick<DOMRect, "bottom" | "right">,
  viewportWidth: number,
) => ({
  top: anchor.bottom + overflowMenuMargin,
  left: Math.max(
    overflowMenuMargin,
    Math.min(anchor.right - overflowMenuWidth, viewportWidth - overflowMenuWidth - overflowMenuMargin),
  ),
});

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

export const getRelativeFocusableIndex = (
  currentIndex: number,
  itemCount: number,
  direction: 1 | -1,
) => {
  const nextIndex = currentIndex + direction;
  return nextIndex >= 0 && nextIndex < itemCount ? nextIndex : null;
};

export const NavbarDock = ({
  dockRoutes,
  overflowRoutes,
  selectedId,
  overflowOpen,
  overflowRef,
  overflowMenuRef,
  moreLabel,
  translate,
  onSelect,
  onOverflowOpenChange,
}: NavbarDockProps) => {
  const [overflowFocusIndex, setOverflowFocusIndex] = useState(0);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const previousOverflowOpen = useRef(overflowOpen);
  const [overflowMenuPosition, setOverflowMenuPosition] = useState({ top: 0, left: 0 });

  useIsomorphicLayoutEffect(() => {
    if (!overflowOpen) return;

    const updateOverflowMenuPosition = () => {
      const triggerBounds = moreTriggerRef.current?.getBoundingClientRect();
      if (triggerBounds) {
        setOverflowMenuPosition(getOverflowMenuPosition(triggerBounds, window.innerWidth));
      }
    };

    updateOverflowMenuPosition();
    window.addEventListener("resize", updateOverflowMenuPosition);
    window.addEventListener("scroll", updateOverflowMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateOverflowMenuPosition);
      window.removeEventListener("scroll", updateOverflowMenuPosition, true);
    };
  }, [overflowOpen]);

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
  const selectOverflowRoute = (routeId: string) => {
    onSelect(routeId);
    moreTriggerRef.current?.focus();
  };
  const focusRelativeToMoreTrigger = (direction: 1 | -1) => {
    const focusableElements = Array.from(document.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => !overflowMenuRef?.current?.contains(element));
    const triggerIndex = focusableElements.indexOf(moreTriggerRef.current as HTMLButtonElement);
    const nextIndex = getRelativeFocusableIndex(triggerIndex, focusableElements.length, direction);

    focusableElements[nextIndex ?? -1]?.focus();
  };
  const overflowMenu = overflowOpen && (
    <div
      ref={overflowMenuRef}
      className={navbarLayout.overflowMenu}
      role="menu"
      style={overflowMenuPosition}
    >
      {overflowRoutes.map((route, index) => (
        <button
          key={route.id}
          type="button"
          role="menuitem"
          aria-current={route.id === selectedId ? "page" : undefined}
          className={`${navbarLayout.overflowItem} ${route.id === selectedId ? navbarLayout.overflowItemActive : ""}`}
          onClick={() => selectOverflowRoute(route.id)}
          onFocus={() => setOverflowFocusIndex(index)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onOverflowOpenChange(false);
              moreTriggerRef.current?.focus();
              return;
            }

            if (event.key === "Tab") {
              event.preventDefault();
              onOverflowOpenChange(false);
              focusRelativeToMoreTrigger(event.shiftKey ? -1 : 1);
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
  );

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
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onClick={() => onOverflowOpenChange(!overflowOpen)}
          >
            <FaEllipsis aria-hidden="true" />
            <span>{moreLabel}</span>
          </button>
          {overflowMenu && (typeof document === "undefined" ? overflowMenu : createPortal(overflowMenu, document.body))}
        </div>
      )}
    </nav>
  );
};
