/**
 * ReplayReader — abstract base implementing default UE replay parsing.
 * Ported from Unreal.Core/ReplayReader.cs.
 *
 * The C# class was generic over `T : Replay`; here it's generic over a Replay
 * subtype too. Concrete readers (e.g. ValorantReplayReader) override the
 * Decompress / DecryptBuffer / ReceivedReplicatorBunch / On* hooks.
 */
import { FArchive, SeekOrigin } from "../io/farchive.js";
import { BitReader } from "../io/bit-reader.js";
import { BinaryReader } from "../io/binary-reader.js";
import { NetBitReader } from "../io/net-bit-reader.js";
import { EngineNetworkVersionHistory } from "../io/enums.js";
import { FVector, FRotator } from "../io/models.js";
import {
  ChannelCloseReason,
  ChannelType,
  ChannelName,
  ExportFlags,
  FBitArchiveEndIndex,
  NetworkVersionHistory,
  PacketState,
  ParseMode,
  ReplayChunkType,
  ReplayHeaderFlags,
  ReplayVersionHistory,
} from "./enums.js";
import {
  Actor,
  DataBunch,
  ExternalData,
  NetFieldExport,
  NetFieldExportGroup,
  NetGuidCacheObject,
  NetworkGUID,
  NetDeltaUpdate,
  Replay,
  ReplayHeader,
  ReplayInfo,
  UChannel,
  type FFastArraySerializerHeader,
  type INetFieldExportGroup,
  type IExternalData,
} from "./models.js";
import { NetGuidCache } from "./net-guid-cache.js";
import { NetFieldParser } from "./net-field-parser.js";
import { registry } from "./registry.js";
import { removeAllPathPrefixes } from "./string-utils.js";

const DefaultMaxChannelSize = 32767;
const FileMagic = 1140125661;
const NetworkMagic = 0x2cf5a13d;
const MaxPacketSizeInBits = 16384;
const OLD_MAX_ACTOR_CHANNELS = 10240;
const MAX_GUID_COUNT = 2048;

export abstract class ReplayReader<T extends Replay> {
  protected mode: ParseMode;
  protected replay!: T;
  protected netGuidCache = new NetGuidCache();
  protected netFieldParser: NetFieldParser;

  private replayDataIndex = 0;
  private checkpointIndex = 0;
  private packetIndex = 0;
  private bunchIndex = 0;
  private inPacketId = 0;
  private partialBunch: DataBunch | null = null;
  private inReliable = 0;

  /** Time (seconds) of the demo frame currently being parsed. */
  protected currentFrameTimeSeconds = 0;

  protected channels: (UChannel | null)[] = new Array(DefaultMaxChannelSize).fill(
    null,
  );
  private ignoringChannels: (number | null)[] = new Array(
    DefaultMaxChannelSize,
  ).fill(null);

  // Allocated once and reused, mirroring the C# fields.
  private packetReader = new NetBitReader(new Uint8Array(0));
  private exportReader = new NetBitReader(new Uint8Array(0));
  private cmdReader = new NetBitReader(new Uint8Array(0));
  private deltaUpdate = new NetDeltaUpdate();

  constructor(mode: ParseMode) {
    this.mode = mode;
    this.netFieldParser = new NetFieldParser(this.netGuidCache, registry, mode);
  }

  protected abstract createReplay(): T;

  // ---- top-level -----------------------------------------------------------

  readReplayFromArchive(archive: FArchive): T {
    this.replay = this.createReplay();
    this.readReplayInfo(archive);
    this.readReplayChunks(archive);
    this.cleanup();
    return this.replay;
  }

  protected cleanup(): void {
    this.inReliable = 0;
    this.channels = new Array(DefaultMaxChannelSize).fill(null);
    this.ignoringChannels = new Array(DefaultMaxChannelSize).fill(null);
    this.replayDataIndex = 0;
    this.checkpointIndex = 0;
    this.packetIndex = 0;
    this.bunchIndex = 0;
    this.inPacketId = 0;
    this.partialBunch = null;
    this.netGuidCache.cleanup();
  }

  // ---- overridable hooks ---------------------------------------------------

  /** Decrypt a chunk; default passthrough (Valorant replays are unencrypted). */
  protected decryptBuffer(archive: FArchive, _size: number): FArchive {
    if (!this.replay.Info.IsEncrypted) return archive;
    throw new Error("Replay is marked as encrypted; decryptBuffer not implemented");
  }

  /** Decompress a chunk; concrete readers override with Oodle. */
  protected decompress(archive: FArchive): FArchive {
    if (!this.replay.Info.IsCompressed) return archive;
    throw new Error("Replay is marked as compressed; decompress not implemented");
  }

  protected onExportRead(
    _channelIndex: number,
    _exportGroup: INetFieldExportGroup | object | null,
  ): void {}
  protected onExternalDataRead(
    _channelIndex: number,
    _data: IExternalData | undefined,
  ): void {}
  protected onNetDeltaRead(_channelIndex: number, _update: NetDeltaUpdate): void {}
  protected onChannelOpened(_channelIndex: number, _actor: NetworkGUID | undefined): void {}
  protected onChannelClosed(_channelIndex: number, _actor: NetworkGUID | undefined): void {}

  // ---- replay info / header ------------------------------------------------

