/**
 * Replication-layer model types from Unreal.Core/Models.
 */
import type { BitReader } from "../io/bit-reader.js";
import type { NetBitReader } from "../io/net-bit-reader.js";
import type { FArchive } from "../io/farchive.js";
import {
  ChannelCloseReason,
  ChannelName,
  ChannelType,
  NetworkVersionHistory,
  ReplayHeaderFlags,
  ReplayVersionHistory,
  BuildTargetType,
} from "./enums.js";
import { EngineNetworkVersionHistory as EngineNetVer } from "../io/enums.js";

/** Marker interface: a class that can receive replicated properties. */
export interface INetFieldExportGroup {
  readonly __isNetFieldExportGroup?: true;
}

/** A property that can deserialize itself from a NetBitReader. */
export interface IProperty {
  serialize(reader: NetBitReader): void;
}

/** An export group that consumes fields by handle with custom logic. */
export interface IHandleNetFieldExportGroup {
  readFieldHandle(handle: number, reader: NetBitReader): boolean;
}

/** A property that can resolve netguids after deserialization. */
export interface IResolvable {
  resolve(cache: import("./net-guid-cache.js").NetGuidCache): void;
}

export interface IExternalData {
  NetGUID: number;
  Archive: FArchive;
  TimeSeconds: number;
}

export enum ETextHistoryType {
  None = -1,
  Base = 0,
}

/** Localized text. see Unreal Text.cpp NetSerialize. */
export class FText implements IProperty {
  Namespace = "";
  Key = "";
  Text = "";
  serialize(reader: NetBitReader): void {
    reader.readInt32(); // flags
    const historyType = reader.readByte();
    if (historyType === ETextHistoryType.Base) {
      this.Namespace = reader.readFString();
      this.Key = reader.readFString();
      this.Text = reader.readFString();
    }
  }
}

export class NetworkGUID implements IProperty {
  Value = 0;
  isValid(): boolean {
    return this.Value > 0;
  }
  isDynamic(): boolean {
    return this.Value > 0 && (this.Value & 1) !== 1;
  }
  isDefault(): boolean {
    return this.Value === 1;
  }
  serialize(reader: NetBitReader): void {
    this.Value = reader.readIntPacked();
  }
}

export class NetFieldExport {
  IsExported = false;
  Handle = 0;
  CompatibleChecksum = 0;
  Name = "";
  Type = "";
  Incompatible = false;
  /** -1 unknown, -2 not found. */
  PropertyId = -1;
}

export class NetFieldExportGroup {
  PathName = "";
  PathNameIndex = 0;
  NetFieldExportsLength = 0;
  NetFieldExports: (NetFieldExport | null)[] = [];
  /** -1 unknown, -2 not found. */
  GroupId = -1;

  isValidIndex(handle: number): boolean {
    return handle >= 0 && handle < this.NetFieldExportsLength;
  }
}

export class Actor {
  ActorNetGUID!: NetworkGUID;
  Archetype?: NetworkGUID;
  Level?: NetworkGUID;
  Location?: import("../io/models.js").FVector;
  Rotation?: import("../io/models.js").FRotator;
  Scale?: import("../io/models.js").FVector;
  Velocity?: import("../io/models.js").FVector;
}

export class UChannel {
  private ignore = new Set<string>();
  ChannelName: ChannelName = ChannelName.None;
  ChannelIndex = 0;
  ChannelType: ChannelType = ChannelType.None;
  Actor: Actor | null = null;

  ignoreGroup(group: string): void {
    this.ignore.add(group);
  }
  isIgnoringGroup(group: string): boolean {
    return this.ignore.has(group);
  }
  get ArchetypeId(): number | undefined {
    return this.Actor?.Archetype?.Value;
  }
  get ActorId(): number | undefined {
    return this.Actor?.ActorNetGUID?.Value;
  }
}

