import { describe, expect, test } from "bun:test";
import i18n from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next";
import { BotLanguageCombobox } from "./bot-language-combobox";

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: {} } },
  initImmediate: false,
});

describe("BotLanguageCombobox", () => {
  // Radix `asChild` needs exactly one element child; stray JSX text crashed the Bot page.
  test("renders the field inside the popover anchor without crashing", () => {
    const markup = renderToStaticMarkup(
      <BotLanguageCombobox value="auto" onChange={() => {}} provider="google" inputClassName="field" />,
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('value="auto"');
    expect(markup).toContain('aria-expanded="false"');
  });
});
