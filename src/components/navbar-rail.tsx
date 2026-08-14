import { navbarLayout } from "@/components/navbar-layout";
import type { Route } from "@/types/router";
import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

const tooltipGap = 12;
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export const getRailTooltipPosition = (
  anchor: Pick<DOMRect, "top" | "right" | "height">,
) => ({
  top: anchor.top + anchor.height / 2,
  left: anchor.right + tooltipGap,
});

const RailRouteButton = ({ route, active, translate, onSelect }: RailRouteButtonProps) => {
  const label = translate(route.title);
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });

  useIsomorphicLayoutEffect(() => {
    if (!tooltipVisible) return;

    const updateTooltipPosition = () => {
      const buttonBounds = buttonRef.current?.getBoundingClientRect();
      if (buttonBounds) setTooltipPosition(getRailTooltipPosition(buttonBounds));
    };

    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [tooltipVisible]);

  const tooltip = (
    <span
      id={tooltipId}
      className={`${navbarLayout.tooltip} ${tooltipVisible ? navbarLayout.tooltipVisible : navbarLayout.tooltipHidden}`}
      role="tooltip"
      aria-hidden={!tooltipVisible}
      style={tooltipPosition}
    >
      {label}
    </span>
  );

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      aria-describedby={tooltipVisible ? tooltipId : undefined}
      data-tooltip={label}
      className={`${navbarLayout.railButton} ${active ? navbarLayout.railButtonActive : navbarLayout.railButtonInactive}`}
      onClick={() => onSelect(route.id)}
      onPointerEnter={() => setTooltipVisible(true)}
      onPointerLeave={() => setTooltipVisible(false)}
      onFocus={() => setTooltipVisible(true)}
      onBlur={() => setTooltipVisible(false)}
    >
      {active && <span className={navbarLayout.railSelectionMarker} aria-hidden="true" />}
      <span className={navbarLayout.railIcon} aria-hidden="true">{route.icon}</span>
      {typeof document === "undefined" ? tooltip : createPortal(tooltip, document.body)}
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