  readReplayInfo(archive: FArchive): void {
    const magicNumber = archive.readUInt32();
    if (magicNumber !== FileMagic) {
      throw new Error("Invalid replay file");
    }
    const fileVersion = archive.readUInt32() as ReplayVersionHistory;
    archive.ReplayVersion = fileVersion;

    if (fileVersion >= ReplayVersionHistory.HISTORY_CUSTOM_VERSIONS) {
      const customVersionCount = archive.readInt32();
      archive.skipBytes(customVersionCount * 20);
    }

    const info = new ReplayInfo();
    info.FileVersion = fileVersion;
    info.LengthInMs = archive.readUInt32();
    info.NetworkVersion = archive.readUInt32();
    info.Changelist = archive.readUInt32();
    info.FriendlyName = archive.readFString();
    info.IsLive = archive.readUInt32AsBoolean();

    if (fileVersion >= ReplayVersionHistory.HISTORY_RECORDED_TIMESTAMP) {
      // C# DateTime.FromBinary; we keep the raw ticks as a Date best-effort.
      const ticks = archive.readInt64();
      info.Timestamp = ticksToDate(ticks);
    }
    if (fileVersion >= ReplayVersionHistory.HISTORY_COMPRESSION) {
      info.IsCompressed = archive.readUInt32AsBoolean();
    }
    if (fileVersion >= ReplayVersionHistory.HISTORY_ENCRYPTION) {
      info.IsEncrypted = archive.readUInt32AsBoolean();
      const size = archive.readUInt32();
      info.EncryptionKey = archive.readBytes(size).slice();
    }

    if (!info.IsLive && info.IsEncrypted && info.EncryptionKey.length === 0) {
      throw new Error("Completed replay is marked encrypted but has no key!");
    }
    if (info.IsLive && info.IsEncrypted) {
      throw new Error("Replay is marked encrypted but not yet marked as completed!");
    }
    this.replay.Info = info;
  }

  readReplayChunks(archive: FArchive): void {
    while (!archive.atEnd()) {
      const chunkType = archive.readUInt32() as ReplayChunkType;
      const chunkSize = archive.readInt32();
      const offset = archive.Position;

      if (chunkSize <= 0) {
        archive.setError();
        return;
      }

      if (chunkType === ReplayChunkType.ReplayData && this.mode > ParseMode.EventsOnly) {
        this.readReplayData(archive, chunkSize);
      } else if (chunkType === ReplayChunkType.Checkpoint) {
        // skipped: only needed for fast-forward
      } else if (chunkType === ReplayChunkType.Event) {
        this.readEvent(archive);
      } else if (chunkType === ReplayChunkType.Header) {
        this.readReplayHeader(archive);
      }

      if (archive.Position !== offset + chunkSize) {
        archive.seek(offset + chunkSize, SeekOrigin.Begin);
      }
    }
  }

  /** Override to handle text events; default reads + ignores. */
  readEvent(archive: FArchive): void {
    archive.readFString(); // id
    archive.readFString(); // group
    archive.readFString(); // metadata
    archive.readUInt32(); // start
    archive.readUInt32(); // end
    archive.readInt32(); // size
  }

  readReplayData(archive: FArchive, fallbackChunkSize: number): void {
    let length = fallbackChunkSize;
    if ((archive.ReplayVersion & ReplayVersionHistory.HISTORY_STREAM_CHUNK_TIMES) !== 0) {
      archive.readUInt32(); // start
      archive.readUInt32(); // end
      length = archive.readUInt32();
    }
    if ((archive.ReplayVersion & ReplayVersionHistory.HISTORY_ENCRYPTION) !== 0) {
      archive.readInt32(); // memorySizeInBytes
    }
    const decrypted = this.decryptBuffer(archive, length);
    const binaryArchive = this.decompress(decrypted);
    while (!binaryArchive.atEnd()) {
      this.readDemoFrameIntoPlaybackPackets(binaryArchive);
    }
    this.replayDataIndex++;
  }

  readReplayHeader(archive: FArchive): void {
    const magic = archive.readUInt32();
    if (magic !== NetworkMagic) {
      throw new Error("Header.Magic != NETWORK_DEMO_MAGIC");
    }
    const header = new ReplayHeader();
    header.NetworkVersion = archive.readUInt32() as NetworkVersionHistory;

    if (header.NetworkVersion >= NetworkVersionHistory.HISTORY_USE_CUSTOM_VERSION) {
      const customVersionCount = archive.readInt32();
      archive.skipBytes(customVersionCount * 20);
    }
    header.NetworkChecksum = archive.readUInt32();
    header.EngineNetworkVersion = archive.readUInt32() as EngineNetworkVersionHistory;
    header.GameNetworkProtocolVersion = archive.readUInt32();

    if (header.NetworkVersion >= NetworkVersionHistory.HISTORY_HEADER_GUID) {
      header.Guid = archive.readGUID();
    }
    if (header.NetworkVersion >= NetworkVersionHistory.HISTORY_SAVE_FULL_ENGINE_VERSION) {
      header.Major = archive.readUInt16();
      header.Minor = archive.readUInt16();
      header.Patch = archive.readUInt16();
      header.Changelist = archive.readUInt32();
      header.Branch = archive.readFString();
      archive.NetworkReplayVersion = {
        Major: header.Major,
        Minor: header.Minor,
        Patch: header.Patch,
        Changelist: header.Changelist,
        Branch: header.Branch,
      };
    } else {
      header.Changelist = archive.readUInt32();
    }

    // VALORANT-specific byte skip
    const bytesToSkip = archive.readUInt32();
    archive.skipBytes(bytesToSkip);

    if (header.NetworkVersion >= NetworkVersionHistory.HISTORY_RECORDING_METADATA) {
      header.UE4Version = archive.readUInt32();
      header.UE5Version = archive.readUInt32();
      header.PackageVersionLicenseeUE = archive.readUInt32();
    }

    if (header.NetworkVersion <= NetworkVersionHistory.HISTORY_MULTIPLE_LEVELS) {
      throw new Error("HISTORY_MULTIPLE_LEVELS not supported yet.");
    } else {
      const count = archive.readUInt32();
      header.LevelNamesAndTimes = [];
      for (let i = 0; i < count; i++) {
        header.LevelNamesAndTimes.push([archive.readFString(), archive.readUInt32()]);
      }
    }

    if (header.NetworkVersion >= NetworkVersionHistory.HISTORY_HEADER_FLAGS) {
      header.Flags = archive.readUInt32() as ReplayHeaderFlags;
      archive.ReplayHeaderFlags = header.Flags;
    }

    header.GameSpecificData = archive.readArray(() => archive.readFString());

    if (header.NetworkVersion >= NetworkVersionHistory.HISTORY_SAVE_PACKAGE_VERSION_UE) {
      archive.readSingle(); // minRecordHz
      archive.readSingle(); // maxRecordHz
      archive.readSingle(); // frameLimitInMS
      archive.readSingle(); // checkpointLimitInMS
      header.Platform = archive.readFString();
      archive.readByte(); // buildConfig
      header.BuildTargetType = archive.readByte();
    }

    archive.EngineNetworkVersion = header.EngineNetworkVersion;
    archive.NetworkVersion = header.NetworkVersion;
    this.replay.Header = header;

    for (const r of [this.packetReader, this.exportReader, this.cmdReader]) {
      r.EngineNetworkVersion = header.EngineNetworkVersion;
      r.NetworkVersion = header.NetworkVersion;
      r.ReplayHeaderFlags = header.Flags;
    }
  }

