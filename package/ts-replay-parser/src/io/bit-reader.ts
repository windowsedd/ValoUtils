/**
 * BitReader — bit-granular reader (FBitArchive + BitReader merged).
 * Ported from Unreal.Core/BitReader.cs and FBitArchive.cs.
 */
import { FArchive, SeekOrigin } from "./farchive.js";
import { FQuat, FRotator, FTransform, FVector } from "./models.js";
import { EngineNetworkVersionHistory } from "./enums.js";
import { unrealName } from "./unreal-names.js";

const utf8 = new TextDecoder("utf-8");
const utf16le = new TextDecoder("utf-16le");

function trimNulls(s: string): string {
  return s.replace(/^[ \0]+|[ \0]+$/g, "");
}

export class BitReader extends FArchive {
  protected buffer: Uint8Array;
  private _position = 0;
  LastBit: number;
  MarkPosition = 0;
  private tempLastBit = new Map<number, number>();

  override get Position(): number {
    return this._position;
  }
  protected override set Position(value: number) {
    this._position = value;
  }

  private get currentByte(): number {
    return this._position >> 3;
  }

  constructor(input: Uint8Array, bitCount?: number) {
    super();
    this.buffer = input;
    this.LastBit = bitCount ?? input.length * 8;
  }

  fillBuffer(input: Uint8Array, bitCount?: number): void {
    this.buffer = input;
    this.LastBit = bitCount ?? input.length * 8;
    this._position = 0;
    this.IsError = false;
  }

  override atEnd(): boolean {
    return this._position >= this.LastBit;
  }

  override canRead(count: number): boolean {
    return this._position + count <= this.LastBit;
  }

  peekBit(): boolean {
    return (this.buffer[this.currentByte]! & (1 << (this._position & 7))) > 0;
  }

  readBit(): boolean {
    if (this.atEnd() || this.IsError) {
      this.IsError = true;
      return false;
    }
    const result =
      (this.buffer[this.currentByte]! & (1 << (this._position & 7))) > 0;
    this._position++;
    return result;
  }

  override readArray<T>(_read: () => T): T[] {
    throw new Error("ReadArray not implemented on BitReader");
  }

  readBitsToInt(bitCount: number): number {
    let result = 0;
    for (let i = 0; i < bitCount; i++) {
      if (this.IsError) return 0;
      if (this.readBit()) result |= 1 << i;
    }
    return result & 0xff;
  }

  readBitsToLong(bitCount: number): bigint {
    let result = 0n;
    for (let i = 0; i < bitCount; i++) {
      if (this.readBit()) result |= 1n << BigInt(i);
    }
    return result;
  }

  readBits(bitCount: number): Uint8Array {
    if (!this.canRead(bitCount) || bitCount < 0) {
      this.IsError = true;
      return new Uint8Array(0);
    }

    const bitCountUsedInByte = this._position & 7;
    let byteCount = Math.floor(bitCount / 8);
    const extraBits = bitCount % 8;
    if (bitCountUsedInByte === 0 && extraBits === 0) {
      const byteResult = this.buffer.subarray(
        this.currentByte,
        this.currentByte + byteCount,
      );
      this._position += bitCount;
      return byteResult;
    }

    const result = new Uint8Array(Math.floor((bitCount + 7) / 8));
    const bitCountLeftInByte = 8 - (this._position & 7);
    const currentByte = this.currentByte;
    const shiftDelta = (1 << bitCountUsedInByte) - 1;
    for (let i = 0; i < byteCount; i++) {
      result[i] =
        ((this.buffer[currentByte + i]! >> bitCountUsedInByte) |
          ((this.buffer[currentByte + i + 1]! & shiftDelta) <<
            bitCountLeftInByte)) &
        0xff;
    }
    this._position += byteCount * 8;

    let rem = bitCount % 8;
    for (let i = 0; i < rem; i++) {
      const bit =
        (this.buffer[this.currentByte]! & (1 << (this._position & 7))) > 0;
      this._position++;
      if (bit) result[result.length - 1]! |= 1 << i;
    }
    return result;
  }

