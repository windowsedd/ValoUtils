import { describe, expect, test } from "bun:test";
import { filterInventory, sumSpend, type InventoryItem } from "./inventory-state";

const item = (
  id: string,
  kind: InventoryItem["kind"],
  price: InventoryItem["price"] = null,
): InventoryItem => ({
  itemId: id,
  itemTypeId: kind,
  kind,
  price,
});

const names = new Map([
  ["skin-1", "Reaver Vandal"],
  ["spray-1", "Mic Drop Spray"],
  ["card-1", "Omen Card"],
]);

describe("inventory filters and spend", () => {
  const items: InventoryItem[] = [
    item("skin-1", "skins", { amount: 1775, currency: "valorantPoints" }),
    item("skin-2", "skins", { amount: 875, currency: "valorantPoints" }),
    item("spray-1", "sprays", { amount: 4250, currency: "kingdomCredits" }),
    item("card-1", "cards", { amount: 0, currency: "kingdomCredits" }),
    item("title-1", "titles", null),
  ];

  test("kind filter keeps only that shelf", () => {
    expect(filterInventory(items, "skins", "", names).map((row) => row.itemId)).toEqual([
      "skin-1",
      "skin-2",
    ]);
    expect(filterInventory(items, "all", "", names)).toHaveLength(5);
  });

  test("search matches localized names and falls back to the raw id", () => {
    expect(filterInventory(items, "all", "vandal", names).map((row) => row.itemId)).toEqual([
      "skin-1",
    ]);
    expect(filterInventory(items, "all", "TITLE-1", names).map((row) => row.itemId)).toEqual([
      "title-1",
    ]);
    expect(filterInventory(items, "skins", "spray", names)).toEqual([]);
  });

  test("spend sums current catalog prices and ignores free or unpriced items", () => {
    expect(sumSpend(items)).toEqual({
      valorantPoints: 2650,
      kingdomCredits: 4250,
      radianite: 0,
    });
    expect(sumSpend(filterInventory(items, "skins", "", names))).toEqual({
      valorantPoints: 2650,
      kingdomCredits: 0,
      radianite: 0,
    });
  });
});
