/**
 * BinaryReader — byte-granular reader.
 * Ported from Unreal.Core/BinaryReader.cs.
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

export class BinaryReader extends FArchive {
  protected bytes: Uint8Array;
  protected view: DataView;
  private length: number;
  private _position = 0;

  override get Position(): number {
    return this._position;
  }
  protected override set Position(value: number) {
    this.seek(value);
  }

  constructor(input: Uint8Array) {
    super();
    this.bytes = input;
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    this.length = input.length;
  }

  override atEnd(): boolean {
    return this._position >= this.length;
  }

  // Matches C#: strict less-than.
  override canRead(count: number): boolean {
    return this._position + count < this.length;
  }

  override readArray<T>(read: () => T): T[] {
    const count = this.readUInt32();
    const arr: T[] = new Array(count);
    for (let i = 0; i < count; i++) arr[i] = read();
    return arr;
  }

  override readBoolean(): boolean {
    const result = this.bytes[this._position] !== 0;
    this._position++;
    return result;
  }

  override readByte(): number {
    const result = this.bytes[this._position]!;
    this._position++;
    return result;
  }

  override readBytes(byteCount: number): Uint8Array {
    const result = this.bytes.subarray(this._position, this._position + byteCount);
    this._position += byteCount;
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
    const isHardcoded = this.readBoolean();
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
    const t = new FTransform();
    t.Rotation = this.readFQuat();
    t.Translation = this.readFVector();
    t.Scale3D = this.readFVector();
    return t;
  }

  override readFQuat(): FQuat {
    const q = new FQuat();
    q.X = this.readSingle();
    q.Y = this.readSingle();
    q.Z = this.readSingle();
    q.W = this.readSingle();
    return q;
  }

  override readFVector(): FVector {
    return new FVector(this.readSingle(), this.readSingle(), this.readSingle());
  }

  override readGUID(size = 16): string {
    return this.readBytesToString(size);
  }

  override readInt16(): number {
    const result = this.view.getInt16(this._position, true);
    this._position += 2;
    return result;
  }

  override readInt32(): number {
    const result = this.view.getInt32(this._position, true);
    this._position += 4;
    return result;
  }

  override readInt32AsBoolean(): boolean {
    return this.readUInt32() >= 1;
  }

  override readInt64(): bigint {
    const result = this.view.getBigInt64(this._position, true);
    this._position += 8;
    return result;
  }

  override readIntPacked(): number {
    let value = 0;
    let count = 0;
    let remaining = true;
    while (remaining) {
      let nextByte = this.readByte();
      remaining = (nextByte & 1) === 1;
      nextByte >>= 1;
      value = (value + (nextByte << (7 * count++))) >>> 0;
    }
    return value >>> 0;
  }

  override readSByte(): number {
    const result = this.view.getInt8(this._position);
    this._position++;
    return result;
  }

  override readSingle(): number {
    const result = this.view.getFloat32(this._position, true);
    this._position += 4;
    return result;
  }

  override readDouble(): number {
    const result = this.view.getFloat64(this._position, true);
    this._position += 8;
    return result;
  }

  override readUInt16(): number {
    const result = this.view.getUint16(this._position, true);
    this._position += 2;
    return result;
  }

  override readUInt32(): number {
    const result = this.view.getUint32(this._position, true);
    this._position += 4;
    return result;
  }

  override readUInt32AsBoolean(): boolean {
    return this.readUInt32() >= 1;
  }

  override readUInt64(): bigint {
    const result = this.view.getBigUint64(this._position, true);
    this._position += 8;
    return result;
  }

  override seek(offset: number, origin: SeekOrigin = SeekOrigin.Begin): void {
    if (
      offset < 0 ||
      offset > this.length ||
      (origin === SeekOrigin.Current && offset + this._position > this.length)
    ) {
      this.IsError = true;
      return;
    }
    switch (origin) {
      case SeekOrigin.Begin:
        this._position = offset;
        break;
      case SeekOrigin.End:
        this._position = this.length - offset;
        break;
      case SeekOrigin.Current:
        this._position += offset;
        break;
    }
  }

  override skipBytes(byteCount: number): void {
    this._position += byteCount;
  }

  readFRotator(): FRotator {
    return new FRotator(this.readSingle(), this.readSingle(), this.readSingle());
  }
}
