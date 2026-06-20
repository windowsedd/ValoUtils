/**
 * NetGuidCache — tracks all NetGuids during a replay.
 * Ported from Unreal.Core/Models/NetGuidCache.cs.
 */
import { NetFieldExportGroup, type IExternalData } from "./models.js";
import { removeAllPathPrefixes, cleanPathSuffix } from "./string-utils.js";

export class NetGuidCache {
  NetFieldExportGroupMap = new Map<string, NetFieldExportGroup>();
  NetFieldExportGroupIndexToGroup = new Map<number, string>();
  NetGuidToPathName = new Map<number, string>();
  NetFieldExportGroupMapPathFixed = new Map<number, NetFieldExportGroup>();
  ExternalData = new Map<number, IExternalData>();

  private archTypeToExportGroup = new Map<number, NetFieldExportGroup>();
  private cleanedPaths = new Map<number, string>();
  private cleanedClassNetCache = new Map<string, string>();
  private failedPaths = new Set<string>();
  private _networkGameplayTagNodeIndex: NetFieldExportGroup | null = null;

  get NetworkGameplayTagNodeIndex(): NetFieldExportGroup | null {
    if (this._networkGameplayTagNodeIndex == null) {
      const a = this.NetFieldExportGroupMap.get("NetworkGameplayTagNodeIndex");
      if (a) this._networkGameplayTagNodeIndex = a;
      else {
        const b = this.NetFieldExportGroupMap.get(
          "NetworkGameplayTagDynamicIndex",
        );
        if (b) this._networkGameplayTagNodeIndex = b;
      }
    }
    return this._networkGameplayTagNodeIndex;
  }

  addToExportGroupMap(group: string, exportGroup: NetFieldExportGroup): void {
    if (group.endsWith("ClassNetCache")) {
      exportGroup.PathName = removeAllPathPrefixes(exportGroup.PathName);
    }
    this.NetFieldExportGroupMap.set(group, exportGroup);
    this.NetFieldExportGroupIndexToGroup.set(exportGroup.PathNameIndex, group);
  }

  getNetFieldExportGroupFromIndex(
    index: number | undefined,
  ): NetFieldExportGroup | null {
    if (index === undefined) return null;
    const group = this.NetFieldExportGroupIndexToGroup.get(index);
    if (group === undefined) return null;
    return this.NetFieldExportGroupMap.get(group) ?? null;
  }

  getNetFieldExportGroupByPath(path: string): NetFieldExportGroup | null {
    if (!path) return null;
    return this.NetFieldExportGroupMap.get(path) ?? null;
  }

  /** Resolve an actor/archetype netguid to its export group (with fuzzy path matching). */
  getNetFieldExportGroupByGuid(
    netguid: number | undefined,
  ): NetFieldExportGroup | null {
    if (netguid === undefined) return null;

    const existing = this.archTypeToExportGroup.get(netguid);
    if (existing) return existing;

    const path = this.NetGuidToPathName.get(netguid);
    if (path === undefined) return null;
    if (this.failedPaths.has(path)) return null;

    const fixed = this.NetFieldExportGroupMapPathFixed.get(netguid);
    if (fixed) {
      this.archTypeToExportGroup.set(netguid, fixed);
      return fixed;
    }

    for (const [groupPath, group] of this.NetFieldExportGroupMap) {
      let groupPathFixed = this.cleanedPaths.get(group.PathNameIndex);
      if (groupPathFixed === undefined) {
        groupPathFixed = removeAllPathPrefixes(groupPath);
        this.cleanedPaths.set(group.PathNameIndex, groupPathFixed);
      }
      if (path.includes(groupPathFixed)) {
        const found = this.NetFieldExportGroupMap.get(groupPath)!;
        this.NetFieldExportGroupMapPathFixed.set(netguid, found);
        this.archTypeToExportGroup.set(netguid, found);
        return found;
      }
    }

    const cleanedPath = cleanPathSuffix(path);
    for (const [groupPath, group] of this.NetFieldExportGroupMap) {
      const groupPathFixed = this.cleanedPaths.get(group.PathNameIndex);
      if (groupPathFixed !== undefined && groupPathFixed.includes(cleanedPath)) {
        const found = this.NetFieldExportGroupMap.get(groupPath)!;
        this.NetFieldExportGroupMapPathFixed.set(netguid, found);
        this.archTypeToExportGroup.set(netguid, found);
        return found;
      }
    }

    this.failedPaths.add(path);
    return null;
  }

  tryGetClassNetCache(
    group: string | undefined,
    useFullName: boolean,
  ): NetFieldExportGroup | null {
    if (!group) return null;
    let classNetCachePath = this.cleanedClassNetCache.get(group);
    if (classNetCachePath === undefined) {
      classNetCachePath = useFullName
        ? `${group}_ClassNetCache`
        : `${removeAllPathPrefixes(group)}_ClassNetCache`;
      this.cleanedClassNetCache.set(group, classNetCachePath);
    }
    return this.NetFieldExportGroupMap.get(classNetCachePath) ?? null;
  }

  tryGetPathName(netguid: number): string | undefined {
    return this.NetGuidToPathName.get(netguid);
  }

  tryGetExternalData(netguid: number | undefined): IExternalData | undefined {
    if (netguid === undefined) return undefined;
    const data = this.ExternalData.get(netguid);
    if (data !== undefined) this.ExternalData.delete(netguid);
    return data;
  }

  cleanup(): void {
    this.NetFieldExportGroupIndexToGroup.clear();
    this.NetFieldExportGroupMap.clear();
    this.NetGuidToPathName.clear();
    this.NetFieldExportGroupMapPathFixed.clear();
    this.ExternalData.clear();
    this._networkGameplayTagNodeIndex = null;
    this.archTypeToExportGroup.clear();
    this.cleanedPaths.clear();
    this.cleanedClassNetCache.clear();
    this.failedPaths.clear();
  }
}
