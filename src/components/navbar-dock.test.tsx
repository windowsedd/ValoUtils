import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Route } from "@/types/router";
import { NavbarDock } from "./navbar-dock";

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
});
