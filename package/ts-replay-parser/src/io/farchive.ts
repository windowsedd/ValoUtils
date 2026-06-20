/**
 * FArchive — abstract base for the Unreal replay readers.
 * Ported from Unreal.Core/FArchive.cs (state + abstract surface only).
 *
 * 64-bit integers (ReadInt64/ReadUInt64) are returned as `bigint` to preserve
 * precision; everything narrower uses `number`.
 */
import {
  EngineNetworkVersionHistory,
  type RotatorQuantization,
  type VectorQuantization,
} from "./enums.js";
import type {
  FQuat,
  FRotator,
  FTransform,
  FVector,
  NetworkReplayVersion,
} from "./models.js";

export enum SeekOrigin {
  Begin,
  Current,
  End,
}

export abstract class FArchive {
  EngineNetworkVersion: EngineNetworkVersionHistory =
    EngineNetworkVersionHistory.HISTORY_INITIAL;
  ReplayHeaderFlags = 0;
  NetworkVersion = 0;
  ReplayVersion = 0;
  NetworkReplayVersion?: NetworkReplayVersion;

  IsError = false;

  abstract get Position(): number;
  protected abstract set Position(value: number);

  setError(): void {
    this.IsError = true;
  }

  reset(): void {
    this.IsError = false;
    this.seek(0);
  }

  // ReplayHeaderFlags bit checks. HasStreamingFixes=1<<1, DeltaCheckpoints=1<<2,
  // GameSpecificFrameData=1<<3 (see ReplayHeaderFlags enum).
  hasLevelStreamingFixes(): boolean {
    return (this.ReplayHeaderFlags & (1 << 1)) !== 0;
  }
  hasGameSpecificFrameData(): boolean {
    return (this.ReplayHeaderFlags & (1 << 3)) !== 0;
  }
  hasDeltaCheckpoints(): boolean {
    return (this.ReplayHeaderFlags & (1 << 2)) !== 0;
  }

  abstract atEnd(): boolean;
  abstract canRead(count: number): boolean;

  abstract readArray<T>(read: () => T): T[];
  abstract readBytesToString(count: number): string;
  abstract readUInt16(): number;
  abstract readUInt32(): number;
  abstract readUInt64(): bigint;
  abstract readInt16(): number;
  abstract readInt32(): number;
  abstract readInt64(): bigint;
  abstract readSingle(): number;
  abstract readDouble(): number;
  abstract readFString(): string;
  abstract readFName(): string;
  abstract readFTransform(): FTransform;
  abstract readFQuat(): FQuat;
  abstract readFVector(): FVector;
  abstract readGUID(size?: number): string;
  abstract readIntPacked(): number;
  abstract readBoolean(): boolean;
  abstract readInt32AsBoolean(): boolean;
  abstract readUInt32AsBoolean(): boolean;
  abstract readByte(): number;
  abstract readSByte(): number;
  abstract readBytes(byteCount: number): Uint8Array;
  abstract skipBytes(byteCount: number): void;
  abstract seek(offset: number, origin?: SeekOrigin): void;
}

export type { VectorQuantization, RotatorQuantization };
