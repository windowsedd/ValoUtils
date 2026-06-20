/**
 * ValorantReplayReader — concrete reader for VALORANT .vrf replays.
 * Ported from ValorantReplayParser/ValorantReplayReader.cs.
 *
 * Overrides:
 *  - decompress: Oodle/Kraken via ../ooz
 *  - receivedReplicatorBunch: applies the seeded payload de-obfuscation
 *  - on* hooks: collect parsed exports
 *
 * Importing ./models populates the net field registry as a side effect.
 */
import { ReplayReader } from "../unreal/replay-reader.js";
import { Replay, DataBunch } from "../unreal/models.js";
import type { NetDeltaUpdate } from "../unreal/models.js";
import { ParseMode } from "../unreal/enums.js";
import { FArchive, SeekOrigin } from "../io/farchive.js";
import { BinaryReader } from "../io/binary-reader.js";
import { BitReader } from "../io/bit-reader.js";
import { NetBitReader } from "../io/net-bit-reader.js";
import { applyTransform } from "../transform/index.js";
import { decompressReplayData } from "../ooz/index.js";
import "./models.js";

export interface ExportRecord {
  channelIndex: number;
  type: string;
  fields: Record<string, unknown>;
}

export class ValorantReplay extends Replay {
  /** All export-group objects parsed during the replay, in order. */
  exports: ExportRecord[] = [];
}

export class ValorantReplayReader extends ReplayReader<ValorantReplay> {
  private version: string | null;

  /**
   * @param version Game version like "12.11". Pass `null` (or omit) to
   *   auto-detect from the replay header branch (`++Ares-Core+release-12.11`).
   */
  constructor(version: string | null = null, mode: ParseMode = ParseMode.Minimal) {
    super(mode);
    this.version = version;
  }

  protected override createReplay(): ValorantReplay {
    return new ValorantReplay();
  }

  /** Parse a replay from raw .vrf bytes. */
  readReplay(bytes: Uint8Array): ValorantReplay {
    const archive = new BinaryReader(bytes);
    return this.readReplayFromArchive(archive);
  }

  override readEvent(archive: FArchive): void {
    // VALORANT events are not decoded; just consume the header.
    archive.readFString();
    archive.readFString();
    archive.readFString();
    archive.readUInt32();
    archive.readUInt32();
    archive.readInt32();
  }

  override receivedReplicatorBunch(
    bunch: DataBunch,
    archive: BitReader,
    repObject: number | undefined,
    bHasRepLayout: boolean,
  ): boolean {
    const payloadBits = archive.getBitsLeft();
    if (payloadBits <= 0) {
      return super.receivedReplicatorBunch(bunch, archive, repObject, bHasRepLayout);
    }

    const rawPayload = this.copyPayload(archive, payloadBits);
    let seed = payloadBits >>> 0;
    const actorGuid = this.channels[bunch.ChIndex]?.ActorId;
    if (actorGuid !== undefined) seed = (seed ^ actorGuid) >>> 0;

    const transformedPayload = applyTransform(
      rawPayload,
      payloadBits,
      seed,
      this.resolveBranch(),
    );
    const transformedReader = this.createReader(transformedPayload, payloadBits, archive);
    const transformedBunch = new DataBunch(bunch);
    transformedBunch.Archive = transformedReader;

    return super.receivedReplicatorBunch(
      transformedBunch,
      transformedReader,
      repObject,
      bHasRepLayout,
    );
  }

  protected override onExportRead(
    channelIndex: number,
    exportGroup: object | null,
  ): void {
    if (exportGroup == null) return;
    const type = exportGroup.constructor?.name ?? "Object";
    if (type === "ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous") {
      return;
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(exportGroup)) {
      if (value !== undefined && value !== null) fields[key] = value;
    }
    this.replay.exports.push({ channelIndex, type, fields });
  }

  protected override onNetDeltaRead(_channelIndex: number, _update: NetDeltaUpdate): void {}

  protected override decompress(archive: FArchive): FArchive {
    if (!this.replay.Info.IsCompressed) return archive;
    const decompressedSize = archive.readInt32();
    const compressedSize = archive.readInt32();
    const output = decompressReplayData(
      archive.readBytes(compressedSize).slice(),
      decompressedSize,
    );
    const reader = new BinaryReader(output);
    reader.EngineNetworkVersion = this.replay.Header.EngineNetworkVersion;
    reader.NetworkVersion = this.replay.Header.NetworkVersion;
    reader.ReplayHeaderFlags = this.replay.Header.Flags;
    reader.ReplayVersion = this.replay.Info.FileVersion;
    return reader;
  }

  /**
   * Branch string fed to the payload transform. Uses the explicit version if
   * given, else the replay header's branch (which embeds `release-<x.y>`).
   */
  private resolveBranch(): string {
    if (this.version) return "release-" + this.version;
    return this.replay.Header.Branch || "release-12.10";
  }

  private createReader(
    payload: Uint8Array,
    payloadBits: number,
    archive: BitReader,
  ): NetBitReader {
    const reader = new NetBitReader(payload, payloadBits);
    reader.EngineNetworkVersion = archive.EngineNetworkVersion;
    reader.NetworkVersion = archive.NetworkVersion;
    reader.ReplayHeaderFlags = archive.ReplayHeaderFlags;
    reader.ReplayVersion = archive.ReplayVersion;
    reader.NetworkReplayVersion = archive.NetworkReplayVersion;
    return reader;
  }

  private copyPayload(archive: BitReader, payloadBits: number): Uint8Array {
    const start = archive.Position;
    const payload = archive.readBits(payloadBits).slice();
    archive.seek(start, SeekOrigin.Begin);
    return payload;
  }
}
