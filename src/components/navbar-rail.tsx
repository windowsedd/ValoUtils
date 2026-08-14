import { navbarLayout } from "@/components/navbar-layout";
import type { Route } from "@/types/router";
import { isOverflowRouteSelected } from "@/util/navbar-routes";
import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { FaEllipsis } from "react-icons/fa6";

type NavbarRailProps = {
  directRoutes: Route[];
  overflowRoutes: Route[];
  settingsRoute?: Route;
  selectedId: string;
  overflowOpen: boolean;
  overflowRef: RefObject<HTMLDivElement | null>;
  overflowMenuRef?: RefObject<HTMLDivElement | null>;
  moreLabel: string;
  translate: (key: string) => string;
  onSelect: (id: string) => void;
  onOverflowOpenChange: (open: boolean) => void;
  statusControl: ReactNode;
};

type RailRouteButtonProps = {
  route: Route;
  active: boolean;
  translate: (key: string) => string;
  onSelect: (id: string) => void;
};

const overflowMenuMaxHeight = 192;
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
  anchor: Pick<DOMRect, "top" | "right">,
  viewportHeight: number,
) => ({
  top: Math.max(
    overflowMenuMargin,
    Math.min(anchor.top, viewportHeight - overflowMenuMaxHeight - overflowMenuMargin),
  ),
  left: anchor.right + overflowMenuMargin,
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
  overflowRoutes,
  settingsRoute,
  selectedId,
  overflowOpen,
  overflowRef,
  overflowMenuRef,
  moreLabel,
  translate,
  onSelect,
  onOverflowOpenChange,
  statusControl,
}: NavbarRailProps) => {
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
        setOverflowMenuPosition(getOverflowMenuPosition(triggerBounds, window.innerHeight));
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

    if (opening && overflowFocusIndex !== 0) setOverflowFocusIndex(0);
    if (overflowOpen) menuItemRefs.current[opening ? 0 : overflowFocusIndex]?.focus();

    previousOverflowOpen.current = overflowOpen;
  }, [overflowFocusIndex, overflowOpen]);

  const overflowSelected = isOverflowRouteSelected(overflowRoutes, selectedId);
  const railButtonClass = (active: boolean) =>
    `${navbarLayout.railButton} ${active ? navbarLayout.railButtonActive : navbarLayout.railButtonInactive}`;
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
          <span aria-hidden="true">{route.icon}</span>
          <span>{translate(route.title)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <aside className={navbarLayout.rail} data-command-rail="compact">
      <div className={navbarLayout.railMark} aria-label="ValoUtils">
        <span aria-hidden="true">V</span>
      </div>

      <nav className={navbarLayout.railNav} aria-label="Primary navigation">
        {directRoutes.map((route) => (
          <RailRouteButton
            key={route.id}
            route={route}
            active={route.id === selectedId}
            translate={translate}
            onSelect={onSelect}
          />
        ))}

        {overflowRoutes.length > 0 && (
          <div ref={overflowRef} className="relative">
            <button
              ref={moreTriggerRef}
              type="button"
              aria-label={moreLabel}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              data-tooltip={moreLabel}
              className={railButtonClass(overflowSelected)}
              onClick={() => onOverflowOpenChange(!overflowOpen)}
            >
              {overflowSelected && <span className={navbarLayout.railSelectionMarker} aria-hidden="true" />}
              <FaEllipsis className={navbarLayout.railIcon} aria-hidden="true" />
              <span className={navbarLayout.tooltip} role="tooltip">{moreLabel}</span>
            </button>
            {overflowMenu && (
              typeof document === "undefined"
                ? overflowMenu
                : createPortal(overflowMenu, document.body)
            )}
          </div>
        )}

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
};
