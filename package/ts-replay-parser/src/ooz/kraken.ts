/**
 * Kraken / Mermaid decompressor — TypeScript port of OozSharp/Kraken.cs.
 *
 * Original C# uses raw pointers; here every "pointer" is a {buf, off} cursor.
 * Cross-buffer copies (scratch -> destination, destination -> destination) are
 * explicit. Only the Mermaid path is implemented, matching upstream (the only
 * decoder Fortnite/Valorant replay chunks use).
 */
import {
  DecoderException,
  DecoderTypes,
  KrakenHeader,
  KrakenQuantumHeader,
  ptr,
  type MermaidLzTable,
  type Ptr,
} from "./types.js";

const SCRATCH_SIZE = 0x6c000;
// Byte size reserved for the MermaidLzTable struct in the C# scratch layout.
// The struct holds 11 pointers + 4 uint32 fields; on x64 that's 11*8 + 4*4 = 104,
// rounded to 112. We don't store the table in scratch (it's a JS object), but we
// must advance the scratch cursor by the same amount to match offsets.
const MERMAID_LZ_TABLE_SIZE = 112;

function copy64(dest: Ptr, src: Ptr): void {
  // Copy 8 bytes src -> dest (may be different buffers, may overlap if same).
  for (let i = 0; i < 8; i++) dest.buf[dest.off + i] = src.buf[src.off + i]!;
}

function alignUp(off: number, align: number): number {
  return (off + (align - 1)) & ~(align - 1);
}

interface DecoderState {
  sourceUsed: number;
  destinationUsed: number;
  header: KrakenHeader;
}

export class Kraken {
  private scratch = new Uint8Array(SCRATCH_SIZE);

  decompress(compressedInput: Uint8Array, uncompressedSize: number): Uint8Array {
    const decompressed = new Uint8Array(uncompressedSize);
    let remainingBytes = uncompressedSize;
    let sourceLength = compressedInput.length;
    let destinationOffset = 0;
    let sourceStart = 0;

    const state: DecoderState = {
      sourceUsed: 0,
      destinationUsed: 0,
      header: new KrakenHeader(compressedInput, 0),
    };

    while (remainingBytes !== 0) {
      if (
        !this.decodeStep(
          state,
          decompressed,
          destinationOffset,
          remainingBytes,
          compressedInput,
          sourceStart,
          sourceLength,
        )
      ) {
        throw new DecoderException("Failed DecodeStep method");
      }
      sourceStart += state.sourceUsed;
      sourceLength -= state.sourceUsed;
      destinationOffset += state.destinationUsed;
      remainingBytes -= state.destinationUsed;
    }
    return decompressed;
  }

  // PLACEHOLDER_DECODESTEP

