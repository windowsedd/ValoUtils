/**
 * Net field registry — the TypeScript replacement for C#'s reflection-based
 * NetFieldParser discovery. C# scanned assemblies for `[NetFieldExportGroup]`
 * etc. attributes; here, model modules register descriptors explicitly.
 */
import type { RepLayoutCmdType, ParseMode } from "./enums.js";
import type { VectorQuantization, RotatorQuantization } from "../io/enums.js";
import type { IProperty } from "./models.js";

export interface RepMovementSpec {
  location: VectorQuantization;
  rotation: RotatorQuantization;
  velocity: VectorQuantization;
}

/** One replicated property of a net field export group. */
export interface NetFieldDescriptor {
  /** Property name (export-name mode) — matches the replicated FName. */
  name?: string;
  /** Handle number (handle mode) — matches the replicated handle. */
  handle?: number;
  /** Key on the target object to assign the parsed value to. */
  key: string;
  type: RepLayoutCmdType;
  minimalParseMode?: ParseMode;
  movement?: RepMovementSpec;
  /** For DynamicArray: builds an element export-group instance, or null for primitive. */
  elementFactory?: (() => object) | null;
  /** For DynamicArray of primitives: the element's RepLayoutCmdType. */
  elementType?: RepLayoutCmdType;
}

export interface NetFieldExportGroupDescriptor {
  path: string;
  minimalParseMode: ParseMode;
  /** Construct a fresh instance of the group's backing object. */
  factory: () => object;
  /** Export-name-keyed properties. */
  properties: NetFieldDescriptor[];
  /** Whether this group uses handle-based field lookup. */
  usesHandles: boolean;
  /** If set, registers this path as a sub-group of the named parent path. */
  subGroupOf?: string;
}

export interface ClassNetCacheProperty {
  name: string;
  pathName: string;
  isFunction: boolean;
  enablePropertyChecksum: boolean;
  isCustomStruct: boolean;
  /** For custom structs: build the IProperty to deserialize directly. */
  propertyFactory?: () => IProperty;
}

export interface ClassNetCacheDescriptor {
  path: string;
  minimalParseMode: ParseMode;
  properties: ClassNetCacheProperty[];
}

/** Global registry of all model descriptors. Populated at module load. */
export class NetFieldRegistry {
  readonly groups = new Map<string, NetFieldExportGroupDescriptor>();
  readonly classNetCaches = new Map<string, ClassNetCacheDescriptor>();
  readonly playerControllerPaths = new Set<string>();

  registerGroup(desc: NetFieldExportGroupDescriptor): void {
    this.groups.set(desc.path, desc);
  }

  registerSubGroup(parentPath: string, properties: NetFieldDescriptor[]): void {
    const parent = this.groups.get(parentPath);
    if (parent) parent.properties.push(...properties);
  }

  registerClassNetCache(desc: ClassNetCacheDescriptor): void {
    this.classNetCaches.set(desc.path, desc);
  }

  registerPlayerController(path: string): void {
    this.playerControllerPaths.add(path);
  }
}

/** The single shared registry instance. */
export const registry = new NetFieldRegistry();
