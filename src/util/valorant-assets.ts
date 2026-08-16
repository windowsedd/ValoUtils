import i18n from "@/i18n/config";
import type { WeaponSkin } from "@/types/live-game";
import { formatSeasonActLabel } from "@/util/season-label";

// Cached lookups against the public valorant-api.com CDN. Used by the Live Game
// tab to turn raw Riot UUIDs (agents, weapon skins, competitive tiers/seasons)
// into localized display names + images. All assets are fetched with
// `?language=all` so a single cache serves every UI language, and memoised at
// module scope so the ~5s poll never refetches.

const API = "https://valorant-api.com/v1";

/** valorant-api.com returns `{ "en-US": "...", "ko-KR": "...", ... }` with language=all. */
export type Localized = Record<string, string> | string;

// App i18n code -> valorant-api.com locale code.
const LOCALE_MAP: Record<string, string> = {
	en: "en-US",
	ko: "ko-KR",
	"zh-TW": "zh-TW",
};

/** Resolve a `?language=all` name object to the current UI language. */
export const localize = (value: Localized | undefined | null): string => {
	if (!value) return "";
	if (typeof value === "string") return value;
	const lang = i18n.language || "en";
	const code = LOCALE_MAP[lang] ?? LOCALE_MAP[lang.split("-")[0]] ?? "en-US";
	return value[code] ?? value["en-US"] ?? Object.values(value)[0] ?? "";
};

export type AgentAsset = { name: Localized; icon: string };
export type SkinAsset = { name: Localized; icon: string };
export type TierAsset = { name: Localized; icon: string | null; largeIcon: string | null; color: string };
export type CardAsset = { name: Localized; icon: string };
export type MapAsset = { name: Localized; listViewIcon: string | null; splash: string | null };
export type SeasonAsset = { label: string; startMillis: number };
export type BundleAsset = { name: Localized; icon: string | null; verticalPromo: string | null };

let agentsPromise: Promise<Map<string, AgentAsset>> | null = null;
let tiersPromise: Promise<Map<number, TierAsset>> | null = null;
let mapsPromise: Promise<Map<string, MapAsset>> | null = null;
let seasonAssetsPromise: Promise<Map<string, SeasonAsset>> | null = null;
const skinDataCache = new Map<string, Promise<any | null>>();
const skinVariantCache = new Map<string, Promise<SkinAsset | null>>();
const cardCache = new Map<string, Promise<CardAsset | null>>();
const skinLevelCache = new Map<string, Promise<SkinAsset | null>>();
const bundleCache = new Map<string, Promise<BundleAsset | null>>();
const accessoryCache = new Map<string, Promise<SkinAsset | null>>();

// --- Agents ------------------------------------------------------------------
export const getAgents = (): Promise<Map<string, AgentAsset>> => {
	if (!agentsPromise) {
		agentsPromise = fetch(`${API}/agents?isPlayableCharacter=true&language=all`)
			.then((r) => r.json())
			.then((json) => {
				const map = new Map<string, AgentAsset>();
				for (const a of json?.data ?? []) {
					map.set((a.uuid as string).toLowerCase(), {
						name: a.displayName,
						icon: a.displayIconSmall ?? a.displayIcon,
					});
				}
				return map;
			})
			.catch(() => new Map<string, AgentAsset>());
	}
	return agentsPromise;
};

// --- Player cards ------------------------------------------------------------
export const getPlayerCard = (cardId?: string | null): Promise<CardAsset | null> => {
	if (!cardId) return Promise.resolve(null);
	const key = cardId.toLowerCase();
	if (!cardCache.has(key)) {
		cardCache.set(
			key,
			fetch(`${API}/playercards/${key}?language=all`)
				.then((r) => r.json())
				.then((json) => {
					const d = json?.data;
					if (!d) return null;
					return { name: d.displayName, icon: d.smallArt ?? d.displayIcon } as CardAsset;
				})
				.catch(() => null)
		);
	}
	return cardCache.get(key)!;
};