  private decodeStep(
    state: DecoderState,
    destination: Uint8Array,
    destinationOffset: number,
    remainingDestinationBytes: number,
    sourceBuf: Uint8Array,
    sourceOff: number,
    sourceBytesLeft: number,
  ): boolean {
    const sourceIn = sourceOff;
    const sourceEnd = sourceOff + sourceBytesLeft;
    let source = sourceOff;

    if ((destinationOffset & 0x3ffff) === 0) {
      state.header = new KrakenHeader(sourceBuf, source);
      source += 2;
    }

    const isKrakenDecoder = state.header.DecoderType === DecoderTypes.Mermaid;
    const destinationBytesLeft = Math.min(
      isKrakenDecoder ? 0x40000 : 0x4000,
      remainingDestinationBytes,
    );

    if (state.header.Uncompressed) {
      if (sourceEnd - source < destinationBytesLeft) {
        throw new DecoderException(
          `DecodeStep: sourceEnd - source (${sourceEnd - source}) < destinationBytesLeft (${destinationBytesLeft})`,
        );
      }
      destination.set(
        sourceBuf.subarray(source, source + destinationBytesLeft),
        destinationOffset,
      );
      state.sourceUsed = source - sourceIn + destinationBytesLeft;
      state.destinationUsed = destinationBytesLeft;
      return true;
    }

    if (!isKrakenDecoder) {
      throw new DecoderException(
        `Decoder type ${state.header.DecoderType} not supported`,
      );
    }

    const quantumHeader = new KrakenQuantumHeader(
      sourceBuf,
      source,
      state.header.UseChecksums,
    );
    source += quantumHeader.bytesRead;

    if (source > sourceEnd) {
      throw new DecoderException("Index out of range of source array");
    }

    if (sourceEnd - source < quantumHeader.CompressedSize) {
      state.sourceUsed = 0;
      state.destinationUsed = 0;
      return true;
    }

    if (quantumHeader.CompressedSize > remainingDestinationBytes) {
      throw new DecoderException(
        `Invalid compression size CompressedSize > RemainingDestinationLength. ${quantumHeader.CompressedSize} > ${remainingDestinationBytes}`,
      );
    }

    if (quantumHeader.CompressedSize === 0) {
      if (quantumHeader.WholeMatchDistance !== 0) {
        throw new DecoderException("Kraken_CopyWholeMatch not implemented");
      }
      destination.fill(
        quantumHeader.Checksum & 0xff,
        destinationOffset,
        destinationOffset + destinationBytesLeft,
      );
      state.sourceUsed = source - sourceIn;
      state.destinationUsed = destinationBytesLeft;
      return true;
    }

    if (state.header.UseChecksums) {
      // GetCrc is NotImplemented upstream; checksums aren't used by the
      // replay fixtures (UseChecksums = false), so we skip verification.
      throw new DecoderException("Checksum verification not implemented");
    }

    if (quantumHeader.CompressedSize === destinationBytesLeft) {
      throw new DecoderException("memmove path not implemented");
    }

    let numBytes: number;
    switch (state.header.DecoderType) {
      case DecoderTypes.Mermaid:
        numBytes = this.mermaidDecodeQuantum(
          destination,
          destinationOffset,
          destinationOffset + destinationBytesLeft,
          0, // destinationStart (absolute base of output buffer)
          sourceBuf,
          source,
          source + quantumHeader.CompressedSize,
        );
        break;
      default:
        throw new DecoderException(
          `Decoder type ${state.header.DecoderType} currently not supported`,
        );
    }

    if (numBytes !== quantumHeader.CompressedSize) {
      throw new DecoderException(
        `Invalid number of bytes decompressed. ${numBytes} != ${quantumHeader.CompressedSize}`,
      );
    }

    state.sourceUsed = source - sourceIn + numBytes;
    state.destinationUsed = destinationBytesLeft;
    return true;
  }

  /**
   * Decode a byte stream. In the only supported mode (raw store, chunkType 0)
   * the decoded data lives inside the source buffer; we return a cursor to it
   * plus the number of source bytes consumed.
   */
  private decodeBytes(
    sourceBuf: Uint8Array,
    source: number,
    sourceEnd: number,
    outputSize: number,
  ): { output: Ptr; decodedSize: number; numBytes: number } {
    const sourceOrg = source;
    let sourceSize: number;
    if (sourceEnd - source < 2) {
      throw new DecoderException(
        `DecodeBytes: Too few bytes (${sourceEnd - source}) remaining`,
      );
    }
    const chunkType = (sourceBuf[source]! >> 4) & 0x7;
    if (chunkType === 0) {
      if (sourceBuf[source]! >= 0x80) {
        sourceSize = ((sourceBuf[source]! << 8) | sourceBuf[source + 1]!) & 0xfff;
        source += 2;
      } else {
        if (sourceEnd - source < 3) {
          throw new DecoderException(
            `DecodeBytes: Too few bytes (${sourceEnd - source}) remaining`,
          );
        }
        sourceSize =
          (sourceBuf[source]! << 16) |
          (sourceBuf[source + 1]! << 8) |
          sourceBuf[source + 2]!;
        if ((sourceSize & ~0x3ffff) > 0) {
          throw new DecoderException("Reserved bits must not be set");
        }
        source += 3;
      }
      if (sourceSize > outputSize || sourceEnd - source < sourceSize) {
        throw new DecoderException(
          `sourceSize (${sourceSize}) > outputSize (${outputSize}) || too few source bytes`,
        );
      }
      return {
        output: ptr(sourceBuf, source),
        decodedSize: sourceSize,
        numBytes: source + sourceSize - sourceOrg,
      };
    }
    throw new DecoderException("DecodeBytes: entropy-coded chunks not implemented");
  }

