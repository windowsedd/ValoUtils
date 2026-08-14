import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Route } from "@/types/router";
import { navbarLayout } from "./navbar-layout";
import { getRailTooltipPosition, NavbarRail } from "./navbar-rail";

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
      settingsRoute={route("settings")}
      selectedId="profiles"
      translate={(key) => key}
      onSelect={() => {}}
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
    expect(navbarLayout.tooltip).toContain("navbar-motion");
    expect(markup).toContain('data-brand-mark="valoutils-icon"');
    expect(markup).not.toContain(">V</span>");
  });

  test("pins Settings at the bottom and marks a direct route current", () => {
    const markup = renderRail();

    expect(markup).toContain('data-rail-section="bottom"');
    expect(markup).toContain('aria-label="settings"');
    expect(markup).toMatch(/<nav[^>]*>[\s\S]*aria-label="settings"[\s\S]*<\/nav>/);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  test("renders About and Bot directly without a More menu", () => {
    const markup = renderRail({
      directRoutes: [route("about"), route("fake-player")],
      selectedId: "about",
    });

    expect(markup).toContain('aria-label="about"');
    expect(markup).toContain('aria-label="fake-player"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="More"');
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  test("keeps only the middle route list scrollable", () => {
    expect(navbarLayout.railRoutes).toContain("overflow-y-auto");
    expect(navbarLayout.railRoutes).toContain("command-rail-scroll");
    expect(navbarLayout.tooltip).toContain("fixed");
    expect(navbarLayout.tooltip).not.toContain("absolute");
    expect(navbarLayout.railSelectionMarker).not.toContain("-left-");
    expect(navbarLayout.railBottom).not.toContain("overflow");
    expect(navbarLayout.railStatus).not.toContain("overflow");
  });

  test("positions portaled tooltips beside their rail button", () => {
    expect(getRailTooltipPosition({ top: 80, right: 56, height: 44 })).toEqual({
      top: 102,
      left: 68,
    });
  });
});
