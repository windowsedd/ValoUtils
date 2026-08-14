import { describe, expect, test } from "bun:test";
import i18n from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next";
import type { Route } from "@/types/router";
import { Router, RouterProvider } from "./router";

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: {} } },
  initImmediate: false,
});

const route = (id: string): Route => ({
  id,
  title: `nav.${id}`,
  icon: <span>{id[0]}</span>,
  component: <section>{id} page</section>,
});

describe("Router command rail layout", () => {
  test("renders the compact rail beside the selected page", () => {
    const routes = [
      "profiles",
      "career",
      "matches",
      "live-game",
      "friends",
      "chat",
      "replays",
      "settings",
      "about",
      "fake-player",
    ].map(route);
    const markup = renderToStaticMarkup(
      <RouterProvider
        routes={routes}
      >
        <Router />
      </RouterProvider>,
    );

    expect(markup).toContain('data-router-layout="command-rail"');
    expect(markup).toContain('data-command-rail="compact"');
    expect(markup).toContain('data-status-layout="compact"');
    expect(markup).toContain("profiles page");
    expect(markup).not.toContain("VALOUTILS");
    expect(markup).toContain('aria-label="nav.about"');
    expect(markup).toContain('aria-label="nav.fake-player"');
    expect(markup).not.toContain('aria-label="nav.more"');
  });
});
