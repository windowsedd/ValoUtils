import i18n from "@/i18n/config";
import type { AccessoryKind, AccessoryRecord } from "@/pages/inventory/inventory-accessories";
import type { SkinRecord, SkinTheme, SkinTierName } from "@/pages/inventory/inventory-skins";
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
export type TierAsset = {
  name: Localized;
  icon: string | null;
  largeIcon: string | null;
  color: string;
};
export type CardAsset = { name: Localized; icon: string };
export type MapAsset = { name: Localized; listViewIcon: string | null; splash: string | null };
export type SeasonAsset = { label: string; startMillis: number; endMillis: number };
export type EventAsset = { startMillis: number; endMillis: number };
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
let battlepassContractsPromise: Promise<unknown[]> | null = null;
let eventAssetsPromise: Promise<Map<string, EventAsset>> | null = null;
const battlepassRewardCache = new Map<string, Promise<SkinAsset | null>>();

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
        .catch(() => null),
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
        .catch(() => null),
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
          ? (skin.chromas ?? []).find(
              (c: any) => c.uuid?.toLowerCase() === weapon.chromaId!.toLowerCase(),
            )
          : null;
        const level = weapon.levelId
          ? (skin.levels ?? []).find(
              (l: any) => l.uuid?.toLowerCase() === weapon.levelId!.toLowerCase(),
            )
          : null;
        // Many melee/knife skins have a null `displayIcon` and only expose
        // art on their chromas/levels, so walk a wide fallback chain (`||`
        // also skips empty strings). Prefer the equipped variant's flat icon,
        // then its full render, then any art the skin exposes.
        const icon =
          chroma?.displayIcon ||
          level?.displayIcon ||
          skin.displayIcon ||
          chroma?.fullRender ||
          skin.chromas?.[0]?.displayIcon ||
          skin.chromas?.[0]?.fullRender ||
          skin.levels?.[0]?.displayIcon ||
          null;
        // Chroma display names are the most specific (e.g. "Champions Vandal (Variant 2)").
        const name = chroma?.displayName ?? skin.displayName;
        return { name, icon } as SkinAsset;
      }),
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
        .catch(() => null),
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
        .catch(() => null),
    );
  }
  return bundleCache.get(key)!;
};

/** Skin *level* uuid the daily shop and featured bundles use for weapons. */
const SKIN_ITEM_TYPE = "e7c63390-eda7-46e0-bb7a-a6abdacd2433";

/**
 * The kingdom / accessory store mixes sprays, cards, buddies, titles and flex
 * in one shelf. Featured bundles reuse the same type ids. The item type uuid
 * picks the valorant-api.com path; an unrecognised type resolves to null
 * rather than guessing.
 *
 * Buddies are sold as charm *levels* — the same id space battle pass uses for
 * `EquippableCharmLevel` — so the lookup is `/buddies/levels/{id}`, not
 * `/buddies/{id}`. A parent-buddy uuid still works via the fallback below.
 */
const ACCESSORY_ENDPOINTS: Record<string, string> = {
  "d5f120f8-ff8c-4aac-92ea-f2b5acbe9475": "sprays",
  "290f8769-97c6-492a-a1a8-caacf3d5b325": "sprays/levels",
  "3f296c07-64c3-494c-923b-fe692a4fa1bd": "playercards",
  "dd3bf334-87f3-40bd-b043-682a57a8dc3a": "buddies/levels",
  "de7caa6b-adf7-4588-bbd1-143831e786c6": "playertitles",
  "03a572de-4234-31ed-d344-ababa488f981": "flex",
};

const ACCESSORY_FALLBACK: Record<string, string> = {
  "buddies/levels": "buddies",
  "sprays/levels": "sprays",
};

const accessoryFromJson = (
  item: {
    displayName?: Localized;
    titleText?: Localized;
    fullTransparentIcon?: string;
    displayIcon?: string;
    largeArt?: string;
  } | null,
): SkinAsset | null => {
  if (!item) return null;
  // Titles have no art at all — the name is the whole item.
  const icon = item.fullTransparentIcon ?? item.displayIcon ?? item.largeArt ?? "";
  return { name: item.displayName ?? item.titleText ?? "", icon };
};

const fetchAccessoryEndpoint = (endpoint: string, itemId: string): Promise<SkinAsset | null> =>
  fetch(`${API}/${endpoint}/${itemId}?language=all`)
    .then((r) => r.json())
    .then((json) => accessoryFromJson(json?.data ?? null))
    .catch(() => null);