  private mermaidDecodeQuantum(
    dest: Uint8Array,
    destination: number,
    destinationEnd: number,
    destinationStart: number,
    sourceBuf: Uint8Array,
    source: number,
    sourceEnd: number,
  ): number {
    const sourceIn = source;
    let destinationCount: number;
    let sourceUsed = 0;
    const writtenBytes = 0;

    while (destinationEnd - destination !== 0) {
      destinationCount = destinationEnd - destination;
      destinationCount = destinationCount > 0x20000 ? 0x20000 : destinationCount;

      if (sourceEnd - source < 4) {
        throw new DecoderException(
          `Less than 4 bytes remaining in source. Remaining: ${sourceEnd - source}`,
        );
      }
      const chunkHeader =
        sourceBuf[source + 2]! |
        (sourceBuf[source + 1]! << 8) |
        (sourceBuf[source]! << 16);

      if (!((chunkHeader & 0x800000) > 0)) {
        throw new DecoderException(
          "Mermaid stored-without-match path not implemented",
        );
        void writtenBytes;
      } else {
        source += 3;
        sourceUsed = chunkHeader & 0x7ffff;
        const mode = (chunkHeader >> 19) & 0xf;

        if (sourceEnd - source < sourceUsed) {
          throw new DecoderException(
            `Not enough source bytes remaining. Have ${sourceEnd - source}. Need ${sourceUsed}`,
          );
        }

        if (sourceUsed < destinationCount) {
          let tempUsage = 2 * destinationCount + 32;
          tempUsage = tempUsage > 0x40000 ? 0x40000 : tempUsage;

          const lz = this.mermaidReadLzTable(
            mode,
            sourceBuf,
            source,
            source + sourceUsed,
            dest,
            destination,
            destinationCount,
            destination - destinationStart,
            MERMAID_LZ_TABLE_SIZE,
            tempUsage,
          );

          this.mermaidProcessLzRuns(
            mode,
            sourceBuf,
            source,
            source + sourceUsed,
            dest,
            destination,
            destinationCount,
            destination - destinationStart,
            destinationEnd,
            lz,
          );
        } else if (sourceUsed > destinationCount || mode !== 0) {
          throw new DecoderException(
            `Used bytes (${sourceUsed}) > destinationCount (${destinationCount}) or Mode (${mode}) != 0`,
          );
        } else {
          dest.set(
            sourceBuf.subarray(source, source + destinationCount),
            destination,
          );
        }
      }
      source += sourceUsed;
      destination += destinationCount;
    }
    return source - sourceIn;
  }

  // PLACEHOLDER_LZTABLE

