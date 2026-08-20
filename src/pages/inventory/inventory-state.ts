export type InventoryKind = "skins" | "sprays" | "buddies" | "cards" | "titles" | "flex";
export type InventoryCurrency = "valorantPoints" | "radianite" | "kingdomCredits" | "unknown";
export type InventoryPrice = { amount: number; currency: InventoryCurrency };

export type InventoryItem = {
	itemId: string;
	itemTypeId: string;
	kind: InventoryKind;
	price: InventoryPrice | null;
};

export const INVENTORY_KINDS: InventoryKind[] = ["skins", "sprays", "cards", "buddies", "titles", "flex"];

export const filterInventory = (
	items: readonly InventoryItem[],
	kind: "all" | InventoryKind,
	query: string,
	names: ReadonlyMap<string, string>,
): InventoryItem[] => {
	const needle = query.trim().toLowerCase();
	return items.filter((item) => {
		if (kind !== "all" && item.kind !== kind) return false;
		if (!needle) return true;
		const name = names.get(item.itemId.toLowerCase()) ?? "";
		return name.toLowerCase().includes(needle) || item.itemId.toLowerCase().includes(needle);
	});
};

export const sumSpend = (items: readonly InventoryItem[]) => {
	let valorantPoints = 0;
	let kingdomCredits = 0;
	let radianite = 0;
	for (const item of items) {
		if (!item.price || item.price.amount <= 0) continue;
		if (item.price.currency === "valorantPoints") valorantPoints += item.price.amount;
		else if (item.price.currency === "kingdomCredits") kingdomCredits += item.price.amount;
		else if (item.price.currency === "radianite") radianite += item.price.amount;
	}
	return { valorantPoints, kingdomCredits, radianite };
};
