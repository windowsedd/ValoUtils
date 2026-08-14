import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Route } from "@/types/router";
import { navbarLayout } from "./navbar-layout";
import {
  getOverflowMenuFocusIndex,
  getOverflowMenuPosition,
  getRelativeFocusableIndex,
  NavbarRail,
} from "./navbar-rail";

const route = (id: string): Route => ({
  id,
  title: id,
  icon: <span>{id[0]}</span>,
  component: null,
});

const renderRail = (overrides: Partial<React.ComponentProps<typeof NavbarRail>> = {}) =>
  renderToStaticMarkup(
    <NavbarRail
      directRoutes={[route("profiles")]}
      overflowRoutes={[]}
      settingsRoute={route("settings")}
      selectedId="profiles"
      overflowOpen={false}
      overflowRef={{ current: null }}
      moreLabel="More"
      translate={(key) => key}
      onSelect={() => {}}
      onOverflowOpenChange={() => {}}
      statusControl={<button type="button">Account</button>}
      {...overrides}
    />,
  );

describe("NavbarRail", () => {
  test("renders a permanently compact icon rail with accessible names and tooltips", () => {
    const markup = renderRail();

    expect(markup).toContain('data-command-rail="compact"');
    expect(markup).toContain('aria-label="profiles"');
    expect(markup).toContain('data-tooltip="profiles"');
    expect(markup).toContain('role="tooltip"');
    expect(navbarLayout.rail).toContain("w-16");
    expect(navbarLayout.rail).toContain("min-w-16");
    expect(navbarLayout.rail).toContain("max-w-16");
    expect(navbarLayout.rail).not.toContain("hover:w-");
    expect(navbarLayout.rail).not.toContain("group-hover:w-");
  });

  test("pins Settings at the bottom and marks a direct route current", () => {
    const markup = renderRail();

    expect(markup).toContain('data-rail-section="bottom"');
    expect(markup).toContain('aria-label="settings"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  test("styles More as selected while only the exact overflow route is current", () => {
    const markup = renderRail({
      overflowRoutes: [route("about")],
      selectedId: "about",
      overflowOpen: true,
    });

    expect(markup).toContain('aria-label="More"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="menu"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/role="menuitem" aria-current="page"/);
  });

  test("keeps the first overflow item as the initial tab stop", () => {
    const markup = renderRail({
      overflowRoutes: [route("about"), route("dummy")],
      overflowOpen: true,
    });

    expect(markup).toMatch(/role="menuitem"[^>]*tabindex="0"/);
    expect(markup).toMatch(/role="menuitem"[^>]*tabindex="-1"/);
  });

  test("calculates cyclic menu focus for navigation keys", () => {
    expect(getOverflowMenuFocusIndex("ArrowDown", 1, 3)).toBe(2);
    expect(getOverflowMenuFocusIndex("ArrowDown", 2, 3)).toBe(0);
    expect(getOverflowMenuFocusIndex("ArrowUp", 0, 3)).toBe(2);
    expect(getOverflowMenuFocusIndex("Home", 2, 3)).toBe(0);
    expect(getOverflowMenuFocusIndex("End", 0, 3)).toBe(2);
    expect(getOverflowMenuFocusIndex("Tab", 1, 3)).toBeNull();
  });

  test("positions the portaled menu beside its trigger within the viewport", () => {
    expect(getOverflowMenuPosition({ top: 80, right: 64 }, 560)).toEqual({
      top: 80,
      left: 72,
    });
    expect(getOverflowMenuPosition({ top: 500, right: 64 }, 560)).toEqual({
      top: 360,
      left: 72,
    });
  });

  test("finds adjacent focusable controls without wrapping", () => {
    expect(getRelativeFocusableIndex(2, 5, 1)).toBe(3);
    expect(getRelativeFocusableIndex(2, 5, -1)).toBe(1);
    expect(getRelativeFocusableIndex(0, 5, -1)).toBeNull();
    expect(getRelativeFocusableIndex(4, 5, 1)).toBeNull();
  });
});
