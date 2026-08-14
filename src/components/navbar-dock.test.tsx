import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Route } from "@/types/router";
import {
  getOverflowMenuFocusIndex,
  getOverflowMenuPosition,
  getRelativeFocusableIndex,
  NavbarDock,
} from "./navbar-dock";

const route = (id: string): Route => ({
  id,
  title: id,
  icon: <span>{id[0]}</span>,
  component: null,
});

describe("NavbarDock", () => {
  test("marks a direct route as current and omits More without overflow", () => {
    const markup = renderToStaticMarkup(
      <NavbarDock
        dockRoutes={[route("profiles")]}
        overflowRoutes={[]}
        selectedId="profiles"
        overflowOpen={false}
        overflowRef={{ current: null }}
        moreLabel="More"
        translate={(key) => key}
        onSelect={() => {}}
        onOverflowOpenChange={() => {}}
      />,
    );

    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  test("keeps More styled as selected while only the overflow route is current", () => {
    const markup = renderToStaticMarkup(
      <NavbarDock
        dockRoutes={[route("profiles")]}
        overflowRoutes={[route("settings")]}
        selectedId="settings"
        overflowOpen
        overflowRef={{ current: null }}
        moreLabel="More"
        translate={(key) => key}
        onSelect={() => {}}
        onOverflowOpenChange={() => {}}
      />,
    );

    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="menu"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/role="menuitem" aria-current="page"/);
    expect(markup).toContain("settings");
  });

  test("keeps the first overflow item as the initial tab stop", () => {
    const markup = renderToStaticMarkup(
      <NavbarDock
        dockRoutes={[route("profiles")]}
        overflowRoutes={[route("settings"), route("about")]}
        selectedId="profiles"
        overflowOpen
        overflowRef={{ current: null }}
        moreLabel="More"
        translate={(key) => key}
        onSelect={() => {}}
        onOverflowOpenChange={() => {}}
      />,
    );

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

  test("positions the portaled overflow menu below its trigger inside the viewport", () => {
    expect(getOverflowMenuPosition({ bottom: 100, right: 700 }, 760)).toEqual({
      top: 108,
      left: 508,
    });
    expect(getOverflowMenuPosition({ bottom: 100, right: 30 }, 760)).toEqual({
      top: 108,
      left: 8,
    });
  });

  test("finds the next or previous focusable control without wrapping", () => {
    expect(getRelativeFocusableIndex(2, 5, 1)).toBe(3);
    expect(getRelativeFocusableIndex(2, 5, -1)).toBe(1);
    expect(getRelativeFocusableIndex(0, 5, -1)).toBeNull();
    expect(getRelativeFocusableIndex(4, 5, 1)).toBeNull();
  });
});