  private mermaidReadLzTable(
    mode: number,
    sourceBuf: Uint8Array,
    source: number,
    sourceEnd: number,
    dest: Uint8Array,
    destination: number,
    destinationSize: number,
    offset: number,
    scratchStart: number,
    scratchEndOff: number,
  ): MermaidLzTable {
    const scratchBuf = this.scratch;
    let scratch = scratchStart;
    const scratchEnd = scratchEndOff;
    const sv = new DataView(
      sourceBuf.buffer,
      sourceBuf.byteOffset,
      sourceBuf.byteLength,
    );

    if (mode > 1) throw new DecoderException("MermaidReadLzTable: mode > 1");
    if (sourceEnd - source < 10)
      throw new DecoderException("MermaidReadLzTable: < 10 bytes");

    if (offset === 0) {
      copy64(ptr(dest, destination), ptr(sourceBuf, source));
      destination += 8;
      source += 8;
    }

    const lz = {} as MermaidLzTable;

    // Decode lit stream.
    let d = this.decodeBytes(
      sourceBuf,
      source,
      sourceEnd,
      Math.min(scratchEnd - scratch, destinationSize),
    );
    source += d.numBytes;
    lz.LitStream = { ...d.output };
    lz.LitStreamEnd = { ...d.output, off: d.output.off + d.decodedSize };
    scratch += d.decodedSize;

    // Decode flag (cmd) stream.
    d = this.decodeBytes(
      sourceBuf,
      source,
      sourceEnd,
      Math.min(scratchEnd - scratch, destinationSize),
    );
    source += d.numBytes;
    lz.CmdStream = { ...d.output };
    lz.CmdStreamEnd = { ...d.output, off: d.output.off + d.decodedSize };
    scratch += d.decodedSize;
    lz.CmdStream2OffsetsEnd = d.decodedSize;

    if (destinationSize <= 0x10000) {
      lz.CmdStream2Offsets = d.decodedSize;
    } else {
      if (sourceEnd - source < 2)
        throw new DecoderException("MermaidReadLzTable: < 2 bytes (cmd2)");
      lz.CmdStream2Offsets = sv.getUint16(source, true);
      source += 2;
      if (lz.CmdStream2Offsets > lz.CmdStream2OffsetsEnd) {
        throw new DecoderException(
          "MermaidReadLzTable: CmdStream2Offsets > CmdStream2OffsetsEnd",
        );
      }
    }

    if (sourceEnd - source < 2)
      throw new DecoderException("MermaidReadLzTable: < 2 bytes (off16)");
    const off16Count = sv.getUint16(source, true);

    if (off16Count === 0xffff) {
      source += 2;
      const hi = this.decodeBytes(
        sourceBuf,
        source,
        sourceEnd,
        Math.min(scratchEnd - scratch, destinationSize >> 1),
      );
      source += hi.numBytes;
      scratch += hi.decodedSize;
      const lo = this.decodeBytes(
        sourceBuf,
        source,
        sourceEnd,
        Math.min(scratchEnd - scratch, destinationSize >> 1),
      );
      source += lo.numBytes;
      scratch += lo.decodedSize;
      if (lo.decodedSize !== hi.decodedSize) {
        throw new DecoderException(
          "MermaidReadLzTable: offset16LowCount != offset16HighCount",
        );
      }
      scratch = alignUp(scratch, 2);
      const off16Start = scratch;
      if (scratch + lo.decodedSize * 2 > scratchEnd) {
        throw new DecoderException("MermaidReadLzTable: off16 overflow scratch");
      }
      scratch += lo.decodedSize * 2;
      // Combine low/high byte streams into ushort values in scratch.
      this.mermaidCombineOffset16(
        scratchBuf,
        off16Start,
        lo.decodedSize,
        lo.output,
        hi.output,
      );
      lz.Offset16Stream = ptr(scratchBuf, off16Start);
      lz.Offset16StreamEnd = ptr(scratchBuf, scratch);
    } else {
      lz.Offset16Stream = ptr(sourceBuf, source + 2);
      source += 2 + off16Count * 2;
      lz.Offset16StreamEnd = ptr(sourceBuf, source);
    }

    if (sourceEnd - source < 3)
      throw new DecoderException("MermaidReadLzTable: < 3 bytes (off32)");
    const temp =
      (sourceBuf[source]! |
        (sourceBuf[source + 1]! << 8) |
        (sourceBuf[source + 2]! << 16)) >>>
      0;
    source += 3;

    if (temp !== 0) {
      let offset32Size1 = temp >>> 12;
      let offset32Size2 = temp & 0xfff;
      if (offset32Size1 === 4095) {
        if (sourceEnd - source < 2)
          throw new DecoderException("MermaidReadLzTable: < 2 bytes (o32s1)");
        offset32Size1 = sv.getUint16(source, true);
        source += 2;
      }
      if (offset32Size2 === 4095) {
        if (sourceEnd - source < 2)
          throw new DecoderException("MermaidReadLzTable: < 2 bytes (o32s2)");
        offset32Size2 = sv.getUint16(source, true);
        source += 2;
      }
      lz.Offset32Stream1Size = offset32Size1;
      lz.Offset32Stream2Size = offset32Size2;
      if (scratch + 4 * (offset32Size1 + offset32Size2) + 64 > scratchEnd) {
        throw new DecoderException("MermaidReadLzTable: not enough scratch");
      }
      scratch = alignUp(scratch, 4);
      const o32s1 = scratch;
      scratch += offset32Size1 * 4;
      scratch += 32; // prefetch dummy
      const o32s2 = scratch;
      scratch += offset32Size2 * 4;
      scratch += 32; // prefetch dummy

      lz.Offset32Stream1 = ptr(scratchBuf, o32s1);
      lz.Offset32Stream2 = ptr(scratchBuf, o32s2);

      source += this.mermaidDecodeFarOffsets(
        sourceBuf,
        source,
        sourceEnd,
        scratchBuf,
        o32s1,
        offset32Size1,
        offset,
      );
      source += this.mermaidDecodeFarOffsets(
        sourceBuf,
        source,
        sourceEnd,
        scratchBuf,
        o32s2,
        offset32Size2,
        offset + 0x10000,
      );
    } else {
      if (scratchEnd - scratch < 32)
        throw new DecoderException("MermaidReadLzTable: < 32 scratch");
      lz.Offset32Stream1Size = 0;
      lz.Offset32Stream2Size = 0;
      lz.Offset32Stream1 = ptr(scratchBuf, scratch);
      lz.Offset32Stream2 = ptr(scratchBuf, scratch);
    }

    lz.LengthStream = ptr(sourceBuf, source);
    return lz;
  }

