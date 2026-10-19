import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import en from "@/i18n/locales/en.json";
import ko from "@/i18n/locales/ko.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import type { BloomlineAgent } from "./bloomline-state";

// Asset helpers initialize the app language from browser storage.
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!storage)
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null },
  });
const { BloomlineContent } = await import("../Bloomline");
if (!storage) Reflect.deleteProperty(globalThis, "localStorage");

const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const agent: BloomlineAgent = {
  agentId: "jett",
  level: 0,
  longLevel: null,
  points: 0,
  stats: [{ numberId: "counter-id", moduleId: null, value: 0 }],
};
const render = (
  detail: BloomlineAgent | null,
  detailLoading = false,
  detailError: string | null = null,
) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <BloomlineContent
        agents={[agent]}
        assets={new Map([["jett", { name: "Jett", icon: "" }]])}
        selectedId="jett"
        onSelect={() => {}}
        detail={detail}
        detailLoading={detailLoading}
        detailError={detailError}
        onRetry={() => {}}
      />
    </I18nextProvider>,
  );

describe("Bloomline content", () => {
  test("shows zero progress and counters while leaving missing values unknown", () => {
    const markup = render(agent);
    expect(markup).toContain("Jett");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Search agents"');
    expect(markup).toContain(">0</span>");
    expect(markup).toContain(">—</span>");
    expect(markup).toContain(">0</dd>");
    expect(markup).toContain("counter-id");
    expect(markup).toContain("Stat slot 1");
  });

  test("distinguishes unavailable stats from an empty equipped list", () => {
    expect(render({ ...agent, stats: null })).toContain(en.bloomline.statsUnavailable);
    expect(render({ ...agent, stats: [] })).toContain(en.bloomline.noStats);
  });

  test("shows pending and recoverable failure states", () => {
    const loading = render(null, true);
    expect(loading).toContain('role="status"');
    expect(loading).toContain(en.bloomline.loadingStats.replace("'", "&#x27;"));
    const failed = render(null, false, "Request timed out");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Request timed out");
    expect(failed).toContain(en.bloomline.retry);
  });

  test("every shipped language defines Bloomline copy", () => {
    for (const locale of [en, ko, zhTW]) {
      expect(locale.nav.bloomline).toBeTruthy();
      expect(Object.keys(locale.bloomline).sort()).toEqual(Object.keys(en.bloomline).sort());
      for (const text of Object.values(locale.bloomline)) expect(text.trim()).not.toBe("");
    }
  });
});
