/**
 * NetFieldParser — reads replicated properties into registered model objects.
 * Ported from Unreal.Core/NetFieldParser.cs, but registry-driven instead of
 * reflection-driven. Models register descriptors (see registry.ts); here we
 * consume them to parse fields and assign values by key.
 */
import type { NetBitReader } from "../io/net-bit-reader.js";
import { SeekOrigin } from "../io/farchive.js";
import { VectorQuantization } from "../io/enums.js";
import { RepLayoutCmdType, ParseMode } from "./enums.js";
import { FBitArchiveEndIndex } from "./enums.js";
import {
  type NetFieldExportGroup,
  type NetFieldExport,
  type IProperty,
  type IResolvable,
  type IHandleNetFieldExportGroup,
} from "./models.js";
import type { NetGuidCache } from "./net-guid-cache.js";
import {
  type NetFieldRegistry,
  type NetFieldDescriptor,
  type NetFieldExportGroupDescriptor,
  type ClassNetCacheProperty,
} from "./registry.js";

function hasResolve(o: unknown): o is IResolvable {
  return typeof (o as IResolvable)?.resolve === "function";
}
function hasSerialize(o: unknown): o is IProperty {
  return typeof (o as IProperty)?.serialize === "function";
}

export class NetFieldParser {
  private guidCache: NetGuidCache;
  private registry: NetFieldRegistry;
  private mode: ParseMode;

  /** Resolved name->descriptor and handle->descriptor maps, per group path. */
  private nameLookup = new Map<string, Map<string, NetFieldDescriptor>>();
  private handleLookup = new Map<string, Map<number, NetFieldDescriptor>>();

  get PlayerControllerGroups(): Set<string> {
    return this.registry.playerControllerPaths;
  }

  constructor(cache: NetGuidCache, registry: NetFieldRegistry, mode: ParseMode) {
    this.guidCache = cache;
    this.registry = registry;
    this.mode = mode;
    for (const [path, group] of registry.groups) {
      const names = new Map<string, NetFieldDescriptor>();
      const handles = new Map<number, NetFieldDescriptor>();
      for (const p of group.properties) {
        if (p.minimalParseMode !== undefined && p.minimalParseMode > mode) {
          continue;
        }
        if (p.handle !== undefined) handles.set(p.handle, p);
        if (p.name !== undefined) names.set(p.name, p);
      }
      this.nameLookup.set(path, names);
      this.handleLookup.set(path, handles);
    }
  }

  willReadType(group: string): boolean {
    const desc = this.registry.groups.get(group);
    return desc !== undefined && desc.minimalParseMode <= this.mode;
  }

  willReadClassNetCache(group: string): boolean {
    const desc = this.registry.classNetCaches.get(group);
    return desc !== undefined && desc.minimalParseMode <= this.mode;
  }

  tryGetClassNetCacheProperty(
    property: string,
    group: string,
  ): ClassNetCacheProperty | null {
    const groupInfo = this.registry.classNetCaches.get(group);
    if (!groupInfo) return null;
    return groupInfo.properties.find((p) => p.name === property) ?? null;
  }

  createType(group: string): object | null {
    const desc = this.registry.groups.get(group);
    if (!desc) return null;
    return desc.factory();
  }

  createPropertyType(group: string, propertyName: string): IProperty | null {
    const groupInfo = this.registry.classNetCaches.get(group);
    if (!groupInfo) return null;
    const prop = groupInfo.properties.find((p) => p.name === propertyName);
    if (prop?.propertyFactory) return prop.propertyFactory();
    return null;
  }

  // PLACEHOLDER_READFIELD

  /** Read one field into the export object. Returns false if unparseable. */
  readField(
    obj: object,
    exportField: NetFieldExport,
    handle: number,
    exportGroup: NetFieldExportGroup,
    reader: NetBitReader,
  ): boolean {
    const groupDesc = this.registry.groups.get(exportGroup.PathName);
    if (!groupDesc) return false;

    // IHandleNetFieldExportGroup: let the object consume the field directly.
    const handleReader = obj as Partial<IHandleNetFieldExportGroup>;
    if (
      typeof handleReader.readFieldHandle === "function" &&
      handleReader.readFieldHandle(handle, reader)
    ) {
      return true;
    }

    let fieldDesc: NetFieldDescriptor | undefined;
    if (groupDesc.usesHandles) {
      fieldDesc = this.handleLookup.get(exportGroup.PathName)?.get(handle);
    } else {
      fieldDesc = this.nameLookup.get(exportGroup.PathName)?.get(exportField.Name);
    }
    if (!fieldDesc) return false;

    this.setType(obj, fieldDesc, groupDesc, exportGroup, reader);
    return true;
  }

  private setType(
    obj: object,
    fieldInfo: NetFieldDescriptor,
    groupDesc: NetFieldExportGroupDescriptor,
    exportGroup: NetFieldExportGroup,
    reader: NetBitReader,
  ): void {
    let data: unknown;
    if (fieldInfo.type === RepLayoutCmdType.DynamicArray) {
      data = this.readArrayField(exportGroup, fieldInfo, groupDesc, reader);
    } else if (fieldInfo.type === RepLayoutCmdType.RepMovement) {
      data = fieldInfo.movement
        ? reader.serializeRepMovement(
            fieldInfo.movement.location,
            fieldInfo.movement.rotation,
            fieldInfo.movement.velocity,
          )
        : reader.serializeRepMovement();
    } else {
      data = this.readDataType(fieldInfo.type, reader, fieldInfo.elementFactory);
    }

    if (data !== undefined && data !== null && !reader.IsError) {
      (obj as Record<string, unknown>)[fieldInfo.key] = data;
    }
  }