  // PLACEHOLDER_PROCESS

  private mermaidCombineOffset16(
    destBuf: Uint8Array,
    destOff: number,
    size: number,
    lo: Ptr,
    hi: Ptr,
  ): void {
    const dv = new DataView(destBuf.buffer, destBuf.byteOffset, destBuf.byteLength);
    for (let i = 0; i < size; i++) {
      const value = (lo.buf[lo.off + i]! + hi.buf[hi.off + i]! * 256) & 0xffff;
      dv.setUint16(destOff + i * 2, value, true);
    }
  }

  private mermaidDecodeFarOffsets(
    sourceBuf: Uint8Array,
    source: number,
    sourceEnd: number,
    outBuf: Uint8Array,
    outOff: number,
    outputSize: number,
    offset: number,
  ): number {
    const sourceCurrentStart = source;
    let sourceCurrent = source;
    const dv = new DataView(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength);

    if (offset < 0xc00000 - 1) {
      for (let i = 0; i < outputSize; i++) {
        if (sourceEnd - sourceCurrent < 3) {
          throw new DecoderException("MermaidDecodeFarOffsets: < 3 bytes");
        }
        const off =
          (sourceBuf[sourceCurrent]! |
            (sourceBuf[sourceCurrent + 1]! << 8) |
            (sourceBuf[sourceCurrent + 2]! << 16)) >>>
          0;
        sourceCurrent += 3;
        dv.setUint32(outOff + i * 4, off, true);
        if (off > offset) {
          throw new DecoderException(
            `MermaidDecodeFarOffsets: off (${off}) > offset (${offset})`,
          );
        }
      }
      return sourceCurrent - sourceCurrentStart;
    }

    for (let i = 0; i < outputSize; i++) {
      if (sourceEnd - sourceCurrent < 3) {
        throw new DecoderException("MermaidDecodeFarOffsets: < 3 bytes");
      }
      let off =
        (sourceBuf[sourceCurrent]! |
          (sourceBuf[sourceCurrent + 1]! << 8) |
          (sourceBuf[sourceCurrent + 2]! << 16)) >>>
        0;
      sourceCurrent += 3;
      if (off >= 0xc00000) {
        if (sourceCurrent === sourceEnd) {
          throw new DecoderException("MermaidDecodeFarOffsets: No remaining bytes");
        }
        off = (off + (sourceBuf[sourceCurrent]! << 22)) >>> 0;
        sourceCurrent++;
      }
      dv.setUint32(outOff + i * 4, off, true);
      if (off > offset) {
        throw new DecoderException(
          `MermaidDecodeFarOffsets: off (${off}) > offset (${offset})`,
        );
      }
    }
    return sourceCurrent - sourceCurrentStart;
  }

  // PLACEHOLDER_RUNS

