import type { Localized } from "@/util/valorant-assets";
import type { InventoryItem } from "./inventory-state";

export const SELECT_TIER_ID = "12683d76-48d7-84a3-4e09-6985794f0445";

/** Shop list prices. Melee is 2× the gun price of the same rarity. */
export const TIER_GUN_VP: Record<string, number> = {
	Select: 875,
	Deluxe: 1275,
	Premium: 1775,
	Exclusive: 2175,
	Ultra: 2475,
};

/** CN reseller pack (90 VP / CNY) and 7.153 CNY / USD — matches 228,475 VP → 354.9 USD. */
const VP_PER_CNY = 90;
const CNY_PER_USD = 7.153;
/** Linear TWD from the same report: 228,475 VP → 63,090 TWD. */
const TWD_PER_VP = 63_090 / 228_475;

export type SkinTierName = "Select" | "Deluxe" | "Premium" | "Exclusive" | "Ultra";

export type SkinRecord = {
	skinId: string;
	levelIds: string[];
	name: Localized;
	icon: string;
	weaponId: string;
	weaponName: Localized;
	melee: boolean;
	themeId: string | null;
	themeName: Localized | null;
	tierName: SkinTierName | null;
	standard: boolean;
};

export type OwnedSkin = {
	skinId: string;
	name: Localized;
	icon: string;
	weaponId: string;
	weaponName: Localized;
	melee: boolean;
	themeId: string | null;
	themeName: Localized | null;
	tierName: SkinTierName | null;
	standard: boolean;
	fromPass: boolean;
	select: boolean;
	vp: number;
};

export type SkinTheme = {
	id: string;
	name: Localized;
	skinIds: string[];
};

export type CompleteSet = {
	id: string;
	name: Localized;
	owned: number;
	total: number;
	vp: number;
};

export type WeaponGroup = {
	weaponId: string;
	weaponName: Localized;
	melee: boolean;
	skins: OwnedSkin[];
	vp: number;
};

export type RarityRow = {
	tier: SkinTierName;
	count: number;
	vp: number;
};

export type SkinSummary = {
	guns: number;
	knives: number;
	totalVp: number;
	inventoryCount: number;
	passCount: number;
	purchasedCount: number;
	excludedRarity: "Select";
	rarities: RarityRow[];
	completeSets: CompleteSet[];
	completeSetsVp: number;
	weaponGroups: WeaponGroup[];
	usd: number;
	twd: number;
};

export const listPrice = (tierName: SkinTierName | null, melee: boolean, offerVp?: number): number => {
	if (offerVp && offerVp > 0) return offerVp;
	if (!tierName) return 0;
	const gun = TIER_GUN_VP[tierName] ?? 0;
	return melee ? gun * 2 : gun;
};

export const estimateTopUp = (vp: number): { usd: number; twd: number } => {
	if (vp <= 0) return { usd: 0, twd: 0 };
	const usd = Math.round((vp / VP_PER_CNY / CNY_PER_USD) * 10) / 10;
	const twd = Math.round(vp * TWD_PER_VP);
	return { usd, twd };
};

const offerVp = (item: InventoryItem): number =>
	item.price && item.price.currency === "valorantPoints" && item.price.amount > 0 ? item.price.amount : 0;

export const resolveOwnedSkins = (
	items: readonly InventoryItem[],
	skinsByItemId: ReadonlyMap<string, SkinRecord>,
	passRewardIds: ReadonlySet<string>,
): OwnedSkin[] => {
	const bySkin = new Map<string, OwnedSkin>();
	for (const item of items) {
		if (item.kind !== "skins") continue;
		const record = skinsByItemId.get(item.itemId.toLowerCase());
		if (!record) continue;
		const fromPass =
			passRewardIds.has(record.skinId) || record.levelIds.some((id) => passRewardIds.has(id));
		const vp = listPrice(record.tierName, record.melee, offerVp(item));
		const existing = bySkin.get(record.skinId);
		if (existing) {
			existing.fromPass = existing.fromPass || fromPass;
			if (vp > existing.vp) existing.vp = vp;
			continue;
		}
		bySkin.set(record.skinId, {
			skinId: record.skinId,
			name: record.name,
			icon: record.icon,
			weaponId: record.weaponId,
			weaponName: record.weaponName,
			melee: record.melee,
			themeId: record.themeId,
			themeName: record.themeName,
			tierName: record.tierName,
			standard: record.standard,
			fromPass,
			select: record.tierName === "Select",
			vp,
		});
	}
	return [...bySkin.values()];
};