export class DataBunch {
  Archive!: BitReader;
  PacketId = 0;
  ChIndex = 0;
  ChType: ChannelType = ChannelType.None;
  ChName: ChannelName = ChannelName.None;
  ChSequence = 0;
  bOpen = false;
  bClose = false;
  bDormant = false;
  bIsReplicationPaused = false;
  bReliable = false;
  bPartial = false;
  bPartialInitial = false;
  bHasPartialCustomExportsFinalBit = false;
  bPartialFinal = false;
  bHasPackageMapExports = false;
  bHasMustBeMappedGUIDs = false;
  bIgnoreRPCs = false;
  CloseReason: ChannelCloseReason = ChannelCloseReason.Destroyed;

  constructor(other?: DataBunch) {
    if (other) {
      this.Archive = other.Archive;
      this.PacketId = other.PacketId;
      this.ChIndex = other.ChIndex;
      this.ChType = other.ChType;
      this.ChName = other.ChName;
      this.ChSequence = other.ChSequence;
      this.bOpen = other.bOpen;
      this.bClose = other.bClose;
      this.bDormant = other.bDormant;
      this.bIsReplicationPaused = other.bIsReplicationPaused;
      this.bReliable = other.bReliable;
      this.bPartial = other.bPartial;
      this.bPartialInitial = other.bPartialInitial;
      this.bPartialFinal = other.bPartialFinal;
      this.bHasPackageMapExports = other.bHasPackageMapExports;
      this.bHasMustBeMappedGUIDs = other.bHasMustBeMappedGUIDs;
      this.bIgnoreRPCs = other.bIgnoreRPCs;
      this.CloseReason = other.CloseReason;
    }
  }
}

export class NetGuidCacheObject {
  OuterGuid?: NetworkGUID;
  PathName = "";
  NetworkChecksum = 0;
  Flags = 0;
}

export class NetDeltaUpdate {
  ElementIndex = 0;
  Export: INetFieldExportGroup | null = null;
  Deleted = false;
  ChannelIndex = 0;
}

export interface FFastArraySerializerHeader {
  ArrayReplicationKey: number;
  BaseReplicationKey: number;
  NumDeletes: number;
  NumChanged: number;
}

export interface EventInfo {
  Id: string;
  Group: string;
  Metadata: string;
  StartTime: number;
  EndTime: number;
  SizeInBytes: number;
}
export type CheckpointInfo = EventInfo;

export interface ReplayDataInfo {
  Start?: number;
  End?: number;
  Length: number;
}

export class ReplayInfo {
  FileVersion: ReplayVersionHistory = ReplayVersionHistory.HISTORY_INITIAL;
  LengthInMs = 0;
  NetworkVersion = 0;
  Changelist = 0;
  FriendlyName = "";
  IsLive = false;
  Timestamp?: Date;
  IsCompressed = false;
  IsEncrypted = false;
  EncryptionKey: Uint8Array = new Uint8Array(0);
}

export class ReplayHeader {
  NetworkVersion: NetworkVersionHistory =
    NetworkVersionHistory.HISTORY_REPLAY_INITIAL;
  NetworkChecksum = 0;
  EngineNetworkVersion: EngineNetVer = EngineNetVer.HISTORY_INITIAL;
  GameNetworkProtocolVersion = 0;
  Guid = "";
  Major = 0;
  Minor = 0;
  Patch = 0;
  Changelist = 0;
  Branch = "";
  UE4Version = 0;
  UE5Version = 0;
  PackageVersionLicenseeUE = 0;
  LevelNamesAndTimes: [string, number][] = [];
  Flags: ReplayHeaderFlags = ReplayHeaderFlags.None;
  GameSpecificData: string[] = [];
  Platform = "";
  BuildTargetType: BuildTargetType = BuildTargetType.Unknown;
}

export class Replay {
  Info: ReplayInfo = new ReplayInfo();
  Header: ReplayHeader = new ReplayHeader();
}

export class ExternalData implements IExternalData {
  NetGUID = 0;
  Archive!: FArchive;
  TimeSeconds = 0;
}