  private mermaidProcessLzRuns(
    mode: number,
    sourceBuf: Uint8Array,
    _source: number,
    sourceEnd: number,
    dest: Uint8Array,
    destination: number,
    destinationSize: number,
    offset: number,
    destinationEnd: number,
    lz: MermaidLzTable,
  ): boolean {
    const destinationStart = destination - offset;
    const saved = { dist: -8 };
    let sourceCurrent: Ptr | null = null;

    for (let iteration = 0; iteration !== 2; iteration++) {
      let destinationSizeCurrent = destinationSize;
      destinationSizeCurrent =
        destinationSizeCurrent > 0x10000 ? 0x10000 : destinationSizeCurrent;

      if (iteration === 0) {
        lz.Offset32Stream = { ...lz.Offset32Stream1 };
        lz.Offset32StreamEnd = {
          ...lz.Offset32Stream1,
          off: lz.Offset32Stream1.off + lz.Offset32Stream1Size * 4 * 4,
        };
        lz.CmdStreamEnd = {
          ...lz.CmdStream,
          off: lz.CmdStream.off + lz.CmdStream2Offsets,
        };
      } else {
        lz.Offset32Stream = { ...lz.Offset32Stream2 };
        lz.Offset32StreamEnd = {
          ...lz.Offset32Stream2,
          off: lz.Offset32Stream2.off + lz.Offset32Stream2Size * 4 * 4,
        };
        lz.CmdStreamEnd = {
          ...lz.CmdStream,
          off: lz.CmdStream.off + lz.CmdStream2OffsetsEnd,
        };
        lz.CmdStream = {
          ...lz.CmdStream,
          off: lz.CmdStream.off + lz.CmdStream2Offsets,
        };
      }

      if (mode === 0) {
        throw new DecoderException(
          "MermaidProcessLzRuns: Mode 0 not implemented currently",
        );
      }
      sourceCurrent = this.mermaidMode1(
        dest,
        destination,
        destinationSizeCurrent,
        destinationStart,
        sourceBuf,
        sourceEnd,
        lz,
        saved,
        offset === 0 && iteration === 0 ? 8 : 0,
      );

      destination += destinationSizeCurrent;
      destinationSize -= destinationSizeCurrent;
      if (destinationSize === 0) break;
    }

    if (sourceCurrent === null || sourceCurrent.off !== sourceEnd) {
      throw new DecoderException(
        "MermaidProcessLzRuns: Failed to read decompress source bytes",
      );
    }
    return true;
  }

  // PLACEHOLDER_MODE1

