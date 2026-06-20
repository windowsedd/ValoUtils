/**
 * Replication-layer enums from Unreal.Core/Models/Enums.
 * (Reader-layer enums live in ../io/enums.ts.)
 */

export enum RepLayoutCmdType {
  DynamicArray = 0,
  Return = 1,
  Property = 2,
  PropertyBool = 3,
  PropertyFloat = 4,
  PropertyInt = 5,
  PropertyByte = 6,
  PropertyName = 7,
  PropertyObject = 8,
  PropertyUInt32 = 9,
  PropertyVector = 10,
  PropertyRotator = 11,
  PropertyPlane = 12,
  PropertyVector100 = 13,
  PropertyNetId = 14,
  RepMovement = 15,
  PropertyVectorNormal = 16,
  PropertyVector10 = 17,
  PropertyVectorQ = 18,
  PropertyString = 19,
  PropertyUInt64 = 20,
  PropertyNativeBool = 21,
  PropertySoftObject = 22,
  PropertyWeakObject = 23,
  PropertyInterface = 24,
  NetSerializeStructWithObjectReferences = 25,
  PropertyDouble = 94,
  PropertyVector2D = 95,
  PropertyInt16 = 96,
  PropertyUInt16 = 97,
  PropertyQuat = 98,
  Enum = 99,
  Ignore = 100,
}

export enum ChannelName {
  Control = 0,
  Voice = 1,
  Actor = 2,
  None = 3,
}

export enum ChannelType {
  None = 0,
  Control = 1,
  Actor = 2,
  File = 3,
  Voice = 4,
  MAX = 8,
}

export enum ChannelCloseReason {
  Destroyed = 0,
  Dormancy = 1,
  LevelUnloaded = 2,
  Relevancy = 3,
  TearOff = 4,
  MAX = 15,
}

export enum NetworkVersionHistory {
  HISTORY_REPLAY_INITIAL = 1,
  HISTORY_SAVE_ABS_TIME_MS = 2,
  HISTORY_INCREASE_BUFFER = 3,
  HISTORY_SAVE_ENGINE_VERSION = 4,
  HISTORY_EXTRA_VERSION = 5,
  HISTORY_MULTIPLE_LEVELS = 6,
  HISTORY_MULTIPLE_LEVELS_TIME_CHANGES = 7,
  HISTORY_DELETED_STARTUP_ACTORS = 8,
  HISTORY_HEADER_FLAGS = 9,
  HISTORY_LEVEL_STREAMING_FIXES = 10,
  HISTORY_SAVE_FULL_ENGINE_VERSION = 11,
  HISTORY_HEADER_GUID = 12,
  HISTORY_CHARACTER_MOVEMENT = 13,
  HISTORY_CHARACTER_MOVEMENT_NOINTERP = 14,
  HISTORY_GUID_NAMETABLE = 15,
  HISTORY_GUIDCACHE_CHECKSUMS = 16,
  HISTORY_SAVE_PACKAGE_VERSION_UE = 17,
  HISTORY_RECORDING_METADATA = 18,
  HISTORY_USE_CUSTOM_VERSION = 19,
  LATEST = 19,
}

export enum ReplayVersionHistory {
  HISTORY_INITIAL = 0,
  HISTORY_FIXEDSIZE_FRIENDLY_NAME = 1,
  HISTORY_COMPRESSION = 2,
  HISTORY_RECORDED_TIMESTAMP = 3,
  HISTORY_STREAM_CHUNK_TIMES = 4,
  HISTORY_FRIENDLY_NAME_ENCODING = 5,
  HISTORY_ENCRYPTION = 6,
  HISTORY_CUSTOM_VERSIONS = 7,
  LATEST = 7,
}

export enum ReplayHeaderFlags {
  None = 0,
  ClientRecorded = 1 << 0,
  HasStreamingFixes = 1 << 1,
  DeltaCheckpoints = 1 << 2,
  GameSpecificFrameData = 1 << 3,
  ReplayConnection = 1 << 4,
  ActorPrioritizationEnabled = 1 << 5,
  NetRelevancyEnabled = 1 << 6,
  AsyncRecorded = 1 << 7,
}

export enum ExportFlags {
  None = 0,
  bHasPath = 1,
  bNoLoad = 2,
  bHasPathAndNoLoad = 3,
  bHasNetworkChecksum = 4,
  bHasPathAndNetWorkChecksum = 5,
  bNoLoadAndNetworkChecksum = 6,
  All = 7,
}

export enum ParseMode {
  EventsOnly = 0,
  Minimal = 1,
  Normal = 2,
  Full = 3,
  Debug = 4,
  Ignore = 5,
}

export enum BuildTargetType {
  Unknown = 0,
  Game = 1,
  Server = 2,
  Client = 3,
  Editor = 4,
  Program = 5,
}

export enum FBitArchiveEndIndex {
  BUNCH = 0,
  CONTENT_BLOCK_PAYLOAD = 1,
  FIELD_HEADER_PAYLOAD = 2,
  READ_ARRAY_FIELD = 3,
}

export enum ReplayChunkType {
  Header = 0,
  ReplayData = 1,
  Checkpoint = 2,
  Event = 3,
  Unknown = 0xffffffff,
}

export enum PacketState {
  Success = 0,
  End = 1,
  Error = 2,
}