  private readDataType(
    replayout: RepLayoutCmdType,
    reader: NetBitReader,
    elementFactory?: (() => object) | null,
  ): unknown {
    switch (replayout) {
      case RepLayoutCmdType.Property: {
        const data = elementFactory ? elementFactory() : null;
        if (hasSerialize(data)) data.serialize(reader);
        if (hasResolve(data)) data.resolve(this.guidCache);
        return data;
      }
      case RepLayoutCmdType.PropertyBool:
        return reader.serializePropertyBool();
      case RepLayoutCmdType.PropertyName:
        return reader.serializePropertyName();
      case RepLayoutCmdType.PropertyFloat:
        return reader.serializePropertyFloat();
      case RepLayoutCmdType.PropertyDouble:
        return reader.serializePropertyDouble();
      case RepLayoutCmdType.PropertyNativeBool:
        return reader.serializePropertyNativeBool();
      case RepLayoutCmdType.PropertyNetId:
        return reader.serializePropertyNetId();
      case RepLayoutCmdType.PropertyObject:
        return reader.serializePropertyObject();
      case RepLayoutCmdType.PropertyRotator:
        return reader.serializePropertyRotator();
      case RepLayoutCmdType.PropertyString:
        return reader.serializePropertyString();
      case RepLayoutCmdType.PropertyVector10:
        return reader.serializePropertyVector10();
      case RepLayoutCmdType.PropertyVector100:
        return reader.serializePropertyVector100();
      case RepLayoutCmdType.PropertyVectorNormal:
        return reader.serializePropertyVectorNormal();
      case RepLayoutCmdType.PropertyVectorQ:
        return reader.serializePropertyQuantizedVector(
          VectorQuantization.RoundWholeNumber,
        );
      case RepLayoutCmdType.RepMovement:
        return reader.serializeRepMovement();
      case RepLayoutCmdType.Enum:
        return reader.serializePropertyEnum();
      case RepLayoutCmdType.PropertyByte:
        return reader.readByte();
      case RepLayoutCmdType.PropertyInt:
        return reader.readInt32();
      case RepLayoutCmdType.PropertyInt16:
        return reader.readInt16();
      case RepLayoutCmdType.PropertyUInt64:
        return reader.readUInt64();
      case RepLayoutCmdType.PropertyUInt16:
        return reader.readUInt16();
      case RepLayoutCmdType.PropertyUInt32:
        return reader.readUInt32();
      case RepLayoutCmdType.PropertyVector:
        return reader.serializePropertyVector();
      case RepLayoutCmdType.PropertyVector2D:
        return reader.serializePropertyVector2D();
      case RepLayoutCmdType.PropertyQuat: {
        // FQuat serialized via IProperty when a factory is present.
        const data = elementFactory ? elementFactory() : null;
        if (hasSerialize(data)) data.serialize(reader);
        return data;
      }
      default:
        reader.seek(reader.getBitsLeft(), SeekOrigin.Current);
        return undefined;
    }
  }

  private readArrayField(
    exportGroup: NetFieldExportGroup,
    fieldInfo: NetFieldDescriptor,
    _groupDesc: NetFieldExportGroupDescriptor,
    reader: NetBitReader,
  ): unknown[] | null {
    const arrayLength = reader.readIntPacked();
    const isGroupType = fieldInfo.elementFactory != null;
    const replayout = fieldInfo.elementType ?? RepLayoutCmdType.Ignore;

    if (!isGroupType && replayout === RepLayoutCmdType.Ignore) {
      return null;
    }

    const arr: unknown[] = new Array(arrayLength).fill(null);

    for (;;) {
      let index = reader.readIntPacked();
      if (index === 0) {
        if (reader.getBitsLeft() === 8) {
          const terminator = reader.readIntPacked();
          if (terminator !== 0) return arr;
        }
        return arr;
      }
      index--;
      if (index >= arrayLength) return arr;

      let data: unknown = null;
      if (isGroupType) data = fieldInfo.elementFactory!();

      for (;;) {
        let handle = reader.readIntPacked();
        if (handle === 0) break;
        handle--;
        if (exportGroup.NetFieldExportsLength < handle) return arr;

        const exportField = exportGroup.NetFieldExports[handle];
        const numBits = reader.readIntPacked();
        if (numBits === 0) continue;
        if (!exportField) {
          reader.skipBits(numBits);
          continue;
        }

        reader.setTempEnd(numBits, FBitArchiveEndIndex.READ_ARRAY_FIELD);
        try {
          if (isGroupType && data) {
            this.readField(data, exportField, handle, exportGroup, reader);
          } else {
            data = this.readDataType(replayout, reader);
          }
        } finally {
          reader.restoreTempEnd(FBitArchiveEndIndex.READ_ARRAY_FIELD);
        }
      }
      arr[index] = data;
    }
  }
}