  // ---- export data / net field exports -------------------------------------

  readExportData(archive: FArchive): void {
    this.readNetFieldExports(archive);
    this.readNetExportGuids(archive);
  }

  readNetExportGuids(archive: FArchive): void {
    const numGuids = archive.readIntPacked();
    for (let i = 0; i < numGuids; i++) {
      const size = archive.readInt32();
      this.exportReader.fillBuffer(archive.readBytes(size).slice());
      this.internalLoadObject(this.exportReader, true);
    }
  }

  readNetFieldExports(archive: FArchive): void {
    const numLayoutCmdExports = archive.readIntPacked();
    for (let i = 0; i < numLayoutCmdExports; i++) {
      const pathNameIndex = archive.readIntPacked();
      const isExported = archive.readIntPacked() === 1;
      let group: NetFieldExportGroup | null;

      if (isExported) {
        const pathName = archive.readFString();
        const numExports = archive.readIntPacked();
        group = this.netGuidCache.NetFieldExportGroupMap.get(pathName) ?? null;
        if (!group) {
          group = new NetFieldExportGroup();
          group.PathName = pathName;
          group.PathNameIndex = pathNameIndex;
          group.NetFieldExportsLength = numExports;
          group.NetFieldExports = new Array(numExports).fill(null);
          this.netGuidCache.addToExportGroupMap(pathName, group);
        } else if (numExports > group.NetFieldExportsLength) {
          const old = group.NetFieldExports;
          group.NetFieldExports = new Array(numExports).fill(null);
          group.NetFieldExportsLength = numExports;
          for (let j = 0; j < old.length; j++) group.NetFieldExports[j] = old[j]!;
        }
      } else {
        group = this.netGuidCache.getNetFieldExportGroupFromIndex(pathNameIndex);
      }

      const netField = this.readNetFieldExport(archive);
      if (group && netField && group.isValidIndex(netField.Handle)) {
        group.NetFieldExports[netField.Handle] = netField;
      }
    }
  }

  readNetFieldExport(archive: FArchive): NetFieldExport | null {
    const isExported = archive.readBoolean();
    if (!isExported) return null;
    const fieldExport = new NetFieldExport();
    fieldExport.Handle = archive.readIntPacked();
    fieldExport.CompatibleChecksum = archive.readUInt32();
    if (
      archive.EngineNetworkVersion <
      EngineNetworkVersionHistory.HISTORY_NETEXPORT_SERIALIZATION
    ) {
      fieldExport.Name = archive.readFString();
      fieldExport.Type = archive.readFString();
    } else if (
      archive.EngineNetworkVersion <
      EngineNetworkVersionHistory.HISTORY_NETEXPORT_SERIALIZE_FIX
    ) {
      fieldExport.Name = archive.readFString();
    } else {
      fieldExport.Name = archive.readFName();
    }
    return fieldExport;
  }

  readNetFieldExportGroupMap(archive: FArchive): NetFieldExportGroup {
    const group = new NetFieldExportGroup();
    group.PathName = archive.readFString();
    group.PathNameIndex = archive.readIntPacked();
    group.NetFieldExportsLength = archive.readIntPacked();
    group.NetFieldExports = new Array(group.NetFieldExportsLength).fill(null);
    for (let i = 0; i < group.NetFieldExportsLength; i++) {
      const e = this.readNetFieldExport(archive);
      if (e && group.isValidIndex(e.Handle)) group.NetFieldExports[e.Handle] = e;
    }
    return group;
  }

  // ---- demo frame ----------------------------------------------------------

  readDemoFrameIntoPlaybackPackets(archive: FArchive): void {
    if (archive.NetworkVersion >= NetworkVersionHistory.HISTORY_MULTIPLE_LEVELS) {
      archive.readInt32(); // currentLevelIndex
    }
    this.currentFrameTimeSeconds = archive.readSingle();

    if (archive.NetworkVersion >= NetworkVersionHistory.HISTORY_LEVEL_STREAMING_FIXES) {
      this.readExportData(archive);
    }

    if (archive.hasLevelStreamingFixes()) {
      const numStreamingLevels = archive.readIntPacked();
      for (let i = 0; i < numStreamingLevels; i++) archive.readFString();
    } else {
      const numStreamingLevels = archive.readIntPacked();
      for (let i = 0; i < numStreamingLevels; i++) {
        archive.readFString();
        archive.readFString();
        archive.readFTransform();
      }
    }

    if (archive.hasLevelStreamingFixes()) {
      archive.readUInt64(); // externalOffset
    }

    this.readExternalData(archive);

    if (archive.hasGameSpecificFrameData()) {
      const skipExternalOffset = archive.readUInt64();
      if (skipExternalOffset > 0n) archive.skipBytes(Number(skipExternalOffset));
    }

    let cont = true;
    while (cont) {
      if (archive.hasLevelStreamingFixes()) {
        archive.readIntPacked(); // seenLevelIndex
      }
      const state = this.readPacket(archive);
      cont = state === PacketState.Success;
    }
  }