  override readBoolean(): boolean {
    return this.readBit();
  }

  peekByte(): number {
    const result = this.readByte();
    this._position -= 8;
    return result;
  }

  override readByte(): number {
    const bitCountUsedInByte = this._position & 7;
    const bitCountLeftInByte = 8 - (this._position & 7);
    const result =
      bitCountUsedInByte === 0
        ? this.buffer[this.currentByte]!
        : ((this.buffer[this.currentByte]! >> bitCountUsedInByte) |
            ((this.buffer[this.currentByte + 1]! &
              ((1 << bitCountUsedInByte) - 1)) <<
              bitCountLeftInByte)) &
          0xff;
    this._position += 8;
    return result;
  }

  override readBytes(byteCount: number): Uint8Array {
    if (!this.canRead(byteCount * 8) || byteCount < 0) {
      this.IsError = true;
      return new Uint8Array(0);
    }
    const bitCountUsedInByte = this._position & 7;
    const bitCountLeftInByte = 8 - (this._position & 7);
    let result: Uint8Array;
    if (bitCountUsedInByte === 0) {
      result = this.buffer.slice(this.currentByte, this.currentByte + byteCount);
    } else {
      const output = new Uint8Array(byteCount);
      for (let i = 0; i < byteCount; i++) {
        output[i] =
          ((this.buffer[this.currentByte + i]! >> bitCountUsedInByte) |
            ((this.buffer[this.currentByte + 1 + i]! &
              ((1 << bitCountUsedInByte) - 1)) <<
              bitCountLeftInByte)) &
          0xff;
      }
      result = output;
    }
    this._position += byteCount * 8;
    return result;
  }

  override readBytesToString(count: number): string {
    return [...this.readBytes(count)]
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join("");
  }

  override readFString(): string {
    let length = this.readInt32();
    if (length === 0) return "";
    const isUnicode = length < 0;
    if (isUnicode) length = -2 * length;
    const raw = this.readBytes(length);
    const decoded = isUnicode ? utf16le.decode(raw) : utf8.decode(raw);
    return trimNulls(decoded);
  }

  override readFName(): string {
    const isHardcoded = this.readBit();
    if (isHardcoded) {
      const nameIndex =
        this.EngineNetworkVersion <
        EngineNetworkVersionHistory.HISTORY_CHANNEL_NAMES
          ? this.readUInt32()
          : this.readIntPacked();
      return unrealName(nameIndex);
    }
    const inString = this.readFString();
    this.readInt32(); // inNumber
    return inString;
  }

  override readFTransform(): FTransform {
    throw new Error("ReadFTransform not implemented on BitReader");
  }

  override readGUID(size = 16): string {
    return this.readBytesToString(size);
  }

  readSerializedInt(maxValue: number): number {
    let value = 0;
    for (let mask = 1; value + mask < maxValue; mask *= 2) {
      if (this.readBit()) value |= mask;
    }
    return value >>> 0;
  }

  override readInt16(): number {
    const value = this.readBytes(2);
    return this.IsError ? 0 : new DataView(value.buffer, value.byteOffset, 2).getInt16(0, true);
  }

  override readInt32(): number {
    const value = this.readBytes(4);
    return this.IsError ? 0 : new DataView(value.buffer, value.byteOffset, 4).getInt32(0, true);
  }

  override readInt32AsBoolean(): boolean {
    return this.readInt32() === 1;
  }

  override readInt64(): bigint {
    const value = this.readBytes(8);
    return this.IsError ? 0n : new DataView(value.buffer, value.byteOffset, 8).getBigInt64(0, true);
  }

