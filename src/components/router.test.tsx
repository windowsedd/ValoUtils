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
    const markup = renderToStaticMarkup(
      <RouterProvider
        routes={[route("profiles"), route("settings")]}
      >
        <Router />
      </RouterProvider>,
    );

    expect(markup).toContain('data-router-layout="command-rail"');
    expect(markup).toContain('data-command-rail="compact"');
    expect(markup).toContain('data-status-layout="compact"');
    expect(markup).toContain("profiles page");
    expect(markup).not.toContain("VALOUTILS");
  });
});
