import { describe, expect, test } from "bun:test";
import type { InventoryItem } from "./inventory-state";
import {
  estimateTopUp,
  listPrice,
  resolveOwnedSkins,
  summarizeSkins,
  type SkinRecord,
  type SkinTheme,
} from "./inventory-skins";

const rec = (
  partial: Partial<SkinRecord> & Pick<SkinRecord, "skinId" | "weaponId">,
): SkinRecord => ({
  levelIds: [`${partial.skinId}-lv1`],
  name: partial.skinId,
  icon: "",
  weaponName: partial.weaponId,
  melee: false,
  themeId: null,
  themeName: null,
  tierName: "Premium",
  standard: false,
  ...partial,
});

const item = (id: string, kind: InventoryItem["kind"] = "skins"): InventoryItem => ({
  itemId: id,
  itemTypeId: kind,
  kind,
  price: null,
});

describe("skin list prices and top-up", () => {
  test("melee is twice the gun list price of the same rarity", () => {
    expect(listPrice("Exclusive", false)).toBe(2175);
    expect(listPrice("Exclusive", true)).toBe(4350);
    expect(listPrice("Ultra", false)).toBe(2475);
    expect(listPrice("Premium", false)).toBe(1775);
    expect(listPrice("Exclusive", true, 4000)).toBe(4000);
  });

  test("228,475 VP converts to the report's USD and TWD", () => {
    expect(estimateTopUp(228_475)).toEqual({ usd: 354.9, twd: 63_090 });
    expect(estimateTopUp(0)).toEqual({ usd: 0, twd: 0 });
  });
});

describe("purchased skin summary", () => {
  const skinsByItemId = new Map<string, SkinRecord>();
  const put = (record: SkinRecord) => {
    skinsByItemId.set(record.skinId, record);
    for (const level of record.levelIds) skinsByItemId.set(level, record);
  };
  const wing = rec({
    skinId: "wing-vandal",
    weaponId: "vandal",
    weaponName: "Vandal",
    name: "星靈夢翼 暴徒",
    themeId: "wing",
    themeName: "星靈夢翼",
    tierName: "Ultra",
  });
  const wingMelee = rec({
    skinId: "wing-knife",
    weaponId: "melee",
    weaponName: "Melee",
    name: "夢想星翼 魔杖",
    melee: true,
    themeId: "wing",
    themeName: "星靈夢翼",
    tierName: "Exclusive",
  });
  const champVandal = rec({
    skinId: "c23-vandal",
    weaponId: "vandal",
    weaponName: "Vandal",
    name: "Champions 2023 暴徒",
    themeId: "c23",
    themeName: "Champions 2023",
    tierName: "Exclusive",
  });
  const champKnife = rec({
    skinId: "c23-knife",
    weaponId: "melee",
    weaponName: "Melee",
    name: "Champions 2023 苦無",
    melee: true,
    themeId: "c23",
    themeName: "Champions 2023",
    tierName: "Exclusive",
  });
  const passSkin = rec({
    skinId: "bp-vandal",
    weaponId: "vandal",
    weaponName: "Vandal",
    name: "Pass Vandal",
    tierName: "Premium",
  });
  const selectSkin = rec({
    skinId: "select-classic",
    weaponId: "classic",
    weaponName: "Classic",
    name: "Select Classic",
    tierName: "Select",
  });
  const standard = rec({
    skinId: "std-vandal",
    weaponId: "vandal",
    weaponName: "Vandal",
    name: "Standard Vandal",
    tierName: null,
    standard: true,
  });
  for (const record of [wing, wingMelee, champVandal, champKnife, passSkin, selectSkin, standard]) {
    put(record);
  }

  const items: InventoryItem[] = [
    item("wing-vandal-lv1"),
    item("wing-knife-lv1"),
    item("c23-vandal-lv1"),
    item("c23-knife-lv1"),
    item("bp-vandal-lv1"),
    item("select-classic-lv1"),
    item("std-vandal-lv1"),
    item("spray-1", "sprays"),
  ];
  const passRewardIds = new Set(["bp-vandal-lv1"]);
  const themes = new Map<string, SkinTheme>(
    [
      { id: "wing", name: "星靈夢翼", skinIds: ["wing-vandal", "wing-knife"] },
      { id: "c23", name: "Champions 2023", skinIds: ["c23-vandal", "c23-knife"] },
    ].map((theme) => [theme.id, theme]),
  );

  test("counts purchased guns and knives, dropping pass, Select and standard", () => {
    const owned = resolveOwnedSkins(items, skinsByItemId, passRewardIds);
    const summary = summarizeSkins(owned, items, passRewardIds, themes);
    expect(summary.guns).toBe(2);
    expect(summary.knives).toBe(2);
    expect(summary.totalVp).toBe(2475 + 4350 + 2175 + 4350);
    expect(summary.passCount).toBe(1);
    expect(summary.inventoryCount).toBe(8);
    expect(summary.purchasedCount).toBe(7);
    expect(summary.excludedRarity).toBe("Select");
  });

  test("complete shop sets skip pass skins and list melee first", () => {
    const owned = resolveOwnedSkins(items, skinsByItemId, passRewardIds);
    const summary = summarizeSkins(owned, items, passRewardIds, themes);
    expect(summary.completeSets.map((set) => set.name)).toEqual(["星靈夢翼", "Champions 2023"]);
    expect(summary.completeSets[0]).toMatchObject({ owned: 2, total: 2, vp: 2475 + 4350 });
    expect(summary.completeSets[1]).toMatchObject({ owned: 2, total: 2, vp: 2175 + 4350 });
    expect(summary.weaponGroups[0]?.melee).toBe(true);
    expect(summary.weaponGroups[0]?.skins).toHaveLength(2);
    expect(summary.rarities.find((row) => row.tier === "Exclusive")?.count).toBe(3);
    expect(summary.rarities.find((row) => row.tier === "Ultra")?.count).toBe(1);
  });
});