// --- Maps --------------------------------------------------------------------
/**
 * Map display names keyed by BOTH the full `mapUrl`
 * ("/Game/Maps/Bonsai/Bonsai") and its last path segment ("bonsai"), since
 * presence blobs and match metadata each use a different one. Keeping this on
 * the CDN means new maps and renames land without a code change — the old
 * hardcoded table had Drift and District swapped, and was missing Summit.
 */
export const getMaps = (): Promise<Map<string, MapAsset>> => {
	if (!mapsPromise) {
		mapsPromise = fetch(`${API}/maps?language=all`)
			.then((r) => r.json())
			.then((json) => {
				const map = new Map<string, MapAsset>();
				for (const m of json?.data ?? []) {
					const url: string = m.mapUrl ?? "";
					if (!url) continue;
					const asset: MapAsset = {
						name: m.displayName,
						// `listViewIcon` is the wide thumbnail the game uses in its own
						// match list; `splash` is the full-bleed art.
						listViewIcon: m.listViewIcon ?? m.splash ?? null,
						splash: m.splash ?? m.listViewIcon ?? null,
					};
					map.set(url.toLowerCase(), asset);
					const leaf = url.split("/").filter(Boolean).pop();
					if (leaf) map.set(leaf.toLowerCase(), asset);
				}
				return map;
			})
			.catch(() => new Map<string, MapAsset>());
	}
	return mapsPromise;
};

// --- Competitive tiers (rank icons, tracker.gg style) ------------------------
export const getTiers = (): Promise<Map<number, TierAsset>> => {
	if (!tiersPromise) {
		tiersPromise = fetch(`${API}/competitivetiers?language=all`)
			.then((r) => r.json())
			.then((json) => {
				const episodes: any[] = json?.data ?? [];
				// The last entry is the current ranked system.
				const latest = episodes[episodes.length - 1];
				const map = new Map<number, TierAsset>();
				for (const tier of latest?.tiers ?? []) {
					map.set(tier.tier, {
						name: tier.tierName,
						icon: tier.smallIcon ?? tier.largeIcon ?? null,
						largeIcon: tier.largeIcon ?? tier.smallIcon ?? null,
						color: tier.color ? `#${String(tier.color).slice(0, 6)}` : "#9ca3af",
					});
				}
				return map;
			})
			.catch(() => new Map<number, TierAsset>());
	}
	return tiersPromise;
};

// --- Weapon skins (with equipped chroma / level variant) ---------------------
const getSkinData = (skinId: string): Promise<any | null> => {
	const key = skinId.toLowerCase();
	if (!skinDataCache.has(key)) {
		skinDataCache.set(
			key,
			fetch(`${API}/weapons/skins/${key}?language=all`)
				.then((r) => r.json())
				.then((json) => json?.data ?? null)
				.catch(() => null)
		);
	}
	return skinDataCache.get(key)!;
};

const variantKey = (w: NonNullable<WeaponSkin>) =>
	[w.skinId ?? "", w.chromaId ?? "", w.levelId ?? ""].join("|").toLowerCase();

/**
 * Resolve the *equipped variant* of a weapon skin: prefer the selected chroma's
 * full render, then the upgrade level's icon, then the base skin icon.
 */