  private mermaidMode1(
    dest: Uint8Array,
    destinationBegin: number,
    destinationSize: number,
    destinationStart: number,
    _sourceBuf: Uint8Array,
    sourceEnd: number,
    lz: MermaidLzTable,
    saved: { dist: number },
    startOff: number,
  ): Ptr {
    const destinationEnd = destinationBegin + destinationSize;
    let cmdStream = lz.CmdStream.off;
    const cmdStreamBuf = lz.CmdStream.buf;
    const cmdStreamEnd = lz.CmdStreamEnd.off;
    let lengthStream = lz.LengthStream.off;
    const lengthBuf = lz.LengthStream.buf;
    const lengthDv = new DataView(
      lengthBuf.buffer,
      lengthBuf.byteOffset,
      lengthBuf.byteLength,
    );
    let litStream = lz.LitStream.off;
    const litBuf = lz.LitStream.buf;
    const litStreamEnd = lz.LitStreamEnd.off;
    let off16Stream = lz.Offset16Stream.off;
    const off16Buf = lz.Offset16Stream.buf;
    const off16Dv = new DataView(
      off16Buf.buffer,
      off16Buf.byteOffset,
      off16Buf.byteLength,
    );
    const off16StreamEnd = lz.Offset16StreamEnd.off;
    let off32Stream = lz.Offset32Stream.off;
    const off32Buf = lz.Offset32Stream.buf;
    const off32Dv = new DataView(
      off32Buf.buffer,
      off32Buf.byteOffset,
      off32Buf.byteLength,
    );
    const off32StreamEnd = lz.Offset32StreamEnd.off;
    let recentOffs = saved.dist;
    let match: number;
    let length: number;

    let destination = destinationBegin + startOff;

    while (cmdStream < cmdStreamEnd) {
      const flag = cmdStreamBuf[cmdStream++]!;

      if (flag >= 24) {
        const newDist = off16Dv.getUint16(off16Stream, true);
        const useDistance = ((flag >> 7) - 1) >>> 0;
        const litLen = flag & 7;
        copy64(ptr(dest, destination), ptr(litBuf, litStream));
        destination += litLen;
        litStream += litLen;
        recentOffs ^= useDistance & (recentOffs ^ -newDist);
        off16Stream += useDistance & 2;
        match = destination + recentOffs;
        copy64(ptr(dest, destination), ptr(dest, match));
        copy64(ptr(dest, destination + 8), ptr(dest, match + 8));
        destination += (flag >> 3) & 0xf;
      } else if (flag > 2) {
        length = flag + 5;
        if (off32Stream === off32StreamEnd) {
          throw new DecoderException("MermaidMode1: off32Stream == off32StreamEnd");
        }
        match =
          destinationStart + destinationBegin - off32Dv.getUint32(off32Stream, true);
        off32Stream += 4;
        recentOffs = match - destination;
        if (destinationEnd - destination < length) {
          throw new DecoderException(
            "MermaidMode1: destinationEnd - destination < length",
          );
        }
        copy64(ptr(dest, destination), ptr(dest, match));
        copy64(ptr(dest, destination + 8), ptr(dest, match + 8));
        copy64(ptr(dest, destination + 16), ptr(dest, match + 16));
        copy64(ptr(dest, destination + 24), ptr(dest, match + 24));
        destination += length;
      } else if (flag === 0) {
        if (sourceEnd - lengthStream === 0) {
          throw new DecoderException("MermaidMode1: no length bytes (flag 0)");
        }
        length = lengthBuf[lengthStream]!;
        if (length > 251) {
          if (sourceEnd - lengthStream < 3) {
            throw new DecoderException("MermaidMode1: need 3 length bytes (flag 0)");
          }
          length += lengthDv.getUint16(lengthStream + 1, true) * 4;
          lengthStream += 2;
        }
        lengthStream += 1;
        length += 64;
        if (
          destinationEnd - destination < length ||
          litStreamEnd - litStream < length
        ) {
          throw new DecoderException("MermaidMode1: overflow (flag 0)");
        }
        do {
          copy64(ptr(dest, destination), ptr(litBuf, litStream));
          copy64(ptr(dest, destination + 8), ptr(litBuf, litStream + 8));
          destination += 16;
          litStream += 16;
          length -= 16;
        } while (length > 0);
        destination += length;
        litStream += length;
      } else if (flag === 1) {
        if (sourceEnd - lengthStream === 0) {
          throw new DecoderException("MermaidMode1: no length bytes (flag 1)");
        }
        length = lengthBuf[lengthStream]!;
        if (length > 251) {
          if (sourceEnd - lengthStream < 3) {
            throw new DecoderException("MermaidMode1: need 3 length bytes (flag 1)");
          }
          length += lengthDv.getUint16(lengthStream + 1, true) * 4;
          lengthStream += 2;
        }
        lengthStream += 1;
        length += 91;
        if (off16Stream === off16StreamEnd) {
          throw new DecoderException("MermaidMode1: off16Stream == off16StreamEnd");
        }
        match = destination - off16Dv.getUint16(off16Stream, true);
        off16Stream += 2;
        recentOffs = match - destination;
        do {
          copy64(ptr(dest, destination), ptr(dest, match));
          copy64(ptr(dest, destination + 8), ptr(dest, match + 8));
          destination += 16;
          match += 16;
          length -= 16;
        } while (length > 0);
        destination += length;
      } else {
        if (sourceEnd - lengthStream === 0) {
          throw new DecoderException("MermaidMode1: no length bytes (flag 2)");
        }
        length = lengthBuf[lengthStream]!;
        if (length > 251) {
          if (sourceEnd - lengthStream < 3) {
            throw new DecoderException("MermaidMode1: need 3 length bytes (flag 2)");
          }
          length += lengthDv.getUint16(lengthStream + 1, true) * 4;
          lengthStream += 2;
        }
        lengthStream += 1;
        length += 29;
        if (off32Stream === off32StreamEnd) {
          throw new DecoderException(
            "MermaidMode1: off32Stream == off32StreamEnd (flag 2)",
          );
        }
        match =
          destinationStart + destinationBegin - off32Dv.getUint32(off32Stream, true);
        off32Stream += 4;
        recentOffs = match - destination;
        do {
          copy64(ptr(dest, destination), ptr(dest, match));
          copy64(ptr(dest, destination + 8), ptr(dest, match + 8));
          destination += 16;
          match += 16;
          length -= 16;
        } while (length > 0);
        destination += length;
      }
    }

    // Trailing literals.
    length = destinationEnd - destination;
    if (length >= 8) {
      do {
        copy64(ptr(dest, destination), ptr(litBuf, litStream));
        destination += 8;
        litStream += 8;
        length -= 8;
      } while (length >= 8);
    }
    if (length > 0) {
      do {
        dest[destination++] = litBuf[litStream++]!;
      } while (--length > 0);
    }

    saved.dist = recentOffs;
    lz.LengthStream = ptr(lengthBuf, lengthStream);
    lz.Offset16Stream = ptr(off16Buf, off16Stream);
    lz.LitStream = ptr(litBuf, litStream);
    return ptr(lengthBuf, lengthStream);
  }
}