  override readIntPacked(): number {
    const bitCountUsedInByte = this._position & 7;
    const bitCountLeftInByte = 8 - (this._position & 7);
    const srcMaskByte0 = ((1 << bitCountLeftInByte) - 1) & 0xff;
    const srcMaskByte1 = ((1 << bitCountUsedInByte) - 1) & 0xff;
    let srcIndex = this.currentByte;
    let nextSrcIndex = bitCountUsedInByte !== 0 ? srcIndex + 1 : srcIndex;

    let value = 0;
    for (let It = 0, shiftCount = 0; It < 5; ++It, shiftCount += 7) {
      if (!this.canRead(8)) {
        this.IsError = true;
        break;
      }
      if (nextSrcIndex >= this.buffer.length) {
        nextSrcIndex = srcIndex;
      }
      this._position += 8;
      const readByte =
        (((this.buffer[srcIndex]! >> bitCountUsedInByte) & srcMaskByte0) |
          ((this.buffer[nextSrcIndex]! & srcMaskByte1) <<
            (bitCountLeftInByte & 7))) &
        0xff;
      value = (((readByte >> 1) << shiftCount) | value) >>> 0;
      srcIndex++;
      nextSrcIndex++;
      if ((readByte & 1) === 0) break;
    }
    return value >>> 0;
  }

  override readFQuat(): FQuat {
    throw new Error("ReadFQuat not implemented on BitReader");
  }

  override readFVector(): FVector {
    if (
      this.EngineNetworkVersion >=
      EngineNetworkVersionHistory.HISTORY_PACKED_VECTOR_LWC_SUPPORT
    ) {
      return new FVector(this.readDouble(), this.readDouble(), this.readDouble());
    }
    return new FVector(this.readSingle(), this.readSingle(), this.readSingle());
  }

  readPackedVector(scaleFactor: number, maxBits: number): FVector {
    if (
      this.EngineNetworkVersion >=
        EngineNetworkVersionHistory.HISTORY_PACKED_VECTOR_LWC_SUPPORT &&
      this.EngineNetworkVersion !==
        EngineNetworkVersionHistory.HISTORY_21_AND_VIEWPITCH_ONLY_DO_NOT_USE
    ) {
      return this.readQuantizedVector(scaleFactor);
    }
    return this.readPackedVectorLegacy(scaleFactor, maxBits);
  }

  private readQuantizedVector(scaleFactor: number): FVector {
    const componentBitCountAndExtraInfo = this.readSerializedInt(1 << 7);
    const componentBitCount = componentBitCountAndExtraInfo & 63;
    const extraInfo = componentBitCountAndExtraInfo >>> 6;

    if (componentBitCount > 0) {
      const X = this.readBitsToLong(componentBitCount);
      const Y = this.readBitsToLong(componentBitCount);
      const Z = this.readBitsToLong(componentBitCount);
      const signBit = 1n << BigInt(componentBitCount - 1);
      let fX = Number(BigInt.asIntN(64, X ^ signBit) - signBit);
      let fY = Number(BigInt.asIntN(64, Y ^ signBit) - signBit);
      let fZ = Number(BigInt.asIntN(64, Z ^ signBit) - signBit);
      if (extraInfo > 0) {
        fX /= scaleFactor;
        fY /= scaleFactor;
        fZ /= scaleFactor;
      }
      const v = new FVector(fX, fY, fZ);
      v.Bits = componentBitCount;
      v.ScaleFactor = scaleFactor;
      return v;
    } else if (extraInfo === 0) {
      const v = new FVector(
        this.readSingle(),
        this.readSingle(),
        this.readSingle(),
      );
      v.Bits = 32;
      v.ScaleFactor = scaleFactor;
      return v;
    } else {
      const v = new FVector(
        this.readDouble(),
        this.readDouble(),
        this.readDouble(),
      );
      v.Bits = 64;
      v.ScaleFactor = scaleFactor;
      return v;
    }
  }

