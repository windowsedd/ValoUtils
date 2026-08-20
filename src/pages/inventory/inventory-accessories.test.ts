import { describe, expect, test } from "bun:test";
import type { InventoryItem } from "./inventory-state";
import {
	groupAccessories,
	resolveOwnedAccessories,
	type AccessoryRecord,
} from "./inventory-accessories";

const rec = (partial: AccessoryRecord): AccessoryRecord => partial;

const item = (id: string, kind: InventoryItem["kind"]): InventoryItem => ({
	itemId: id,
	itemTypeId: kind,
	kind,
	price: null,
});

describe("owned accessories", () => {
	const records = new Map<string, AccessoryRecord>();
	const buddy = rec({
		id: "0f7bab6f-4658-cb35-ea4d-758634c4b14a",
		parentId: "buddy-parent",
		kind: "buddies",
		name: "Skymage",
		icon: "buddy.png",
	});
	const spray = rec({
		id: "spray-1",
		parentId: "spray-1",
		kind: "sprays",
		name: "Goat Spray",
		icon: "spray.png",
	});
	const title = rec({
		id: "title-1",
		parentId: "title-1",
		kind: "titles",
		name: "Primordial Title",
		icon: "",
	});
	const flex = rec({
		id: "1ff7899e-4c5b-1e49-e2d3-479a6b61c1a0",
		parentId: "1ff7899e-4c5b-1e49-e2d3-479a6b61c1a0",
		kind: "flex",
		name: "Aeris Flex",
		icon: "flex.png",
	});
	const passBuddy = rec({
		id: "pass-buddy",
		parentId: "pass-buddy-parent",
		kind: "buddies",
		name: "Pass Buddy",
		icon: "",
	});
	for (const row of [buddy, spray, title, flex, passBuddy]) {
		records.set(row.id, row);
		records.set(row.parentId, row);
	}

	const items: InventoryItem[] = [
		item(buddy.id, "buddies"),
		item(spray.id, "sprays"),
		item(title.id, "titles"),
		item(flex.id, "flex"),
		item(passBuddy.id, "buddies"),
		item("skin-1", "skins"),
	];

	test("dedupes parent/level ids and drops battle-pass accessories from the shop list", () => {
		const owned = resolveOwnedAccessories(items, records, new Set([passBuddy.id]));
		const groups = groupAccessories(owned);
		expect(groups.map((group) => group.kind)).toEqual(["buddies", "sprays", "titles", "flex"]);
		expect(groups.find((group) => group.kind === "buddies")?.items.map((row) => row.name)).toEqual([
			"Skymage",
		]);
		expect(groups.find((group) => group.kind === "flex")?.items.map((row) => row.name)).toEqual([
			"Aeris Flex",
		]);
		expect(groups.find((group) => group.kind === "flex")?.items[0]?.id).toBe(flex.id);
	});

	test("keeps flex even when the same uuid is a battle-pass totem", () => {
		const owned = resolveOwnedAccessories(items, records, new Set([flex.id]));
		const groups = groupAccessories(owned);
		expect(groups.find((group) => group.kind === "flex")?.items).toHaveLength(1);
	});
});
