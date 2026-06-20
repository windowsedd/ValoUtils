/**
 * App-facing convenience parser.
 *
 * Produces the two record streams ValoUtils' replay pipeline consumes, so the
 * native `ValorantReplayParser.exe` can be replaced with this in-process parser:
 *
 *  - `exportRecords`  — one per replicated export group, shaped like the
 *    external parser's `Chindex=… Type=… Fields=[…]` lines (electron extract.ts).
 *  - `channelOpens`   — actor-channel open events with location + resolved
 *    class path, shaped like the external parser's `channels.jsonl` lines
 *    (electron abilities.ts).
 */
import { ValorantReplayReader, ValorantReplay } from "./replay-reader.js";
import { ParseMode } from "../unreal/enums.js";
import type { NetworkGUID } from "../unreal/models.js";
import type {
  ComponentDataStream,
  RemoteCharacterUpdate,
} from "./models.js";

export interface AppExportRecord {
  ch: number;
  type: string;
  fields: { Name: string; Value: unknown }[];
}

export interface AppChannelOpen {
  ev: "open";
  t: number;
  x: number;
  y: number;
  cls: string;
}

/** One decoded character-movement tick (the local player). */
export interface MovementSample {
  /** Character net GUID the move belongs to. */
  guid: number;
  /** Move timestamp (replay-relative). */
  t: number;
  x: number;
  y: number;
  z: number;
}

export interface AppParseResult {
  replay: ValorantReplay;
  exportRecords: AppExportRecord[];
  channelOpens: AppChannelOpen[];
  /** Flattened character-movement positions (requires ParseMode.Full). */
  movement: MovementSample[];
}

class AppReader extends ValorantReplayReader {
  readonly exportRecords: AppExportRecord[] = [];
  readonly channelOpens: AppChannelOpen[] = [];
  readonly movement: MovementSample[] = [];

  protected override onExportRead(channelIndex: number, exportGroup: object | null): void {
    super.onExportRead(channelIndex, exportGroup);
    if (exportGroup == null) return;
    const type = exportGroup.constructor?.name ?? "Object";

    // Movement comes through the RemoteCharacterUpdates RPC group. The base
    // reader skips it from `exports`, so collect samples here directly.
    if (type === "ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous") {
      const updates = (exportGroup as { RemoteCharacterUpdates?: RemoteCharacterUpdate[] })
        .RemoteCharacterUpdates;
      for (const u of updates ?? []) this.collectMovement(u);
      return;
    }

    const fields: { Name: string; Value: unknown }[] = [];
    for (const [Name, Value] of Object.entries(exportGroup)) {
      if (Value !== undefined && Value !== null) fields.push({ Name, Value });
    }
    this.exportRecords.push({ ch: channelIndex, type, fields });
  }

  private collectMovement(update: RemoteCharacterUpdate): void {
    const guid = update.ShooterCharacterNetGuidValue;
    const stream = update.ComponentDataStream as ComponentDataStream | undefined;
    if (guid === undefined || !stream?.Moves) return;
    for (const m of stream.Moves) {
      if (!m.Position) continue;
      this.movement.push({
        guid,
        t: m.Timestamp,
        x: m.Position.X,
        y: m.Position.Y,
        z: m.Position.Z,
      });
    }
  }

  protected override onChannelOpened(
    channelIndex: number,
    _actor: NetworkGUID | undefined,
  ): void {
    const channel = this.channels[channelIndex];
    const actor = channel?.Actor;
    if (!actor) return;
    const path =
      (channel.ArchetypeId !== undefined
        ? this.netGuidCache.tryGetPathName(channel.ArchetypeId)
        : undefined) ?? "";
    this.channelOpens.push({
      ev: "open",
      t: this.currentFrameTimeSeconds,
      x: actor.Location?.X ?? 0,
      y: actor.Location?.Y ?? 0,
      cls: path,
    });
  }
}

/** Parse a `.vrf` replay into the app's record streams. */
export function parseReplayForApp(
  bytes: Uint8Array,
  options: { version?: string | null; mode?: ParseMode } = {},
): AppParseResult {
  const reader = new AppReader(options.version ?? null, options.mode ?? ParseMode.Full);
  const replay = reader.readReplay(bytes);
  return {
    replay,
    exportRecords: reader.exportRecords,
    channelOpens: reader.channelOpens,
    movement: reader.movement,
  };
}