  readExternalData(archive: FArchive): void {
    for (;;) {
      const externalDataNumBits = archive.readIntPacked();
      if (externalDataNumBits === 0) return;
      const netGuid = archive.readIntPacked();
      const numBytes = (externalDataNumBits + 7) >> 3;
      const sub = new BinaryReader(archive.readBytes(numBytes).slice());
      sub.NetworkReplayVersion = archive.NetworkReplayVersion;
      sub.EngineNetworkVersion = archive.EngineNetworkVersion;
      sub.ReplayHeaderFlags = archive.ReplayHeaderFlags;
      sub.ReplayVersion = archive.ReplayVersion;
      sub.NetworkVersion = archive.NetworkVersion;
      const data = new ExternalData();
      data.NetGUID = netGuid;
      data.Archive = sub;
      this.netGuidCache.ExternalData.set(netGuid, data);
    }
  }

  readPacket(archive: FArchive): PacketState {
    const bufferSize = archive.readInt32();
    if (bufferSize === 0) return PacketState.End;
    if (bufferSize > 2048 || bufferSize < 0) return PacketState.Error;
    this.receivedRawPacket(archive.readBytes(bufferSize).slice());
    return PacketState.Success;
  }

  receivedRawPacket(packet: Uint8Array): void {
    let lastByte = packet[packet.length - 1]!;
    if (lastByte !== 0) {
      let bitSize = packet.length * 8 - 1;
      while (!((lastByte & 0x80) >= 1)) {
        lastByte = (lastByte * 2) & 0xff;
        bitSize--;
      }
      this.packetReader.fillBuffer(packet, bitSize);
      this.receivedPacket(this.packetReader);
    } else {
      throw new Error("Malformed packet: 0 in last byte");
    }
  }

  // ---- net guid loading ----------------------------------------------------

  internalLoadObject(
    archive: FArchive,
    isExportingNetGUIDBunch: boolean,
    recursion = 0,
  ): NetworkGUID {
    if (recursion > 16) return new NetworkGUID();
    const netGuid = new NetworkGUID();
    netGuid.Value = archive.readIntPacked();
    if (!netGuid.isValid()) return netGuid;

    if (netGuid.isDefault() || isExportingNetGUIDBunch) {
      const flags = archive.readByte() as ExportFlags;
      if ((flags & ExportFlags.bHasPath) !== 0) {
        this.internalLoadObject(archive, true, recursion + 1); // outerGuid
        const pathName = archive.readFString();
        if ((flags & ExportFlags.bHasNetworkChecksum) !== 0) {
          archive.readUInt32();
        }
        if (isExportingNetGUIDBunch) {
          this.netGuidCache.NetGuidToPathName.set(
            netGuid.Value,
            removeAllPathPrefixes(pathName),
          );
        }
        return netGuid;
      }
    }
    return netGuid;
  }

  receiveNetGUIDBunch(archive: BitReader): void {
    const bHasRepLayoutExport = archive.readBit();
    if (bHasRepLayoutExport) {
      this.receiveNetFieldExportsCompat(archive);
      return;
    }
    const numGUIDsInBunch = archive.readInt32();
    if (numGUIDsInBunch > MAX_GUID_COUNT) return;
    let read = 0;
    while (read < numGUIDsInBunch) {
      this.internalLoadObject(archive, true);
      read++;
    }
  }

  receiveNetFieldExportsCompat(archive: BitReader): void {
    const numLayoutCmdExports = archive.readUInt32();
    for (let i = 0; i < numLayoutCmdExports; i++) {
      const pathNameIndex = archive.readIntPacked();
      let group: NetFieldExportGroup | null;
      if (archive.readBit()) {
        const pathName = archive.readFString();
        const numExports = archive.readUInt32();
        group = this.netGuidCache.NetFieldExportGroupMap.get(pathName) ?? null;
        if (!group) {
          group = new NetFieldExportGroup();
          group.PathName = pathName;
          group.PathNameIndex = pathNameIndex;
          group.NetFieldExportsLength = numExports;
          group.NetFieldExports = new Array(numExports).fill(null);
          this.netGuidCache.addToExportGroupMap(pathName, group);
        }
      } else {
        group = this.netGuidCache.getNetFieldExportGroupFromIndex(pathNameIndex);
      }
      const netField = this.readNetFieldExport(archive);
      if (group && netField && group.isValidIndex(netField.Handle)) {
        group.NetFieldExports[netField.Handle] = netField;
      }
    }
  }