export const getWeaponSkin = (weapon: WeaponSkin): Promise<SkinAsset | null> => {
	if (!weapon?.skinId) return Promise.resolve(null);
	const key = variantKey(weapon);
	if (!skinVariantCache.has(key)) {
		skinVariantCache.set(
			key,
			getSkinData(weapon.skinId).then((skin) => {
				if (!skin) return null;
				const chroma = weapon.chromaId
					? (skin.chromas ?? []).find((c: any) => c.uuid?.toLowerCase() === weapon.chromaId!.toLowerCase())
					: null;
				const level = weapon.levelId
					? (skin.levels ?? []).find((l: any) => l.uuid?.toLowerCase() === weapon.levelId!.toLowerCase())
					: null;
				// Many melee/knife skins have a null `displayIcon` and only expose
				// art on their chromas/levels, so walk a wide fallback chain (`||`
				// also skips empty strings). Prefer the equipped variant's flat icon,
				// then its full render, then any art the skin exposes.
				const icon =
					chroma?.displayIcon || level?.displayIcon || skin.displayIcon ||
					chroma?.fullRender ||
					skin.chromas?.[0]?.displayIcon || skin.chromas?.[0]?.fullRender ||
					skin.levels?.[0]?.displayIcon || null;
				// Chroma display names are the most specific (e.g. "Champions Vandal (Variant 2)").
				const name = chroma?.displayName ?? skin.displayName;
				return { name, icon } as SkinAsset;
			})
		);
	}
	return skinVariantCache.get(key)!;
};

/** Stable key used by the renderer to map a weapon back to its resolved asset. */
export const weaponSkinKey = (weapon: WeaponSkin): string | null =>
	weapon?.skinId ? variantKey(weapon) : null;

// --- Store items -------------------------------------------------------------
/**
 * The storefront sells *skin levels*, not skins. A skin-level uuid is a
 * different id space from the skin uuid `getWeaponSkin` takes, so passing one
 * to `/weapons/skins/` returns nothing — hence the separate endpoint.
 *
 * The level's own `displayIcon` is often null (levels mostly differ by VFX,
 * not art), so fall back to the parent skin's art via `?/weapons/skinlevels`
 * embedded fields, then to the level name alone.
 */
export const getSkinLevel = (levelId: string): Promise<SkinAsset | null> => {
	const key = levelId.toLowerCase();
	if (!skinLevelCache.has(key)) {
		skinLevelCache.set(
			key,
			fetch(`${API}/weapons/skinlevels/${key}?language=all`)
				.then((r) => r.json())
				.then((json) => {
					const level = json?.data;
					if (!level) return null;
					return { name: level.displayName, icon: level.displayIcon ?? "" } as SkinAsset;
				})
				.catch(() => null)
		);
	}
	return skinLevelCache.get(key)!;
};

/** Bundle art, keyed by the storefront's `DataAssetID` (not the bundle id). */
export const getBundle = (dataAssetId: string): Promise<BundleAsset | null> => {
	const key = dataAssetId.toLowerCase();
	if (!bundleCache.has(key)) {
		bundleCache.set(
			key,
			fetch(`${API}/bundles/${key}?language=all`)
				.then((r) => r.json())
				.then((json) => {
					const bundle = json?.data;
					if (!bundle) return null;
					return {
						name: bundle.displayName,
						icon: bundle.displayIcon ?? null,
						// The wide art is what the in-game shop banner uses.
						verticalPromo: bundle.verticalPromoImage ?? null,
					} as BundleAsset;
				})
				.catch(() => null)
		);
	}
	return bundleCache.get(key)!;
};

/**
 * The accessory store mixes sprays, cards, buddies and titles in one shelf,
 * each served by its own endpoint. The item type uuid picks the endpoint;
 * an unrecognised type resolves to null rather than guessing.
 */
const ACCESSORY_ENDPOINTS: Record<string, string> = {
	"d5f120f8-ff8c-4aac-92ea-f2b5acbe9475": "sprays",
	"3f296c07-64c3-494c-923b-fe692a4fa1bd": "playercards",
	"dd3bf334-87f3-40bd-b043-682a57a8dc3a": "buddies",
	"de7caa6b-adf7-4588-bbd1-143831e786c6": "playertitles",
};

