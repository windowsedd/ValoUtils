import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "src/main.tsx"), "utf8");
const page = readFileSync(join(root, "src/pages/Tools.tsx"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;
const requiredToolsKeys = [
  "title",
  "subtitle",
  "searchPlaceholder",
  "search",
  "searching",
  "invalidInput",
  "playerNotFound",
  "loginRequired",
  "unavailable",
  "lookup",
  "inventory",
  "lookupDesc",
  "inventoryDesc",
  "allTools",
] as const;

describe("Tools navigation and player lookup shell", () => {
  test("adds a hideable Tools route after Chat", () => {
    expect(main).toContain('import Tools from "@/pages/Tools.tsx"');
    expect(main).toContain('title: "nav.tools"');
    expect(main).toContain('id: "tools"');
    expect(main.indexOf('id: "chat"')).toBeLessThan(main.indexOf('id: "tools"'));
    expect(main.indexOf('id: "tools"')).toBeLessThan(main.indexOf('id: "settings"'));
  });

  test("keeps the search bar visible and reuses the friend profile pipeline", () => {
    expect(page).toContain('data-tools-search=""');
    expect(page).toContain('send("tools:player:resolve"');
    expect(page).toContain('send("friend:profile:get"');
    expect(page).toContain("<FriendProfile");
    expect(page).toContain("embedded");
    expect(page).toContain('send("analytics:track", "tools:player:lookup"');
    expect(page).toContain("<Inventory embedded");
  });

  test("opens on a grid of tool cards that each select a tool", () => {
    expect(page).toContain('data-tools-grid=""');
    expect(page).toContain("data-tool={entry.id}");
    expect(page).toContain("setTool(entry.id)");
    // The index is the landing state, and every tool can get back to it.
    expect(page).toContain("useState<ToolId | null>(null)");
    expect(page).toContain('data-tools-back=""');
    expect(page).toContain("setTool(null)");
    // A tool takes the page over rather than rendering beneath the grid.
    expect(page).toContain('{tool === "lookup" && (');
    expect(page).toContain('{tool === "inventory" && (');
  });

  test("stacks the search bar above the profile instead of sharing a row", () => {
    expect(page).toContain('data-tools-profile=""');
    expect(page).toMatch(/flex min-h-0 flex-1 flex-col gap-4/);
    expect(page).toMatch(/data-tools-profile=""[\s\S]*<FriendProfile/);
    expect(page.indexOf("data-tools-search=")).toBeLessThan(page.indexOf("data-tools-profile="));
  });

  for (const locale of locales) {
    test(`${locale} localizes Tools navigation and lookup states`, () => {
      const messages = JSON.parse(
        readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
      );
      expect(messages.nav.tools).toBeString();
      expect(messages.nav.tools.trim().length).toBeGreaterThan(0);
      for (const key of requiredToolsKeys) {
        expect(messages.tools[key]).toBeString();
        expect((messages.tools[key] as string).trim().length).toBeGreaterThan(0);
      }
    });
  }
});