  receivedPacket(bitReader: BitReader): void {
    this.inPacketId++;
    const bHasPartialCustomExportsFinalBit =
      !(bitReader.EngineNetworkVersion < EngineNetworkVersionHistory.CustomExports);

    while (!bitReader.atEnd()) {
      if (
        bitReader.EngineNetworkVersion <
        EngineNetworkVersionHistory.HISTORY_ACKS_INCLUDED_IN_HEADER
      ) {
        bitReader.readBit(); // isAckDummy
      }

      const bunch = new DataBunch();
      const bControl = bitReader.readBit();
      bunch.PacketId = this.inPacketId;
      bunch.bOpen = bControl && bitReader.readBit();
      bunch.bClose = bControl && bitReader.readBit();

      if (
        bitReader.EngineNetworkVersion <
        EngineNetworkVersionHistory.HISTORY_CHANNEL_CLOSE_REASON
      ) {
        bunch.bDormant = bunch.bClose && bitReader.readBit();
        bunch.CloseReason = bunch.bDormant
          ? ChannelCloseReason.Dormancy
          : ChannelCloseReason.Destroyed;
      } else {
        bunch.CloseReason = bunch.bClose
          ? (bitReader.readSerializedInt(ChannelCloseReason.MAX) as ChannelCloseReason)
          : ChannelCloseReason.Destroyed;
        bunch.bDormant = bunch.CloseReason === ChannelCloseReason.Dormancy;
      }

      bunch.bIsReplicationPaused = bitReader.readBit();
      bunch.bReliable = bitReader.readBit();

      if (
        bitReader.EngineNetworkVersion <
        EngineNetworkVersionHistory.HISTORY_MAX_ACTOR_CHANNELS_CUSTOMIZATION
      ) {
        bunch.ChIndex = bitReader.readSerializedInt(OLD_MAX_ACTOR_CHANNELS);
      } else {
        bunch.ChIndex = bitReader.readIntPacked();
      }

      bunch.bHasPackageMapExports = bitReader.readBit();
      bunch.bHasMustBeMappedGUIDs = bitReader.readBit();
      bunch.bPartial = bitReader.readBit();

      if (bunch.bReliable) bunch.ChSequence = this.inReliable + 1;
      else if (bunch.bPartial) bunch.ChSequence = this.inPacketId;
      else bunch.ChSequence = 0;

      bunch.bPartialInitial = bunch.bPartial && bitReader.readBit();
      bunch.bHasPartialCustomExportsFinalBit =
        bunch.bPartial && bHasPartialCustomExportsFinalBit
          ? bitReader.readBit()
          : false;
      bunch.bPartialFinal = bunch.bPartial && bitReader.readBit();

      if (
        bitReader.EngineNetworkVersion <
        EngineNetworkVersionHistory.HISTORY_CHANNEL_NAMES
      ) {
        bitReader.readSerializedInt(ChannelType.MAX);
      } else {
        bitReader.readBit();
        if (bunch.bReliable || bunch.bOpen) {
          bitReader.readFName();
        }
      }
      bunch.ChType = ChannelType.None;
      bunch.ChName = ChannelName.None;

      const channelExists = this.channels[bunch.ChIndex] != null;
      const bunchDataBits = bitReader.readSerializedInt(MaxPacketSizeInBits);

      if (bunch.bPartial) {
        const sub = new BitReader(
          bitReader.readBits(bunchDataBits).slice(),
          bunchDataBits,
        );
        sub.EngineNetworkVersion = bitReader.EngineNetworkVersion;
        sub.NetworkVersion = bitReader.NetworkVersion;
        sub.ReplayHeaderFlags = bitReader.ReplayHeaderFlags;
        bunch.Archive = sub;
      } else {
        bitReader.setTempEnd(bunchDataBits, FBitArchiveEndIndex.BUNCH);
        bunch.Archive = bitReader;
      }

      this.bunchIndex++;

      if (bunch.bHasPackageMapExports) {
        this.receiveNetGUIDBunch(bunch.Archive);
      }

      if (!channelExists) {
        const newChannel = new UChannel();
        newChannel.ChannelIndex = bunch.ChIndex;
        this.channels[bunch.ChIndex] = newChannel;
      }

      try {
        this.receivedRawBunch(bunch);
      } catch {
        // swallow per-bunch errors, matching C# behaviour
      } finally {
        if (!bunch.bPartial) {
          bitReader.restoreTempEnd(FBitArchiveEndIndex.BUNCH);
        }
      }
    }
  }

  receivedRawBunch(bunch: DataBunch): void {
    this.receivedNextBunch(bunch);
  }

  receivedNextBunch(bunch: DataBunch): void {
    if (bunch.bReliable) this.inReliable = bunch.ChSequence;

    if (bunch.bPartial) {
      if (bunch.bPartialInitial) {
        if (this.partialBunch != null) {
          if (!this.partialBunch.bPartialFinal) {
            if (this.partialBunch.bReliable) {
              if (bunch.bReliable) return; // reliable destroying reliable
              return;
            }
          }
          this.partialBunch = null;
        }
        this.partialBunch = new DataBunch(bunch);
        const bitsLeft = bunch.Archive.getBitsLeft();
        if (!bunch.bHasPackageMapExports && bitsLeft > 0) {
          if (bitsLeft % 8 !== 0) return;
          // initial partial bunches are byte-aligned; payload appended on merge
        }
        return;
      }

      // non-initial partial
      let bSequenceMatches = false;
      if (this.partialBunch != null) {
        const bReliableMatches = bunch.ChSequence === this.partialBunch.ChSequence + 1;
        const bUnreliableMatches =
          bReliableMatches || bunch.ChSequence === this.partialBunch.ChSequence;
        bSequenceMatches = this.partialBunch.bReliable
          ? bReliableMatches
          : bUnreliableMatches;
      }

      if (
        this.partialBunch != null &&
        !this.partialBunch.bPartialFinal &&
        bSequenceMatches &&
        this.partialBunch.bReliable === bunch.bReliable
      ) {
        const bitsLeft = bunch.Archive.getBitsLeft();
        if (!bunch.bHasPackageMapExports && bitsLeft > 0) {
          this.partialBunch.Archive.appendDataFromChecked(
            bunch.Archive.readBits(bitsLeft).slice(),
            bitsLeft,
          );
        }
        if (
          !bunch.bHasPackageMapExports &&
          !bunch.bPartialFinal &&
          bitsLeft % 8 !== 0
        ) {
          return;
        }
        this.partialBunch.ChSequence = bunch.ChSequence;
        if (bunch.bPartialFinal) {
          if (bunch.bHasPackageMapExports) return;
          this.partialBunch.bPartialFinal = true;
          this.partialBunch.bClose = bunch.bClose;
          this.partialBunch.bDormant = bunch.bDormant;
          this.partialBunch.CloseReason = bunch.CloseReason;
          this.partialBunch.bIsReplicationPaused = bunch.bIsReplicationPaused;
          this.partialBunch.bHasMustBeMappedGUIDs = bunch.bHasMustBeMappedGUIDs;
          this.receivedSequencedBunch(this.partialBunch);
          return;
        }
        return;
      }
      return;
    }

    this.receivedSequencedBunch(bunch);
  }

