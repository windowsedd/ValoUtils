import { localize, type MapAsset } from "@/util/valorant-assets";

/**
 * Offline fallback only — the live names come from valorant-api.com via
 * `getMaps()`. Riot ships maps under internal code names ("Bonsai" is Split),
 * and these values are checked against the CDN, so don't hand-edit them: add
 * new maps by letting `getMaps()` pick them up instead.
 */
const FALLBACK_MAP_NAMES: Record<string, string> = {
  ascent: "Ascent",
  bonsai: "Split",
  canyon: "Fracture",
  duality: "Bind",
  foxtrot: "Breeze",
  jam: "Lotus",
  juliett: "Sunset",
  pitt: "Pearl",
  port: "Icebox",
  range: "The Range",
  triad: "Haven",
  infinity: "Abyss",
  plummet: "Summit",
  hurm_bowl: "Kasbah",
  hurm_alley: "District",
  hurm_helix: "Drift",
  hurm_yard: "Piazza",
  hurm_hightide: "Glitch",
};

/** Last path segment of a map url, lowercased: "/Game/Maps/Jam/Jam" -> "jam". */
const leafOf = (mapId: string) => mapId.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";

/**
 * "/Game/Maps/Bonsai/Bonsai" -> "Split", localized to the UI language when the
 * CDN map list is supplied. Falls back to the static table, then to the raw
 * segment, so an unknown or newly released map still renders something.
 */
export const mapName = (mapId: string | null | undefined, maps?: Map<string, MapAsset>): string => {
  if (!mapId) return "";
  const key = mapId.toLowerCase();
  const leaf = leafOf(mapId);
  const fromApi = maps?.get(key) ?? maps?.get(leaf);
  if (fromApi) return localize(fromApi.name);
  return FALLBACK_MAP_NAMES[leaf] ?? mapId.split("/").filter(Boolean).pop() ?? "";
};

/** Wide thumbnail for a map, or null when the CDN list hasn't loaded yet. */
export const mapIcon = (
  mapId: string | null | undefined,
  maps?: Map<string, MapAsset>,
): string | null => {
  if (!mapId) return null;
  const asset = maps?.get(mapId.toLowerCase()) ?? maps?.get(leafOf(mapId));
  return asset?.listViewIcon ?? null;
};
