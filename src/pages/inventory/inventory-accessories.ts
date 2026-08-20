import type { Localized } from "@/util/valorant-assets";
import type { InventoryItem } from "./inventory-state";

export type AccessoryKind = "buddies" | "sprays" | "cards" | "titles" | "flex";

export const ACCESSORY_KINDS: AccessoryKind[] = ["buddies", "sprays", "cards", "titles", "flex"];

export type AccessoryRecord = {
	id: string;
	parentId: string;
	kind: AccessoryKind;
	name: Localized;
	icon: string;
};

export type OwnedAccessory = AccessoryRecord & {
	fromPass: boolean;
};

export type AccessoryGroup = {
	kind: AccessoryKind;
	items: OwnedAccessory[];
};

export const resolveOwnedAccessories = (
	items: readonly InventoryItem[],
	records: ReadonlyMap<string, AccessoryRecord>,
	passRewardIds: ReadonlySet<string>,
): OwnedAccessory[] => {
	const byParent = new Map<string, OwnedAccessory>();
	for (const item of items) {
		if (item.kind === "skins") continue;
		const record = records.get(item.itemId.toLowerCase());
		if (!record) continue;
		const fromPass =
			passRewardIds.has(record.id) ||
			passRewardIds.has(record.parentId) ||
			passRewardIds.has(item.itemId.toLowerCase());
		const existing = byParent.get(`${record.kind}:${record.parentId}`);
		if (existing) {
			existing.fromPass = existing.fromPass || fromPass;
			continue;
		}
		byParent.set(`${record.kind}:${record.parentId}`, { ...record, fromPass });
	}
	return [...byParent.values()];
};

export const groupAccessories = (owned: readonly OwnedAccessory[]): AccessoryGroup[] => {
	// Flex entitlements often also appear on event contracts; still list them.
	const purchased = owned.filter((item) => item.kind === "flex" || !item.fromPass);
	return ACCESSORY_KINDS.flatMap((kind) => {
		const items = purchased
			.filter((item) => item.kind === kind)
			.sort((a, b) => {
				const left = typeof a.name === "string" ? a.name : Object.values(a.name)[0] ?? "";
				const right = typeof b.name === "string" ? b.name : Object.values(b.name)[0] ?? "";
				return String(left).localeCompare(String(right));
			});
		return items.length ? [{ kind, items }] : [];
	});
};