  receivedSequencedBunch(bunch: DataBunch): boolean {
    this.receivedActorBunch(bunch);
    if (bunch.bClose) {
      const actor = this.channels[bunch.ChIndex]?.Actor?.ActorNetGUID;
      this.channels[bunch.ChIndex] = null;
      this.onChannelClosed(bunch.ChIndex, actor);
      return true;
    }
    return false;
  }

  receivedActorBunch(bunch: DataBunch): void {
    if (bunch.bHasMustBeMappedGUIDs) {
      const num = bunch.Archive.readUInt16();
      for (let i = 0; i < num; i++) bunch.Archive.readIntPacked();
    }
    this.processBunch(bunch);
  }

  conditionallySerializeQuantizedVector(archive: BitReader, def: FVector): FVector {
    const bWasSerialized = archive.readBit();
    if (bWasSerialized) {
      const bShouldQuantize =
        archive.EngineNetworkVersion <
          EngineNetworkVersionHistory.HISTORY_OPTIONALLY_QUANTIZE_SPAWN_INFO ||
        archive.readBit();
      return bShouldQuantize ? archive.readPackedVector(10, 24) : archive.readFVector();
    }
    return def;
  }

  processBunch(bunch: DataBunch): void {
    const channel = this.channels[bunch.ChIndex];
    if (channel != null && channel.Actor == null) {
      if (!bunch.bOpen) return;

      const inActor = new Actor();
      inActor.ActorNetGUID = this.internalLoadObject(bunch.Archive, false);

      if (bunch.Archive.atEnd() && inActor.ActorNetGUID.isDynamic()) return;

      if (inActor.ActorNetGUID.isDynamic()) {
        inActor.Archetype = this.internalLoadObject(bunch.Archive, false);
        if (
          bunch.Archive.EngineNetworkVersion >=
          EngineNetworkVersionHistory.HISTORY_NEW_ACTOR_OVERRIDE_LEVEL
        ) {
          inActor.Level = this.internalLoadObject(bunch.Archive, false);
        }
        inActor.Location = this.conditionallySerializeQuantizedVector(
          bunch.Archive,
          new FVector(0, 0, 0),
        );
        if (bunch.Archive.readBit()) {
          inActor.Rotation = bunch.Archive.readRotationShort();
        } else {
          inActor.Rotation = new FRotator(0, 0, 0);
        }
        inActor.Scale = this.conditionallySerializeQuantizedVector(
          bunch.Archive,
          new FVector(1, 1, 1),
        );
        inActor.Velocity = this.conditionallySerializeQuantizedVector(
          bunch.Archive,
          new FVector(0, 0, 0),
        );
      }

      channel.Actor = inActor;
      this.onChannelOpened(channel.ChannelIndex, inActor.ActorNetGUID);

      const path = this.netGuidCache.tryGetPathName(channel.ArchetypeId ?? 0);
      if (path && this.netFieldParser.PlayerControllerGroups.has(path)) {
        bunch.Archive.readByte(); // netPlayerIndex
      }
    }

    while (!bunch.Archive.atEnd()) {
      const block = this.readContentBlockPayload(bunch);
      if (block.payload == null) continue;

      bunch.Archive.setTempEnd(
        block.payload,
        FBitArchiveEndIndex.CONTENT_BLOCK_PAYLOAD,
      );
      try {
        if (block.bObjectDeleted) continue;
        if (bunch.Archive.IsError) break;
        if (block.repObject == null || bunch.Archive.atEnd()) continue;
        if (
          !this.receivedReplicatorBunch(
            bunch,
            bunch.Archive,
            block.repObject,
            block.bHasRepLayout,
          )
        ) {
          continue;
        }
      } finally {
        bunch.Archive.restoreTempEnd(FBitArchiveEndIndex.CONTENT_BLOCK_PAYLOAD);
      }
    }
  }

