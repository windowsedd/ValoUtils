/**
 * OozSharp types — DecoderTypes, Kraken/Mermaid headers, LZ table.
 * Ported from OozSharp/{DecoderTypes,KrakenHeader,KrakenQuantumHeader,MermaidLzTable}.cs.
 *
 * The original is `unsafe` C# with raw pointers. Here a "pointer" is a cursor
 * into one of the working buffers (compressed source, output, or scratch).
 */

export enum DecoderTypes {
  LZH = 1,
  LZHLW = 2,
  LZNIB = 3,
  None = 4,
  LZB16 = 5,
  LZBLW = 6,
  LZA = 7,
  LZNA = 8,
  Kraken = 9,
  Mermaid = 10,
  BitKnit = 11,
  Selkie = 12,
  Akkorokamui = 13,
}

export class DecoderException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoderException";
  }
}

/** A cursor into a buffer; mirrors a C# `byte*`. */
export interface Ptr {
  buf: Uint8Array;
  dv: DataView;
  off: number;
}

export function ptr(buf: Uint8Array, off = 0): Ptr {
  return { buf, dv: new DataView(buf.buffer, buf.byteOffset, buf.byteLength), off };
}

export class KrakenHeader {
  DecoderType: DecoderTypes = DecoderTypes.None;
  RestartDecoder = false;
  Uncompressed = false;
  UseChecksums = false;

  constructor(source: Uint8Array, sourceOff: number) {
    const firstByte = source[sourceOff]!;
    const secondByte = source[sourceOff + 1]!;
    if ((firstByte & 0xf) === 0xc) {
      if (((firstByte >> 4) & 3) !== 0) {
        throw new DecoderException(
          "Failed to decode header. ((source[0] >> 4) & 3) != 0",
        );
      }
      this.RestartDecoder = ((firstByte >> 7) & 0x1) === 0x01;
      this.Uncompressed = ((firstByte >> 6) & 0x1) === 0x01;
      this.DecoderType = (secondByte & 0x7f) as DecoderTypes;
      this.UseChecksums = ((secondByte >> 7) & 0x1) === 0x01;
    } else {
      throw new DecoderException("Failed to decode header. (source[0] & 0xF) != 0xC");
    }
  }
}

export class KrakenQuantumHeader {
  CompressedSize = 0;
  Checksum = 0;
  Flag1 = 0;
  Flag2 = 0;
  WholeMatchDistance = 0;
  bytesRead = 0;

  constructor(source: Uint8Array, sourceOff: number, useChecksums: boolean) {
    const v =
      ((source[sourceOff]! << 16) |
        (source[sourceOff + 1]! << 8) |
        source[sourceOff + 2]!) >>>
      0;
    const size = v & 0x3ffff;
    if (size !== 0x3ffff) {
      this.CompressedSize = size + 1;
      this.Flag1 = (v >> 18) & 1;
      this.Flag2 = (v >> 19) & 1;
      if (useChecksums) {
        this.Checksum =
          ((source[sourceOff + 3]! << 16) |
            (source[sourceOff + 4]! << 8) |
            source[sourceOff + 5]!) >>>
          0;
        this.bytesRead = 6;
      } else {
        this.bytesRead = 3;
      }
      return;
    }
    const v2 = v >>> 18;
    if (v2 === 1) {
      this.Checksum = source[sourceOff + 3]!;
      this.CompressedSize = 0;
      this.WholeMatchDistance = 0;
      this.bytesRead = 4;
      return;
    }
    throw new DecoderException("Failed to parse KrakenQuantumHeader");
  }
}

/** Working streams for Mermaid decoding. Each is a cursor into a buffer. */
export interface MermaidLzTable {
  CmdStream: Ptr;
  CmdStreamEnd: Ptr;
  LengthStream: Ptr;
  LitStream: Ptr;
  LitStreamEnd: Ptr;
  Offset16Stream: Ptr; // ushort*
  Offset16StreamEnd: Ptr;
  Offset32Stream: Ptr; // uint*
  Offset32StreamEnd: Ptr;
  Offset32Stream1: Ptr;
  Offset32Stream2: Ptr;
  Offset32Stream1Size: number;
  Offset32Stream2Size: number;
  CmdStream2Offsets: number;
  CmdStream2OffsetsEnd: number;
}
