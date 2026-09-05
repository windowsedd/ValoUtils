import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "valorant-assets.ts"), "utf8");

describe("kingdom / accessory store valorant-api.com lookup", () => {
  test("gun buddies resolve through buddy levels, matching battle pass rewards", () => {
    // The storefront sells charm *levels* (same id space as EquippableCharmLevel
    // on contracts). `/buddies/{id}` 404s on those uuids.
    expect(source).toContain('"dd3bf334-87f3-40bd-b043-682a57a8dc3a": "buddies/levels"');
    expect(source).toContain('equippablecharmlevel: "buddies/levels"');
  });

  test("sprays, cards, titles and flex keep their own valorant-api.com endpoints", () => {
    expect(source).toContain('"d5f120f8-ff8c-4aac-92ea-f2b5acbe9475": "sprays"');
    expect(source).toContain('"290f8769-97c6-492a-a1a8-caacf3d5b325": "sprays/levels"');
    expect(source).toContain('"3f296c07-64c3-494c-923b-fe692a4fa1bd": "playercards"');
    expect(source).toContain('"de7caa6b-adf7-4588-bbd1-143831e786c6": "playertitles"');
    expect(source).toContain('"03a572de-4234-31ed-d344-ababa488f981": "flex"');
  });

  test("featured-bundle rows resolve by item type instead of skinlevels only", () => {
    expect(source).toContain("export const getStoreItem");
    expect(source).toContain("e7c63390-eda7-46e0-bb7a-a6abdacd2433");
  });

  test("inventory loads bulk valorant-api.com catalogs instead of per-item fetches", () => {
    expect(source).toContain("export const getInventoryIndex");
    expect(source).toContain("/weapons?language=all");
    expect(source).toContain("/sprays?language=all");
    expect(source).toContain("/buddies?language=all");
    expect(source).toContain("/playercards?language=all");
    expect(source).toContain("/playertitles?language=all");
    expect(source).toContain("/flex?language=all");
    expect(source).toContain("/themes?language=all");
  });
});