  receivedReplicatorBunch(
    bunch: DataBunch,
    archive: BitReader,
    repObject: number | undefined,
    bHasRepLayout: boolean,
  ): boolean {
    const netFieldExportGroup =
      this.netGuidCache.getNetFieldExportGroupByGuid(repObject);
    if (netFieldExportGroup == null) return true;

    if (bHasRepLayout) {
      if (!this.receiveProperties(archive, netFieldExportGroup, bunch.ChIndex).ok) {
        return false;
      }
      this.receiveExternalData(netFieldExportGroup, bunch.ChIndex);
    }

    if (archive.atEnd()) return true;

    const classNetCache = this.netGuidCache.tryGetClassNetCache(
      netFieldExportGroup.PathName,
      bunch.Archive.EngineNetworkVersion >=
        EngineNetworkVersionHistory.HISTORY_CLASSNETCACHE_FULLNAME,
    );
    if (classNetCache == null) return false;

    for (;;) {
      const fh = this.readFieldHeaderAndPayload(archive, classNetCache);
      if (!fh.more) break;
      if (fh.payload == null) continue;

      archive.setTempEnd(fh.payload, FBitArchiveEndIndex.FIELD_HEADER_PAYLOAD);
      try {
        const fieldCache = fh.outField;
        if (fieldCache == null) continue;
        if (fieldCache.Incompatible) continue;
        if (archive.IsError || archive.atEnd()) continue;
        if (!this.netFieldParser.willReadClassNetCache(classNetCache.PathName)) {
          continue;
        }

        const classNetProperty = this.netFieldParser.tryGetClassNetCacheProperty(
          fieldCache.Name,
          classNetCache.PathName,
        );
        if (classNetProperty) {
          if (classNetProperty.isFunction) {
            const functionGroup = this.netGuidCache.getNetFieldExportGroupByPath(
              classNetProperty.pathName,
            );
            if (!this.receivedRPC(archive, functionGroup, bunch.ChIndex)) {
              return false;
            }
          } else if (classNetProperty.isCustomStruct) {
            this.receiveCustomProperty(archive, classNetCache, fieldCache, bunch.ChIndex);
          } else {
            const group = this.netGuidCache.getNetFieldExportGroupByPath(
              classNetProperty.pathName,
            );
            if (group == null || !this.netFieldParser.willReadType(group.PathName)) {
              continue;
            }
            this.receiveCustomDeltaProperty(
              archive,
              group,
              bunch.ChIndex,
              classNetProperty.enablePropertyChecksum,
            );
          }
        }
      } finally {
        archive.restoreTempEnd(FBitArchiveEndIndex.FIELD_HEADER_PAYLOAD);
      }
    }
    return true;
  }

  receiveExternalData(group: NetFieldExportGroup, channelIndex: number): boolean {
    const channel = this.channels[channelIndex];
    if (channel == null) return false;
    if (channel.isIgnoringGroup(group.PathName)) return false;
    const externalData = this.netGuidCache.tryGetExternalData(
      channel.Actor?.ActorNetGUID?.Value,
    );
    if (externalData !== undefined) {
      this.onExternalDataRead(channelIndex, externalData);
    }
    return true;
  }

  receivedRPC(
    reader: BitReader,
    netFieldExportGroup: NetFieldExportGroup | null,
    channelIndex: number,
  ): boolean {
    if (netFieldExportGroup == null) return false;
    this.receiveProperties(reader, netFieldExportGroup, channelIndex);
    if (reader.IsError) return false;
    if (
      !this.channels[channelIndex]!.isIgnoringGroup(netFieldExportGroup.PathName) &&
      this.netFieldParser.willReadType(netFieldExportGroup.PathName) &&
      !reader.atEnd()
    ) {
      return false;
    }
    return true;
  }

  receiveCustomProperty(
    reader: BitReader,
    classNetCache: NetFieldExportGroup,
    fieldCache: NetFieldExport,
    channelIndex: number,
  ): boolean {
    const exportObj = this.netFieldParser.createPropertyType(
      classNetCache.PathName,
      fieldCache.Name,
    );
    if (exportObj != null) {
      const numBits = reader.getBitsLeft();
      this.cmdReader.fillBuffer(reader.readBits(numBits).slice(), numBits);
      exportObj.serialize(this.cmdReader);
      this.onExportRead(channelIndex, exportObj as object);
      return true;
    }
    return false;
  }

  receiveCustomDeltaProperty(
    reader: BitReader,
    group: NetFieldExportGroup,
    channelIndex: number,
    enablePropertyChecksum: boolean,
  ): boolean {
    if (
      reader.EngineNetworkVersion >=
      EngineNetworkVersionHistory.HISTORY_FAST_ARRAY_DELTA_STRUCT
    ) {
      reader.readBit(); // bSupportsFastArrayDeltaStructSerialization
    }
    return this.netDeltaSerialize(reader, group, channelIndex, enablePropertyChecksum);
  }

  netDeltaSerializeHeader(reader: BitReader): FFastArraySerializerHeader {
    return {
      ArrayReplicationKey: reader.readInt32(),
      BaseReplicationKey: reader.readInt32(),
      NumDeletes: reader.readInt32(),
      NumChanged: reader.readInt32(),
    };
  }

  netDeltaSerialize(
    reader: BitReader,
    group: NetFieldExportGroup,
    channelIndex: number,
    enablePropertyChecksum: boolean,
  ): boolean {
    const header = this.netDeltaSerializeHeader(reader);
    if (reader.IsError) return false;

    if (header.NumDeletes > 0) {
      for (let i = 0; i < header.NumDeletes; i++) {
        const elementIndex = reader.readInt32();
        this.deltaUpdate.Deleted = true;
        this.deltaUpdate.ElementIndex = elementIndex;
        this.deltaUpdate.Export = null;
        this.deltaUpdate.ChannelIndex = channelIndex;
        this.onNetDeltaRead(channelIndex, this.deltaUpdate);
      }
    }
    for (let i = 0; i < header.NumChanged; i++) {
      const elementIndex = reader.readInt32();
      const res = this.receiveProperties(
        reader,
        group,
        channelIndex,
        !enablePropertyChecksum,
        true,
      );
      this.deltaUpdate.Deleted = true;
      this.deltaUpdate.ElementIndex = elementIndex;
      this.deltaUpdate.Export = (res.exportGroup as INetFieldExportGroup) ?? null;
      this.deltaUpdate.ChannelIndex = channelIndex;
      this.onNetDeltaRead(channelIndex, this.deltaUpdate);
    }
    return true;
  }