export const getAccessoryItem = (itemTypeId: string, itemId: string): Promise<SkinAsset | null> => {
  const endpoint = ACCESSORY_ENDPOINTS[itemTypeId.toLowerCase()];
  if (!endpoint || !itemId) return Promise.resolve(null);
  const id = itemId.toLowerCase();
  const key = `${endpoint}:${id}`;
  if (!accessoryCache.has(key)) {
    accessoryCache.set(
      key,
      fetchAccessoryEndpoint(endpoint, id).then((asset) => {
        if (asset) return asset;
        const fallback = ACCESSORY_FALLBACK[endpoint];
        return fallback ? fetchAccessoryEndpoint(fallback, id) : null;
      }),
    );
  }
  return accessoryCache.get(key)!;
};

// --- Inventory catalog -------------------------------------------------------
// One bulk fetch per type. Inventory can be hundreds of rows; the per-id
// helpers above would hammer valorant-api.com.
const TIER_NAME_BY_ID: Record<string, SkinTierName> = {
  "12683d76-48d7-84a3-4e09-6985794f0445": "Select",
  "0cebb8be-46d7-c12a-d306-e9907bfc5a25": "Deluxe",
  "60bca009-4182-7998-dee7-b8a2558dc369": "Premium",
  "e046854e-406c-37f4-6607-19a9ba8426fc": "Exclusive",
  "411e4a55-4e59-7757-41f0-86a53f101bb5": "Ultra",
};

export type InventoryIndex = {
  assets: Map<string, SkinAsset>;
  skinsByItemId: Map<string, SkinRecord>;
  accessoriesByItemId: Map<string, AccessoryRecord>;
  themes: Map<string, SkinTheme>;
  passRewardIds: Set<string>;
};

let inventoryIndexPromise: Promise<InventoryIndex> | null = null;

const putAsset = (
  map: Map<string, SkinAsset>,
  id: unknown,
  name: Localized | undefined,
  icon: string,
) => {
  if (typeof id !== "string" || !id) return;
  map.set(id.toLowerCase(), { name: name ?? "", icon });
};

const collectPassRewardIds = (contracts: readonly unknown[]): Set<string> => {
  const ids = new Set<string>();
  for (const contract of contracts) {
    if (!contract || typeof contract !== "object") continue;
    const content = (contract as { content?: { relationType?: unknown; chapters?: unknown } })
      .content;
    const relation = content?.relationType;
    if (relation !== "Season" && relation !== "Event") continue;
    const chapters = Array.isArray(content?.chapters) ? content.chapters : [];
    for (const chapter of chapters) {
      if (!chapter || typeof chapter !== "object") continue;
      const row = chapter as { levels?: unknown; freeRewards?: unknown };
      const rewards = [
        ...(Array.isArray(row.levels) ? row.levels : []).flatMap((level) => {
          if (!level || typeof level !== "object") return [];
          const reward = (level as { reward?: unknown }).reward;
          return reward ? [reward] : [];
        }),
        ...(Array.isArray(row.freeRewards) ? row.freeRewards : []),
      ];
      for (const reward of rewards) {
        if (!reward || typeof reward !== "object") continue;
        const uuid = (reward as { uuid?: unknown }).uuid;
        if (typeof uuid === "string" && uuid) ids.add(uuid.toLowerCase());
      }
    }
  }
  return ids;
};