export const getAccessoryItem = (itemTypeId: string, itemId: string): Promise<SkinAsset | null> => {
	const endpoint = ACCESSORY_ENDPOINTS[itemTypeId.toLowerCase()];
	if (!endpoint || !itemId) return Promise.resolve(null);
	const key = `${endpoint}:${itemId.toLowerCase()}`;
	if (!accessoryCache.has(key)) {
		accessoryCache.set(
			key,
			fetch(`${API}/${endpoint}/${itemId.toLowerCase()}?language=all`)
				.then((r) => r.json())
				.then((json) => {
					const item = json?.data;
					if (!item) return null;
					// Titles have no art at all — the name is the whole item.
					const icon = item.fullTransparentIcon ?? item.displayIcon ?? item.largeArt ?? "";
					return { name: item.displayName ?? item.titleText, icon } as SkinAsset;
				})
				.catch(() => null)
		);
	}
	return accessoryCache.get(key)!;
};

// --- Competitive seasons -> "E5A3" / "V26A3" ------------------------------
const romanToNum = (s: string): number => {
	const map: Record<string, number> = { I: 1, V: 5, X: 10 };
	let total = 0;
	for (let i = 0; i < s.length; i++) {
		const cur = map[s[i]] ?? 0;
		const next = map[s[i + 1]] ?? 0;
		total += cur < next ? -cur : cur;
	}
	return total;
};

const actNumber = (displayName: string): number => {
	const arabic = displayName.match(/\d+/);
	if (arabic) return parseInt(arabic[0], 10);
	const roman = displayName.replace(/ACT/i, "").trim().toUpperCase();
	return romanToNum(roman) || 0;
};

const episodeLabel = (displayName: string): string => {
	const m = displayName.match(/EPISODE\s*(\d+)/i);
	if (m) return `E${m[1]}`;
	// 2025+ format is already short, e.g. "V26".
	return displayName.replace(/\s+/g, "");
};

// Seasons are parsed in English regardless of UI language (we only need numbers).
const enName = (v: any): string => (typeof v === "string" ? v : v?.["en-US"] ?? Object.values(v ?? {})[0] ?? "");

export const getSeasonAssets = (): Promise<Map<string, SeasonAsset>> => {
	if (!seasonAssetsPromise) {
		seasonAssetsPromise = fetch(`${API}/seasons?language=all`)
			.then((r) => r.json())
			.then((json) => {
				const seasons: any[] = json?.data ?? [];
				// Parent "episodes"/years are NOT typed Episode — they have
				// `type: null` and `parentUuid: null` (e.g. "EPISODE 5", "V26").
				// Acts are the only typed entries and carry the parent link.
				type Ep = { uuid: string; label: string; start: number; end: number };
				const episodes: Ep[] = [];
				for (const s of seasons) {
					if (s.type !== "EAresSeasonType::Act") {
						episodes.push({
							uuid: s.uuid,
							label: episodeLabel(enName(s.displayName)),
							start: Date.parse(s.startTime) || 0,
							end: Date.parse(s.endTime) || Number.MAX_SAFE_INTEGER,
						});
					}
				}
				const byUuid = new Map(episodes.map((e) => [e.uuid, e.label]));
				// `parentUuid` is occasionally absent on newer acts, so fall back to
				// the episode whose date range contains the act's start time.
				const byTime = (t: number) => episodes.find((e) => t >= e.start && t < e.end)?.label ?? "";

				const assets = new Map<string, SeasonAsset>();
				for (const s of seasons) {
					if (s.type === "EAresSeasonType::Act") {
						const startMillis = Date.parse(s.startTime) || 0;
						const ep = byUuid.get(s.parentUuid) || byTime(startMillis);
						const label = formatSeasonActLabel(ep, actNumber(enName(s.displayName)));
						if (label) assets.set((s.uuid as string).toLowerCase(), { label, startMillis });
					}
				}
				return assets;
			})
			.catch(() => new Map<string, SeasonAsset>());
	}
	return seasonAssetsPromise;
};

export const getSeasonLabels = (): Promise<Map<string, string>> =>
	getSeasonAssets().then((assets) => new Map([...assets].map(([id, asset]) => [id, asset.label])));