  private readPackedVectorLegacy(scaleFactor: number, maxBits: number): FVector {
    const bits = this.readSerializedInt(maxBits);
    if (this.IsError) return new FVector(0, 0, 0);
    const bias = 1 << (bits + 1);
    const max = 1 << (bits + 2);
    const dx = this.readSerializedInt(max);
    const dy = this.readSerializedInt(max);
    const dz = this.readSerializedInt(max);
    if (this.IsError) return new FVector(0, 0, 0);
    return new FVector(
      (dx - bias) / scaleFactor,
      (dy - bias) / scaleFactor,
      (dz - bias) / scaleFactor,
    );
  }

  readRotation(): FRotator {
    let pitch = 0;
    let yaw = 0;
    let roll = 0;
    if (this.readBit()) pitch = (this.readByte() * 360) / 256;
    if (this.readBit()) yaw = (this.readByte() * 360) / 256;
    if (this.readBit()) roll = (this.readByte() * 360) / 256;
    if (this.IsError) return new FRotator(0, 0, 0);
    return new FRotator(pitch, yaw, roll);
  }

  readRotationShort(): FRotator {
    let pitch = 0;
    let yaw = 0;
    let roll = 0;
    if (this.readBit()) pitch = (this.readUInt16() * 360) / 65536;
    if (this.readBit()) yaw = (this.readUInt16() * 360) / 65536;
    if (this.readBit()) roll = (this.readUInt16() * 360) / 65536;
    if (this.IsError) return new FRotator(0, 0, 0);
    return new FRotator(pitch, yaw, roll);
  }

  override readSByte(): number {
    throw new Error("ReadSByte not implemented on BitReader");
  }

  override readSingle(): number {
    const b = this.readBytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
  }

  override readDouble(): number {
    const b = this.readBytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
  }

  override readUInt16(): number {
    const b = this.readBytes(2);
    return new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true);
  }

  override readUInt32(): number {
    const b = this.readBytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }

  override readUInt32AsBoolean(): boolean {
    throw new Error("ReadUInt32AsBoolean not implemented on BitReader");
  }

  override readUInt64(): bigint {
    const b = this.readBytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }

  override seek(offset: number, origin: SeekOrigin = SeekOrigin.Begin): void {
    if (
      offset < 0 ||
      offset >> 3 > this.buffer.length ||
      (offset >> 3 === this.buffer.length && (offset & 7) > 0) ||
      (origin === SeekOrigin.Current &&
        offset + this._position > this.buffer.length * 8)
    ) {
      this.IsError = true;
      return;
    }
    switch (origin) {
      case SeekOrigin.Begin:
        this._position = offset;
        break;
      case SeekOrigin.End:
        this._position = this.buffer.length * 8 - offset;
        break;
      case SeekOrigin.Current:
        this._position += offset;
        break;
    }
  }

  override skipBytes(byteCount: number): void {
    this.seek(byteCount * 8, SeekOrigin.Current);
  }

  skipBits(numbits: number): void {
    this.seek(numbits, SeekOrigin.Current);
  }

  mark(): void {
    this.MarkPosition = this._position;
  }

  pop(): void {
    this._position = this.MarkPosition;
  }

  getBitsLeft(): number {
    return this.LastBit - this._position;
  }

  appendDataFromChecked(data: Uint8Array, bitCount: number): void {
    this.LastBit += bitCount;
    const combined = new Uint8Array(this.buffer.length + data.length);
    combined.set(this.buffer, 0);
    combined.set(data, this.buffer.length);
    this.buffer = combined;
  }

  setTempEnd(size: number, index: number): void {
    const setPosition = this._position + size;
    if (setPosition > this.LastBit) {
      this.IsError = true;
      return;
    }
    this.tempLastBit.set(index, this.LastBit);
    this.LastBit = setPosition;
  }

  restoreTempEnd(index: number): void {
    this._position = this.LastBit;
    this.LastBit = this.tempLastBit.get(index)!;
    this.IsError = false;
  }


}