export const getInventoryIndex = (): Promise<InventoryIndex> => {
  if (!inventoryIndexPromise) {
    inventoryIndexPromise = Promise.all([
      fetch(`${API}/weapons?language=all`).then((r) => r.json()),
      fetch(`${API}/sprays?language=all`).then((r) => r.json()),
      fetch(`${API}/buddies?language=all`).then((r) => r.json()),
      fetch(`${API}/playercards?language=all`).then((r) => r.json()),
      fetch(`${API}/playertitles?language=all`).then((r) => r.json()),
      fetch(`${API}/flex?language=all`).then((r) => r.json()),
      fetch(`${API}/themes?language=all`).then((r) => r.json()),
      getBattlepassContracts(),
    ])
      .then(([weapons, sprays, buddies, cards, titles, flexes, themesJson, contracts]) => {
        const assets = new Map<string, SkinAsset>();
        const skinsByItemId = new Map<string, SkinRecord>();
        const accessoriesByItemId = new Map<string, AccessoryRecord>();
        const putAccessory = (
          kind: AccessoryKind,
          id: unknown,
          parentId: string,
          name: Localized | undefined,
          icon: string,
        ) => {
          if (typeof id !== "string" || !id) return;
          const record: AccessoryRecord = {
            id: id.toLowerCase(),
            parentId,
            kind,
            name: name ?? "",
            icon,
          };
          accessoriesByItemId.set(record.id, record);
          accessoriesByItemId.set(parentId, record);
        };
        const themeNames = new Map<string, Localized>();
        for (const theme of themesJson?.data ?? []) {
          if (typeof theme?.uuid === "string")
            themeNames.set(theme.uuid.toLowerCase(), theme.displayName);
        }
        const themeSkinIds = new Map<string, string[]>();

        for (const weapon of weapons?.data ?? []) {
          const melee = String(weapon?.category ?? "").includes("Melee");
          const weaponName = weapon?.displayName ?? "";
          const weaponId = typeof weapon?.uuid === "string" ? weapon.uuid.toLowerCase() : "";
          for (const skin of weapon?.skins ?? []) {
            const skinId = typeof skin?.uuid === "string" ? skin.uuid.toLowerCase() : "";
            if (!skinId) continue;
            const icon =
              skin.displayIcon ||
              skin.chromas?.[0]?.fullRender ||
              skin.chromas?.[0]?.displayIcon ||
              skin.levels?.[0]?.displayIcon ||
              "";
            const name = skin.displayName;
            const tierId =
              typeof skin.contentTierUuid === "string" ? skin.contentTierUuid.toLowerCase() : "";
            const tierName = TIER_NAME_BY_ID[tierId] ?? null;
            const themeId =
              typeof skin.themeUuid === "string" ? skin.themeUuid.toLowerCase() : null;
            const levelIds = (skin.levels ?? [])
              .map((level: { uuid?: string }) =>
                typeof level?.uuid === "string" ? level.uuid.toLowerCase() : "",
              )
              .filter(Boolean);
            const record: SkinRecord = {
              skinId,
              levelIds,
              name,
              icon,
              weaponId,
              weaponName,
              melee,
              themeId,
              themeName: themeId ? (themeNames.get(themeId) ?? null) : null,
              tierName,
              standard: !tierName,
            };
            skinsByItemId.set(skinId, record);
            for (const levelId of levelIds) skinsByItemId.set(levelId, record);
            putAsset(assets, skin.uuid, name, icon);
            for (const level of skin.levels ?? []) {
              putAsset(assets, level.uuid, level.displayName ?? name, level.displayIcon || icon);
            }
            if (themeId && tierName && tierName !== "Select") {
              const list = themeSkinIds.get(themeId) ?? [];
              list.push(skinId);
              themeSkinIds.set(themeId, list);
            }
          }
        }

        const themes = new Map<string, SkinTheme>();
        for (const [id, skinIds] of themeSkinIds) {
          themes.set(id, { id, name: themeNames.get(id) ?? id, skinIds });
        }

        for (const spray of sprays?.data ?? []) {
          const parent = typeof spray?.uuid === "string" ? spray.uuid.toLowerCase() : "";
          const icon = spray.fullTransparentIcon || spray.displayIcon || "";
          putAsset(assets, spray.uuid, spray.displayName, icon);
          putAccessory("sprays", spray.uuid, parent, spray.displayName, icon);
          for (const level of spray.levels ?? []) {
            putAsset(assets, level.uuid, spray.displayName, level.displayIcon || icon);
            putAccessory(
              "sprays",
              level.uuid,
              parent,
              spray.displayName,
              level.displayIcon || icon,
            );
          }
        }
        for (const buddy of buddies?.data ?? []) {
          const parent = typeof buddy?.uuid === "string" ? buddy.uuid.toLowerCase() : "";
          const icon = buddy.displayIcon || "";
          putAsset(assets, buddy.uuid, buddy.displayName, icon);
          putAccessory("buddies", buddy.uuid, parent, buddy.displayName, icon);
          for (const level of buddy.levels ?? []) {
            putAsset(assets, level.uuid, buddy.displayName, level.displayIcon || icon);
            putAccessory(
              "buddies",
              level.uuid,
              parent,
              buddy.displayName,
              level.displayIcon || icon,
            );
          }
        }
        for (const card of cards?.data ?? []) {
          const icon = card.smallArt || card.displayIcon || "";
          putAsset(assets, card.uuid, card.displayName, icon);
          putAccessory(
            "cards",
            card.uuid,
            typeof card.uuid === "string" ? card.uuid.toLowerCase() : "",
            card.displayName,
            icon,
          );
        }
        for (const title of titles?.data ?? []) {
          putAsset(assets, title.uuid, title.displayName ?? title.titleText, "");
          putAccessory(
            "titles",
            title.uuid,
            typeof title.uuid === "string" ? title.uuid.toLowerCase() : "",
            title.displayName ?? title.titleText,
            "",
          );
        }
        for (const flex of flexes?.data ?? []) {
          const icon = flex.displayIcon || "";
          putAsset(assets, flex.uuid, flex.displayName, icon);
          putAccessory(
            "flex",
            flex.uuid,
            typeof flex.uuid === "string" ? flex.uuid.toLowerCase() : "",
            flex.displayName,
            icon,
          );
        }

        return {
          assets,
          skinsByItemId,
          accessoriesByItemId,
          themes,
          passRewardIds: collectPassRewardIds(Array.isArray(contracts) ? contracts : []),
        };
      })
      .catch(() => ({
        assets: new Map<string, SkinAsset>(),
        skinsByItemId: new Map<string, SkinRecord>(),
        accessoriesByItemId: new Map<string, AccessoryRecord>(),
        themes: new Map<string, SkinTheme>(),
        passRewardIds: new Set<string>(),
      }));
  }
  return inventoryIndexPromise;
};

