import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { navbarLayout } from "../src/components/navbar-layout";

const root = join(import.meta.dir, "..");
const statusBar = readFileSync(join(root, "src/components/riot-status-bar.tsx"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;

describe("navbarLayout", () => {
  test("keeps the fixed rail surface open for portaled controls", () => {
    expect(navbarLayout.rail).toContain("w-16");
    expect(navbarLayout.rail).toContain("overflow-visible");
  });

  test("keeps Settings and account controls visible while routes scroll vertically", () => {
    expect(navbarLayout.railRoutes).toContain("min-h-0");
    expect(navbarLayout.railRoutes).toContain("overflow-y-auto");
    expect(navbarLayout.railBottom).toContain("shrink-0");
    expect(navbarLayout.railStatus).toContain("shrink-0");
  });

  test("uses airy direct-route spacing on 40px tiles", () => {
    expect(navbarLayout.railRoutes).toContain("gap-2");
    expect(navbarLayout.railButton).toContain("h-10");
    expect(navbarLayout.railButton).toContain("w-10");
  });

  test("marks the selected route with a solid accent tile, not a tick", () => {
    expect(navbarLayout.railButtonActive).toContain("bg-(--accent)");
    expect(navbarLayout.railButtonActive).toContain("text-(--accent-foreground)");
    expect(navbarLayout).not.toHaveProperty("railSelectionMarker");
  });

  test("contains status menu content within the viewport", () => {
    const layout = navbarLayout as Record<string, string>;
    expect(layout.statusMenu ?? "").toContain("max-w-[calc(100vw-1rem)]");
    expect(layout.statusMessage ?? "").toContain("whitespace-normal");
    expect(layout.statusMessage ?? "").toContain("break-words");
  });

  test("uses the Riot ID as the single account and presence menu trigger", () => {
    expect(statusBar).toContain('aria-haspopup="menu"');
    expect(statusBar).toContain("info.username");
    expect(statusBar).not.toContain('className="min-w-0 w-7 h-7');
  });

  test("moves the settings eye action into the account menu", () => {
    expect(statusBar).toContain('t("riotStatus.viewSettings")');
    for (const locale of locales) {
      const messages = JSON.parse(
        readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
      );
      expect(messages.riotStatus.viewSettings).toBeString();
    }
  });
});