const shopSkin = (skin: OwnedSkin) => !skin.standard && !skin.fromPass && !skin.select;

export const summarizeSkins = (
	owned: readonly OwnedSkin[],
	items: readonly InventoryItem[],
	passRewardIds: ReadonlySet<string>,
	themes: ReadonlyMap<string, SkinTheme>,
): SkinSummary => {
	const purchased = owned.filter(shopSkin);
	const guns = purchased.filter((skin) => !skin.melee);
	const knives = purchased.filter((skin) => skin.melee);
	const totalVp = purchased.reduce((sum, skin) => sum + skin.vp, 0);

	const rarityOrder: SkinTierName[] = ["Ultra", "Exclusive", "Premium", "Deluxe", "Select"];
	const rarityTotals = new Map<SkinTierName, RarityRow>();
	for (const skin of purchased) {
		if (!skin.tierName) continue;
		const row = rarityTotals.get(skin.tierName) ?? { tier: skin.tierName, count: 0, vp: 0 };
		row.count += 1;
		row.vp += skin.vp;
		rarityTotals.set(skin.tierName, row);
	}
	const rarities = rarityOrder.flatMap((tier) => {
		const row = rarityTotals.get(tier);
		return row && row.count > 0 ? [row] : [];
	});

	const ownedIds = new Set(purchased.map((skin) => skin.skinId));
	const completeSets: CompleteSet[] = [];
	for (const theme of themes.values()) {
		const required = theme.skinIds.filter((id) => {
			const sample = owned.find((skin) => skin.skinId === id);
			if (!sample) return true;
			return shopSkin(sample);
		});
		if (required.length < 2) continue;
		if (!required.every((id) => ownedIds.has(id))) continue;
		const skins = purchased.filter((skin) => skin.themeId === theme.id);
		completeSets.push({
			id: theme.id,
			name: theme.name,
			owned: skins.length,
			total: required.length,
			vp: skins.reduce((sum, skin) => sum + skin.vp, 0),
		});
	}
	completeSets.sort((a, b) => b.vp - a.vp || b.owned - a.owned);

	const groups = new Map<string, WeaponGroup>();
	for (const skin of purchased) {
		const group = groups.get(skin.weaponId) ?? {
			weaponId: skin.weaponId,
			weaponName: skin.weaponName,
			melee: skin.melee,
			skins: [],
			vp: 0,
		};
		group.skins.push(skin);
		group.vp += skin.vp;
		groups.set(skin.weaponId, group);
	}
	for (const group of groups.values()) {
		group.skins.sort((a, b) => b.vp - a.vp);
	}
	const weaponGroups = [...groups.values()].sort((a, b) => {
		if (a.melee !== b.melee) return a.melee ? -1 : 1;
		if (b.skins.length !== a.skins.length) return b.skins.length - a.skins.length;
		return b.vp - a.vp;
	});

	const passCount = items.filter((item) => passRewardIds.has(item.itemId.toLowerCase())).length;
	const { usd, twd } = estimateTopUp(totalVp);

	return {
		guns: guns.length,
		knives: knives.length,
		totalVp,
		inventoryCount: items.length,
		passCount,
		purchasedCount: items.length - passCount,
		excludedRarity: "Select",
		rarities,
		completeSets,
		completeSetsVp: completeSets.reduce((sum, set) => sum + set.vp, 0),
		weaponGroups,
		usd,
		twd,
	};
};