export const getInventoryCatalog = (): Promise<Map<string, SkinAsset>> =>
  getInventoryIndex().then((index) => index.assets);

const assetFromInventoryIndex = async (itemId: string): Promise<SkinAsset | null> => {
  const index = await getInventoryIndex();
  return index.assets.get(itemId.toLowerCase()) ?? null;
};

/**
 * Resolve any storefront row (daily skin, featured-bundle accessory, kingdom
 * shelf) by Riot item type. Featured bundles mix skins with buddies, cards
 * and flex — those ids 404 on `/weapons/skinlevels` and must not be treated
 * as gun skins. Unknown types fall through the bulk catalog so a new type
 * still gets a name instead of a raw uuid.
 */
export const getStoreItem = async (
  itemTypeId: string | undefined,
  itemId: string,
): Promise<SkinAsset | null> => {
  if (!itemId) return null;
  const type = (itemTypeId ?? "").toLowerCase();
  const id = itemId.toLowerCase();
  if (type === SKIN_ITEM_TYPE) {
    return (await getSkinLevel(id)) ?? assetFromInventoryIndex(id);
  }
  if (type && ACCESSORY_ENDPOINTS[type]) {
    return (await getAccessoryItem(type, id)) ?? assetFromInventoryIndex(id);
  }
  return (await assetFromInventoryIndex(id)) ?? getSkinLevel(id);
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
const enName = (v: any): string =>
  typeof v === "string" ? v : (v?.["en-US"] ?? Object.values(v ?? {})[0] ?? "");

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
            if (label) {
              assets.set((s.uuid as string).toLowerCase(), {
                label,
                startMillis,
                endMillis: Date.parse(s.endTime) || Number.MAX_SAFE_INTEGER,
              });
            }
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

const REWARD_ENDPOINTS: Record<string, string> = {
  equippableskinlevel: "weapons/skinlevels",
  equippablecharmlevel: "buddies/levels",
  playercard: "playercards",
  spray: "sprays",
  title: "playertitles",
  currency: "currencies",
};

export const getEventAssets = (): Promise<Map<string, EventAsset>> => {
  if (!eventAssetsPromise) {
    eventAssetsPromise = fetch(`${API}/events?language=all`)
      .then((r) => r.json())
      .then((json) => {
        const assets = new Map<string, EventAsset>();
        for (const event of json?.data ?? []) {
          const id = typeof event?.uuid === "string" ? event.uuid.toLowerCase() : "";
          if (!id) continue;
          assets.set(id, {
            startMillis: Date.parse(event.startTime) || 0,
            endMillis: Date.parse(event.endTime) || Number.MAX_SAFE_INTEGER,
          });
        }
        return assets;
      })
      .catch(() => new Map<string, EventAsset>());
  }
  return eventAssetsPromise;
};

export const getBattlepassContracts = (): Promise<unknown[]> => {
  if (!battlepassContractsPromise) {
    battlepassContractsPromise = fetch(`${API}/contracts?language=all`)
      .then((r) => r.json())
      .then((json) => (Array.isArray(json?.data) ? json.data : []))
      .catch(() => [] as unknown[]);
  }
  return battlepassContractsPromise;
};

export const getBattlepassReward = (type: string, uuid: string): Promise<SkinAsset | null> => {
  const endpoint = REWARD_ENDPOINTS[type.toLowerCase()];
  if (!endpoint || !uuid) return Promise.resolve(null);
  const key = `${endpoint}:${uuid.toLowerCase()}`;
  if (!battlepassRewardCache.has(key)) {
    battlepassRewardCache.set(
      key,
      fetch(`${API}/${endpoint}/${uuid.toLowerCase()}?language=all`)
        .then((r) => r.json())
        .then((json) => {
          const item = json?.data;
          if (!item) return null;
          const icon =
            item.wideArt ||
            item.largeArt ||
            item.fullTransparentIcon ||
            item.displayIcon ||
            item.largeIcon ||
            item.rewardPreviewIcon ||
            "";
          return { name: item.displayName ?? item.titleText, icon } as SkinAsset;
        })
        .catch(() => null),
    );
  }
  return battlepassRewardCache.get(key)!;
};
