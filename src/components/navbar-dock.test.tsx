import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Route } from "@/types/router";
import { getOverflowMenuFocusIndex, NavbarDock } from "./navbar-dock";

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

  test("marks More selected and exposes selected overflow item", () => {
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
    expect(markup).toContain('aria-current="page"');
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
});