  receiveProperties(
    archive: BitReader,
    group: NetFieldExportGroup,
    channelIndex: number,
    enablePropertyChecksum = true,
    netDeltaUpdate = false,
  ): { ok: boolean; exportGroup?: object } {
    const channel = this.channels[channelIndex];
    if (channel == null) return { ok: false };
    if (channel.isIgnoringGroup(group.PathName)) return { ok: false };
    if (!this.netFieldParser.willReadType(group.PathName)) {
      channel.ignoreGroup(group.PathName);
      return { ok: false };
    }

    if (enablePropertyChecksum) archive.readBit();

    const exportGroup = this.netFieldParser.createType(group.PathName);
    if (exportGroup == null) return { ok: false };

    let hasdata = false;
    for (;;) {
      let handle = archive.readIntPacked();
      if (handle === 0) break;
      handle--;

      if (!group.isValidIndex(handle)) return { ok: false };

      const exportField = group.NetFieldExports[handle];
      const numBits = archive.readIntPacked();
      if (numBits === 0) continue;
      if (exportField == null) {
        archive.skipBits(numBits);
        continue;
      }
      if (exportField.Incompatible) {
        archive.skipBits(numBits);
        continue;
      }

      hasdata = true;
      try {
        this.cmdReader.fillBuffer(archive.readBits(numBits).slice(), numBits);
        if (
          !this.netFieldParser.readField(
            exportGroup,
            exportField,
            handle,
            group,
            this.cmdReader,
          )
        ) {
          exportField.Incompatible = true;
        }
        if (this.cmdReader.IsError) {
          exportField.Incompatible = true;
          continue;
        }
        if (!this.cmdReader.atEnd()) {
          exportField.Incompatible = true;
          continue;
        }
      } catch {
        // swallow per-property errors
      }
    }

    if (!netDeltaUpdate && hasdata) {
      this.onExportRead(channelIndex, exportGroup);
    }
    return { ok: true, exportGroup };
  }

  readFieldHeaderAndPayload(
    archive: BitReader,
    group: NetFieldExportGroup,
  ): { more: boolean; outField: NetFieldExport | null; payload: number | null } {
    if (archive.atEnd()) return { more: false, outField: null, payload: null };

    const netFieldExportHandle = archive.readSerializedInt(
      Math.max(group.NetFieldExportsLength, 2),
    );
    if (archive.IsError) return { more: false, outField: null, payload: null };

    let outField = group.isValidIndex(netFieldExportHandle)
      ? group.NetFieldExports[netFieldExportHandle]
      : null;
    if (!outField) {
      outField = new NetFieldExport();
      outField.Handle = netFieldExportHandle;
      outField.Name = `Handle_${netFieldExportHandle}`;
    }

    const payload = archive.readIntPacked();
    if (archive.IsError) return { more: false, outField: null, payload: null };
    if (!archive.canRead(payload)) return { more: false, outField, payload: null };
    return { more: true, outField, payload };
  }

  readContentBlockPayload(bunch: DataBunch): {
    repObject: number | undefined;
    bObjectDeleted: boolean;
    bHasRepLayout: boolean;
    payload: number | null;
  } {
    const header = this.readContentBlockHeader(bunch);
    let payload: number | null = null;
    if (!header.bObjectDeleted) {
      payload = bunch.Archive.readIntPacked();
    }
    return {
      repObject: header.repObject,
      bObjectDeleted: header.bObjectDeleted,
      bHasRepLayout: header.bHasRepLayout,
      payload,
    };
  }

  readContentBlockHeader(bunch: DataBunch): {
    repObject: number | undefined;
    bHasRepLayout: boolean;
    bObjectDeleted: boolean;
  } {
    const bHasRepLayout = bunch.Archive.readBit();
    const bIsActor = bunch.Archive.readBit();
    if (bIsActor) {
      const channel = this.channels[bunch.ChIndex];
      return {
        repObject: channel?.ArchetypeId ?? channel?.ActorId,
        bHasRepLayout,
        bObjectDeleted: false,
      };
    }

    const netGuid = this.internalLoadObject(bunch.Archive, false);
    const bStablyNamed = bunch.Archive.readBit();
    if (bStablyNamed) {
      return { repObject: netGuid.Value, bHasRepLayout, bObjectDeleted: false };
    }

    let bDeleteSubObject = false;
    let bSerializeClass = true;
    if (
      bunch.Archive.EngineNetworkVersion >=
      EngineNetworkVersionHistory.HISTORY_SUBOBJECT_DESTROY_FLAG
    ) {
      const bIsDestroyMessage = bunch.Archive.readBit();
      if (bIsDestroyMessage) {
        bDeleteSubObject = true;
        bSerializeClass = false;
        bunch.Archive.readByte(); // destroyFlags
      }
    }

    let classNetGUID = new NetworkGUID();
    if (bSerializeClass) {
      classNetGUID = this.internalLoadObject(bunch.Archive, false);
      bDeleteSubObject = !classNetGUID.isValid();
    }
    if (bDeleteSubObject) {
      return { repObject: undefined, bHasRepLayout, bObjectDeleted: true };
    }

    if (
      bunch.Archive.EngineNetworkVersion >=
      EngineNetworkVersionHistory.HISTORY_SUBOBJECT_OUTER_CHAIN
    ) {
      const bActorIsOuter = bunch.Archive.atEnd() || bunch.Archive.readBit();
      if (!bActorIsOuter) this.internalLoadObject(bunch.Archive, false);
    }
    return { repObject: classNetGUID.Value, bHasRepLayout, bObjectDeleted: false };
  }
}

/** C# DateTime.FromBinary(ticks) — ticks are 100ns since 0001-01-01. */
function ticksToDate(ticks: bigint): Date {
  const TICKS_MASK = 0x3fffffffffffffffn; // strip Kind flags
  const t = ticks & TICKS_MASK;
  const EPOCH_TICKS = 621355968000000000n; // 1970-01-01 in .NET ticks
  const ms = (t - EPOCH_TICKS) / 10000n;
  return new Date(Number(ms));
}
