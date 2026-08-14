import { describe, expect, test } from "bun:test";
import i18n from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next";
import { navbarLayout } from "./navbar-layout";
import RiotStatusBar from "./riot-status-bar";

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: {} } },
  initImmediate: false,
});

describe("RiotStatusBar", () => {
  test("compact mode keeps status accessible without visible account text", () => {
    const markup = renderToStaticMarkup(<RiotStatusBar compact />);

    expect(markup).toContain('data-status-layout="compact"');
    expect(markup).toContain('aria-label="riotStatus.connecting"');
    expect(markup).toContain('data-tooltip="riotStatus.connecting"');
    expect(markup).not.toContain("max-w-28 truncate");
    expect(navbarLayout.statusTooltip).toContain("absolute");
    expect(navbarLayout.statusTooltip).toContain("left-full");
    expect(navbarLayout.statusTooltip).not.toContain("fixed");
  });
});
