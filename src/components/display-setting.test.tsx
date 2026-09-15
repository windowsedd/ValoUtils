import { describe, expect, test } from "bun:test";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/i18n/locales/en.json";
import { DisplaySelect } from "./display-setting";

void i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en",
  resources: { en: { translation: en } },
  initImmediate: false,
});

const monitors = [
  { id: "first", name: "DISPLAY1", width: 1920, height: 1080, primary: true },
  { id: "second", name: "DISPLAY2", width: 2560, height: 1440, primary: false },
];
const render = (selected: string, busy = false, failed = false) => renderToStaticMarkup(
  <DisplaySelect monitors={monitors} selected={selected} busy={busy} failed={failed} onSelect={() => {}} onRefresh={() => {}} />,
);

describe("display settings", () => {
  test("shows the saved monitor, resolutions, and primary display", () => {
    const markup = render("second");
    expect(markup).toContain('value="second" selected=""');
    expect(markup).toContain("DISPLAY2 · 2560 × 1440");
    expect(markup).toContain("DISPLAY1 · 1920 × 1080 · Primary");
    expect(markup).toContain('aria-label="Open on display"');
  });

  test("keeps a disconnected selection visible instead of silently replacing it", () => {
    const markup = render("unplugged");
    expect(markup).toContain("unplugged (disconnected)");
    expect(markup).toContain("Primary display");
    expect(markup).toContain('value="unplugged"');
  });

  test("disables changes while loading and offers retry after errors", () => {
    expect(render("", true)).toContain('disabled=""');
    const failed = render("first", false, true);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('aria-label="Refresh displays"');
    expect(failed).toContain("Could not load or save the display setting.");
  });
});
