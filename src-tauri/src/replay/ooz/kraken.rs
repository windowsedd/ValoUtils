//! Kraken / Mermaid decompressor — Rust port of
//! `package/ts-replay-parser/src/ooz/kraken.ts` (itself a port of
//! OozSharp/Kraken.cs, which is itself a port of raw-pointer C).
//!
//! Cursor design: see the module doc comment in `types.rs` for the full
//! reasoning. Summary: every stream cursor is a plain `usize` byte offset;
//! the buffer it indexes into is threaded through explicitly as a function
//! parameter rather than embedded in a shared/aliased reference type.
//!
//! **Destination/source safety padding** (a deliberate, documented deviation
//! from a literal transliteration — see the long comment above
//! `SAFE_PAD` below for why this is necessary and why it changes no
//! observable behavior): Kraken's LZ-run decoder writes and reads in fixed
//! 8/16/32-byte chunks that can legitimately overshoot the precise
//! byte-accurate length by up to ~30 bytes (a documented property of this
//! exact algorithm family, not a bug) as long as there is buffer space to
//! absorb it. JS `Uint8Array` silently ignores out-of-bounds writes and
//! yields `0` for out-of-bounds reads, so the original TS port "gets away"
//! with allocating buffers at exactly their logical size. Rust slices panic
//! on out-of-bounds access, so this port allocates both the destination
//! output buffer and a working copy of the compressed input with trailing
//! zero padding, runs the identical logic/arithmetic (which is entirely
//! unaffected, since it only ever reasons about the *logical*, unpadded
//! sizes), and truncates the output back to the exact logical size before
//! returning. This was verified necessary by first porting without padding
//! and observing an out-of-bounds panic against the fixtures; see the final
//! report for details.

use super::types::{
    DResult, DecoderException, DecoderTypes, KrakenHeader, KrakenQuantumHeader, MermaidLzTable,
    StreamBuf,
};

const SCRATCH_SIZE: usize = 0x6c000;
// Byte size reserved for the MermaidLzTable struct in the C# scratch layout.
// The struct holds 11 pointers + 4 uint32 fields; on x64 that's 11*8 + 4*4 =
// 104, rounded to 112. We don't store the table in scratch (it's a Rust
// value living on the stack/heap separately), but we must advance the
// scratch cursor by the same amount to match offsets, exactly as the TS port
// does (see its identical comment).
const MERMAID_LZ_TABLE_SIZE: usize = 112;

/// Safety margin appended to the destination and (working copy of the)
/// source buffers so that Kraken's documented small overshoot writes/reads
/// (see module doc comment) never panic. Any value comfortably larger than
/// the worst single overshoot (~31 bytes, from the 4x8-byte copy in the
/// `flag > 2` branch of `mermaid_mode1`) is sufficient; 64 matches the
/// customary Oodle/Kraken "safe space" convention.
const SAFE_PAD: usize = 64;

fn align_up(off: usize, align: usize) -> usize {
    (off + (align - 1)) & !(align - 1)
}

fn read_u16_le(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([buf[off], buf[off + 1]])
}

fn read_u32_le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn write_u16_le(buf: &mut [u8], off: usize, v: u16) {
    buf[off..off + 2].copy_from_slice(&v.to_le_bytes());
}

fn write_u32_le(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

/// Copy 8 bytes within the SAME mutable buffer, byte-by-byte in ascending
/// index order. This intentionally does NOT use `copy_within` (which has
/// `memmove` semantics — correct regardless of overlap direction): the TS
/// `copy64` helper is a plain ascending-index loop, and Kraken's LZ decoding
/// relies on that exact behavior to reproduce run-length-style repeats when
/// the match distance is smaller than the copy width (e.g. distance 1 fills
/// the whole span with one repeated byte). Replacing this with a memmove
/// would silently produce different — wrong — output for those overlapping
/// cases while still "compiling and running fine", exactly the kind of
/// silent corruption this port must avoid.
#[inline]
fn copy8_same(buf: &mut [u8], to: usize, from: usize) {
    for i in 0..8 {
        buf[to + i] = buf[from + i];
    }
}

/// Copy 8 bytes from a different (read-only) buffer into the mutable
/// destination buffer. The two buffers never alias here, so a straight
/// slice copy is equivalent to the byte-by-byte TS loop.
#[inline]
fn copy8_cross(dst: &mut [u8], to: usize, src: &[u8], from: usize) {
    dst[to..to + 8].copy_from_slice(&src[from..from + 8]);
}

struct DecoderState {
    source_used: usize,
    destination_used: usize,
    header: KrakenHeader,
}

pub struct Kraken {
    scratch: Vec<u8>,
}

impl Default for Kraken {
    fn default() -> Self {
        Self::new()
    }
}

impl Kraken {
    pub fn new() -> Self {
        Kraken {
            scratch: vec![0u8; SCRATCH_SIZE],
        }
    }

    pub fn decompress(
        &mut self,
        compressed_input: &[u8],
        uncompressed_size: usize,
    ) -> DResult<Vec<u8>> {
        // See the module doc comment: pad both buffers so the algorithm's
        // documented small overshoot writes/reads can never panic. All size
        // bookkeeping below still uses the TRUE (unpadded) lengths — the
        // padding is invisible to the algorithm's own logic.
        let mut padded_source = compressed_input.to_vec();
        padded_source.resize(compressed_input.len() + SAFE_PAD, 0);

        let mut decompressed = vec![0u8; uncompressed_size + SAFE_PAD];

        let mut remaining_bytes = uncompressed_size;
        let mut source_length = compressed_input.len();
        let mut destination_offset = 0usize;
        let mut source_start = 0usize;

        let mut state = DecoderState {
            source_used: 0,
            destination_used: 0,
            header: KrakenHeader::new(&padded_source, 0)?,
        };

        while remaining_bytes != 0 {
            decode_step(
                &mut self.scratch,
                &mut state,
                &mut decompressed,
                destination_offset,
                remaining_bytes,
                &padded_source,
                source_start,
                source_length,
            )?;
            source_start += state.source_used;
            source_length -= state.source_used;
            destination_offset += state.destination_used;
            remaining_bytes -= state.destination_used;
        }

        decompressed.truncate(uncompressed_size);
        Ok(decompressed)
    }
}

#[allow(clippy::too_many_arguments)]
fn decode_step(
    scratch: &mut [u8],
    state: &mut DecoderState,
    destination: &mut [u8],
    destination_offset: usize,
    remaining_destination_bytes: usize,
    source_buf: &[u8],
    source_off: usize,
    source_bytes_left: usize,
) -> DResult<()> {
    let source_in = source_off;
    let source_end = source_off + source_bytes_left;
    let mut source = source_off;

    if (destination_offset & 0x3ffff) == 0 {
        state.header = KrakenHeader::new(source_buf, source)?;
        source += 2;
    }

    let is_mermaid = state.header.decoder_type == DecoderTypes::Mermaid;
    let destination_bytes_left = std::cmp::min(
        if is_mermaid { 0x40000 } else { 0x4000 },
        remaining_destination_bytes,
    );

    if state.header.uncompressed {
        if source_end - source < destination_bytes_left {
            return Err(DecoderException::new(format!(
                "DecodeStep: sourceEnd - source ({}) < destinationBytesLeft ({})",
                source_end - source,
                destination_bytes_left
            )));
        }
        destination[destination_offset..destination_offset + destination_bytes_left]
            .copy_from_slice(&source_buf[source..source + destination_bytes_left]);
        state.source_used = source - source_in + destination_bytes_left;
        state.destination_used = destination_bytes_left;
        return Ok(());
    }

    if !is_mermaid {
        return Err(DecoderException::new(format!(
            "Decoder type {} not supported",
            state.header.decoder_type
        )));
    }

    let quantum_header = KrakenQuantumHeader::new(source_buf, source, state.header.use_checksums)?;
    source += quantum_header.bytes_read;

    if source > source_end {
        return Err(DecoderException::new("Index out of range of source array"));
    }

    if source_end - source < quantum_header.compressed_size as usize {
        state.source_used = 0;
        state.destination_used = 0;
        return Ok(());
    }

    if quantum_header.compressed_size as usize > remaining_destination_bytes {
        return Err(DecoderException::new(format!(
            "Invalid compression size CompressedSize > RemainingDestinationLength. {} > {}",
            quantum_header.compressed_size, remaining_destination_bytes
        )));
    }

    if quantum_header.compressed_size == 0 {
        if quantum_header.whole_match_distance != 0 {
            return Err(DecoderException::new(
                "Kraken_CopyWholeMatch not implemented",
            ));
        }
        let fill = (quantum_header.checksum & 0xff) as u8;
        for b in
            destination[destination_offset..destination_offset + destination_bytes_left].iter_mut()
        {
            *b = fill;
        }
        state.source_used = source - source_in;
        state.destination_used = destination_bytes_left;
        return Ok(());
    }

    if state.header.use_checksums {
        return Err(DecoderException::new(
            "Checksum verification not implemented",
        ));
    }

    if quantum_header.compressed_size as usize == destination_bytes_left {
        return Err(DecoderException::new("memmove path not implemented"));
    }

    let num_bytes = match state.header.decoder_type {
        DecoderTypes::Mermaid => mermaid_decode_quantum(
            scratch,
            destination,
            destination_offset,
            destination_offset + destination_bytes_left,
            0,
            source_buf,
            source,
            source + quantum_header.compressed_size as usize,
        )?,
        other => {
            return Err(DecoderException::new(format!(
                "Decoder type {other} currently not supported"
            )));
        }
    };

    if num_bytes != quantum_header.compressed_size as usize {
        return Err(DecoderException::new(format!(
            "Invalid number of bytes decompressed. {} != {}",
            num_bytes, quantum_header.compressed_size
        )));
    }

    state.source_used = source - source_in + num_bytes;
    state.destination_used = destination_bytes_left;
    Ok(())
}

struct DecodeBytesResult {
    output_off: usize,
    decoded_size: usize,
    num_bytes: usize,
}

/// Decode a byte stream. In the only supported mode (raw store, chunkType 0)
/// the decoded data lives inside the source buffer; we return a cursor
/// (offset) into it plus the number of source bytes consumed. Matches TS
/// `decodeBytes` (entropy-coded chunk types are unimplemented upstream too).
fn decode_bytes(
    source_buf: &[u8],
    source: usize,
    source_end: usize,
    output_size: usize,
) -> DResult<DecodeBytesResult> {
    let source_org = source;
    let mut source = source;
    if source_end - source < 2 {
        return Err(DecoderException::new(format!(
            "DecodeBytes: Too few bytes ({}) remaining",
            source_end - source
        )));
    }
    let chunk_type = (source_buf[source] >> 4) & 0x7;
    if chunk_type == 0 {
        let source_size: usize;
        if source_buf[source] >= 0x80 {
            source_size =
                (((source_buf[source] as usize) << 8) | source_buf[source + 1] as usize) & 0xfff;
            source += 2;
        } else {
            if source_end - source < 3 {
                return Err(DecoderException::new(format!(
                    "DecodeBytes: Too few bytes ({}) remaining",
                    source_end - source
                )));
            }
            source_size = ((source_buf[source] as usize) << 16)
                | ((source_buf[source + 1] as usize) << 8)
                | (source_buf[source + 2] as usize);
            if (source_size as u32 & !0x3ffffu32) > 0 {
                return Err(DecoderException::new("Reserved bits must not be set"));
            }
            source += 3;
        }
        if source_size > output_size || source_end - source < source_size {
            return Err(DecoderException::new(format!(
                "sourceSize ({source_size}) > outputSize ({output_size}) || too few source bytes"
            )));
        }
        return Ok(DecodeBytesResult {
            output_off: source,
            decoded_size: source_size,
            num_bytes: source + source_size - source_org,
        });
    }
    Err(DecoderException::new(
        "DecodeBytes: entropy-coded chunks not implemented",
    ))
}

#[allow(clippy::too_many_arguments)]
fn mermaid_decode_quantum(
    scratch: &mut [u8],
    dest: &mut [u8],
    mut destination: usize,
    destination_end: usize,
    destination_start: usize,
    source_buf: &[u8],
    mut source: usize,
    source_end: usize,
) -> DResult<usize> {
    let source_in = source;

    while destination_end - destination != 0 {
        let mut destination_count = destination_end - destination;
        destination_count = if destination_count > 0x20000 {
            0x20000
        } else {
            destination_count
        };

        if source_end - source < 4 {
            return Err(DecoderException::new(format!(
                "Less than 4 bytes remaining in source. Remaining: {}",
                source_end - source
            )));
        }
        let chunk_header: u32 = (source_buf[source + 2] as u32)
            | ((source_buf[source + 1] as u32) << 8)
            | ((source_buf[source] as u32) << 16);

        if chunk_header & 0x800000 == 0 {
            return Err(DecoderException::new(
                "Mermaid stored-without-match path not implemented",
            ));
        }

        source += 3;
        let source_used = (chunk_header & 0x7ffff) as usize;
        let mode = (chunk_header >> 19) & 0xf;

        if source_end - source < source_used {
            return Err(DecoderException::new(format!(
                "Not enough source bytes remaining. Have {}. Need {}",
                source_end - source,
                source_used
            )));
        }

        if source_used < destination_count {
            let mut temp_usage = 2 * destination_count + 32;
            temp_usage = if temp_usage > 0x40000 {
                0x40000
            } else {
                temp_usage
            };

            let mut lz = mermaid_read_lz_table(
                mode,
                source_buf,
                source,
                source + source_used,
                dest,
                destination,
                destination_count,
                destination - destination_start,
                scratch,
                MERMAID_LZ_TABLE_SIZE,
                temp_usage,
            )?;

            mermaid_process_lz_runs(
                mode,
                source_buf,
                scratch,
                source + source_used,
                dest,
                destination,
                destination_count,
                destination - destination_start,
                &mut lz,
            )?;
        } else if source_used > destination_count || mode != 0 {
            return Err(DecoderException::new(format!(
                "Used bytes ({source_used}) > destinationCount ({destination_count}) or Mode ({mode}) != 0"
            )));
        } else {
            dest[destination..destination + destination_count]
                .copy_from_slice(&source_buf[source..source + destination_count]);
        }

        source += source_used;
        destination += destination_count;
    }
    Ok(source - source_in)
}

#[allow(clippy::too_many_arguments)]
fn mermaid_read_lz_table(
    mode: u32,
    source_buf: &[u8],
    mut source: usize,
    source_end: usize,
    dest: &mut [u8],
    mut destination: usize,
    destination_size: usize,
    offset: usize,
    scratch: &mut [u8],
    scratch_start: usize,
    scratch_end_off: usize,
) -> DResult<MermaidLzTable> {
    let mut scratch_cur = scratch_start;
    let scratch_end = scratch_end_off;

    if mode > 1 {
        return Err(DecoderException::new("MermaidReadLzTable: mode > 1"));
    }
    if source_end - source < 10 {
        return Err(DecoderException::new("MermaidReadLzTable: < 10 bytes"));
    }

    if offset == 0 {
        dest[destination..destination + 8].copy_from_slice(&source_buf[source..source + 8]);
        destination += 8;
        source += 8;
    }
    let _ = destination; // unused after this point, matching the TS source (dest write already applied)

    // Decode lit stream.
    let d = decode_bytes(
        source_buf,
        source,
        source_end,
        std::cmp::min(scratch_end - scratch_cur, destination_size),
    )?;
    source += d.num_bytes;
    let lit_stream = d.output_off;
    let lit_stream_end = d.output_off + d.decoded_size;
    scratch_cur += d.decoded_size;

    // Decode flag (cmd) stream.
    let d = decode_bytes(
        source_buf,
        source,
        source_end,
        std::cmp::min(scratch_end - scratch_cur, destination_size),
    )?;
    source += d.num_bytes;
    let cmd_stream = d.output_off;
    let cmd_stream_end = d.output_off + d.decoded_size;
    scratch_cur += d.decoded_size;
    let cmd_stream2_offsets_end = d.decoded_size;

    let cmd_stream2_offsets: usize;
    if destination_size <= 0x10000 {
        cmd_stream2_offsets = d.decoded_size;
    } else {
        if source_end - source < 2 {
            return Err(DecoderException::new(
                "MermaidReadLzTable: < 2 bytes (cmd2)",
            ));
        }
        cmd_stream2_offsets = read_u16_le(source_buf, source) as usize;
        source += 2;
        if cmd_stream2_offsets > cmd_stream2_offsets_end {
            return Err(DecoderException::new(
                "MermaidReadLzTable: CmdStream2Offsets > CmdStream2OffsetsEnd",
            ));
        }
    }

    if source_end - source < 2 {
        return Err(DecoderException::new(
            "MermaidReadLzTable: < 2 bytes (off16)",
        ));
    }
    let off16_count = read_u16_le(source_buf, source);

    let offset16_buf: StreamBuf;
    let offset16_stream: usize;
    let offset16_stream_end: usize;
    if off16_count == 0xffff {
        source += 2;
        let hi = decode_bytes(
            source_buf,
            source,
            source_end,
            std::cmp::min(scratch_end - scratch_cur, destination_size >> 1),
        )?;
        source += hi.num_bytes;
        scratch_cur += hi.decoded_size;
        let lo = decode_bytes(
            source_buf,
            source,
            source_end,
            std::cmp::min(scratch_end - scratch_cur, destination_size >> 1),
        )?;
        source += lo.num_bytes;
        scratch_cur += lo.decoded_size;
        if lo.decoded_size != hi.decoded_size {
            return Err(DecoderException::new(
                "MermaidReadLzTable: offset16LowCount != offset16HighCount",
            ));
        }
        scratch_cur = align_up(scratch_cur, 2);
        let off16_start = scratch_cur;
        if scratch_cur + lo.decoded_size * 2 > scratch_end {
            return Err(DecoderException::new(
                "MermaidReadLzTable: off16 overflow scratch",
            ));
        }
        scratch_cur += lo.decoded_size * 2;
        mermaid_combine_offset16(
            scratch,
            off16_start,
            lo.decoded_size,
            source_buf,
            lo.output_off,
            hi.output_off,
        );
        offset16_buf = StreamBuf::Scratch;
        offset16_stream = off16_start;
        offset16_stream_end = scratch_cur;
    } else {
        offset16_buf = StreamBuf::Source;
        offset16_stream = source + 2;
        source += 2 + (off16_count as usize) * 2;
        offset16_stream_end = source;
    }

    if source_end - source < 3 {
        return Err(DecoderException::new(
            "MermaidReadLzTable: < 3 bytes (off32)",
        ));
    }
    let temp: u32 = (source_buf[source] as u32)
        | ((source_buf[source + 1] as u32) << 8)
        | ((source_buf[source + 2] as u32) << 16);
    source += 3;

    let offset32_stream1: usize;
    let offset32_stream2: usize;
    let offset32_stream1_size: usize;
    let offset32_stream2_size: usize;

    if temp != 0 {
        let mut size1 = temp >> 12;
        let mut size2 = temp & 0xfff;
        if size1 == 4095 {
            if source_end - source < 2 {
                return Err(DecoderException::new(
                    "MermaidReadLzTable: < 2 bytes (o32s1)",
                ));
            }
            size1 = read_u16_le(source_buf, source) as u32;
            source += 2;
        }
        if size2 == 4095 {
            if source_end - source < 2 {
                return Err(DecoderException::new(
                    "MermaidReadLzTable: < 2 bytes (o32s2)",
                ));
            }
            size2 = read_u16_le(source_buf, source) as u32;
            source += 2;
        }
        let size1 = size1 as usize;
        let size2 = size2 as usize;
        offset32_stream1_size = size1;
        offset32_stream2_size = size2;
        if scratch_cur + 4 * (size1 + size2) + 64 > scratch_end {
            return Err(DecoderException::new(
                "MermaidReadLzTable: not enough scratch",
            ));
        }
        scratch_cur = align_up(scratch_cur, 4);
        let o32s1 = scratch_cur;
        scratch_cur += size1 * 4;
        scratch_cur += 32; // prefetch dummy (spacing only, matches TS layout)
        let o32s2 = scratch_cur;
        // Trailing spacing only (matches TS layout); scratch_cur's final
        // value here is intentionally unused past this point.
        #[allow(unused_assignments)]
        {
            scratch_cur += size2 * 4;
            scratch_cur += 32; // prefetch dummy
        }

        offset32_stream1 = o32s1;
        offset32_stream2 = o32s2;

        source += mermaid_decode_far_offsets(
            source_buf, source, source_end, scratch, o32s1, size1, offset,
        )?;
        source += mermaid_decode_far_offsets(
            source_buf,
            source,
            source_end,
            scratch,
            o32s2,
            size2,
            offset + 0x10000,
        )?;
    } else {
        if scratch_end - scratch_cur < 32 {
            return Err(DecoderException::new("MermaidReadLzTable: < 32 scratch"));
        }
        offset32_stream1_size = 0;
        offset32_stream2_size = 0;
        offset32_stream1 = scratch_cur;
        offset32_stream2 = scratch_cur;
    }

    let length_stream = source;

    Ok(MermaidLzTable {
        cmd_stream,
        cmd_stream_end,
        length_stream,
        lit_stream,
        lit_stream_end,
        offset16_buf,
        offset16_stream,
        offset16_stream_end,
        offset32_stream1,
        offset32_stream2,
        offset32_stream1_size,
        offset32_stream2_size,
        offset32_stream: offset32_stream1,
        offset32_stream_end: offset32_stream1,
        cmd_stream2_offsets,
        cmd_stream2_offsets_end,
    })
}

fn mermaid_combine_offset16(
    scratch: &mut [u8],
    dest_off: usize,
    size: usize,
    source_buf: &[u8],
    lo_off: usize,
    hi_off: usize,
) {
    for i in 0..size {
        let value =
            ((source_buf[lo_off + i] as u32) + (source_buf[hi_off + i] as u32) * 256) & 0xffff;
        write_u16_le(scratch, dest_off + i * 2, value as u16);
    }
}

#[allow(clippy::too_many_arguments)]
fn mermaid_decode_far_offsets(
    source_buf: &[u8],
    source: usize,
    source_end: usize,
    out_buf: &mut [u8],
    out_off: usize,
    output_size: usize,
    offset: usize,
) -> DResult<usize> {
    let source_current_start = source;
    let mut source_current = source;

    if offset < 0xc00000 - 1 {
        for i in 0..output_size {
            if source_end - source_current < 3 {
                return Err(DecoderException::new("MermaidDecodeFarOffsets: < 3 bytes"));
            }
            let off = (source_buf[source_current] as u32)
                | ((source_buf[source_current + 1] as u32) << 8)
                | ((source_buf[source_current + 2] as u32) << 16);
            source_current += 3;
            write_u32_le(out_buf, out_off + i * 4, off);
            if off as usize > offset {
                return Err(DecoderException::new(format!(
                    "MermaidDecodeFarOffsets: off ({off}) > offset ({offset})"
                )));
            }
        }
        return Ok(source_current - source_current_start);
    }

    for i in 0..output_size {
        if source_end - source_current < 3 {
            return Err(DecoderException::new("MermaidDecodeFarOffsets: < 3 bytes"));
        }
        let mut off = (source_buf[source_current] as u32)
            | ((source_buf[source_current + 1] as u32) << 8)
            | ((source_buf[source_current + 2] as u32) << 16);
        source_current += 3;
        if off >= 0xc00000 {
            if source_current == source_end {
                return Err(DecoderException::new(
                    "MermaidDecodeFarOffsets: No remaining bytes",
                ));
            }
            off = off.wrapping_add((source_buf[source_current] as u32) << 22);
            source_current += 1;
        }
        write_u32_le(out_buf, out_off + i * 4, off);
        if off as usize > offset {
            return Err(DecoderException::new(format!(
                "MermaidDecodeFarOffsets: off ({off}) > offset ({offset})"
            )));
        }
    }
    Ok(source_current - source_current_start)
}

#[allow(clippy::too_many_arguments)]
fn mermaid_process_lz_runs(
    mode: u32,
    source_buf: &[u8],
    scratch_buf: &[u8],
    source_end: usize,
    dest: &mut [u8],
    mut destination: usize,
    mut destination_size: usize,
    offset: usize,
    lz: &mut MermaidLzTable,
) -> DResult<()> {
    let destination_start: i64 = destination as i64 - offset as i64;
    let mut saved_dist: i64 = -8;
    let mut source_current: Option<usize> = None;

    for iteration in 0..2 {
        let mut destination_size_current = destination_size;
        if destination_size_current > 0x10000 {
            destination_size_current = 0x10000;
        }

        if iteration == 0 {
            lz.offset32_stream = lz.offset32_stream1;
            lz.offset32_stream_end = lz.offset32_stream1 + lz.offset32_stream1_size * 4 * 4;
            lz.cmd_stream_end = lz.cmd_stream + lz.cmd_stream2_offsets;
        } else {
            lz.offset32_stream = lz.offset32_stream2;
            lz.offset32_stream_end = lz.offset32_stream2 + lz.offset32_stream2_size * 4 * 4;
            lz.cmd_stream_end = lz.cmd_stream + lz.cmd_stream2_offsets_end;
            lz.cmd_stream += lz.cmd_stream2_offsets;
        }

        if mode == 0 {
            return Err(DecoderException::new(
                "MermaidProcessLzRuns: Mode 0 not implemented currently",
            ));
        }

        let start_off = if offset == 0 && iteration == 0 { 8 } else { 0 };
        let final_length_stream = mermaid_mode1(
            source_buf,
            scratch_buf,
            dest,
            destination,
            destination_size_current,
            destination_start,
            source_end,
            lz,
            &mut saved_dist,
            start_off,
        )?;
        source_current = Some(final_length_stream);

        destination += destination_size_current;
        destination_size -= destination_size_current;
        if destination_size == 0 {
            break;
        }
    }

    match source_current {
        Some(sc) if sc == source_end => Ok(()),
        _ => Err(DecoderException::new(
            "MermaidProcessLzRuns: Failed to read decompress source bytes",
        )),
    }
}

/// `source_buf` here plays the role of the TS `_sourceBuf`/`sourceBuf`
/// parameters used only to back the `Ptr`s embedded in the LZ table — see
/// the long comment in `types.rs` for why cmd/length/lit streams are always
/// source-backed while off16 can be either and off32 is always scratch.
#[allow(clippy::too_many_arguments)]
fn mermaid_mode1(
    source_buf: &[u8],
    scratch_buf: &[u8],
    dest: &mut [u8],
    destination_begin: usize,
    destination_size: usize,
    destination_start: i64,
    source_end: usize,
    lz: &mut MermaidLzTable,
    saved_dist: &mut i64,
    start_off: usize,
) -> DResult<usize> {
    // `dest` (the decompressed output) and `source_buf`/`scratch_buf` are
    // always distinct allocations in this crate (never the same `Vec`), so
    // borrowing `dest` mutably alongside the other two immutably is safe and
    // the borrow checker agrees without any unsafe code.
    let destination_end = destination_begin + destination_size;
    let mut cmd_stream = lz.cmd_stream;
    let cmd_stream_end = lz.cmd_stream_end;
    let mut length_stream = lz.length_stream;
    let mut lit_stream = lz.lit_stream;
    let lit_stream_end = lz.lit_stream_end;
    let mut off16_stream = lz.offset16_stream;
    let off16_stream_end = lz.offset16_stream_end;
    let off16_buf: &[u8] = match lz.offset16_buf {
        StreamBuf::Source => source_buf,
        StreamBuf::Scratch => scratch_buf,
    };
    let mut off32_stream = lz.offset32_stream;
    let off32_stream_end = lz.offset32_stream_end;

    let mut recent_offs: i64 = *saved_dist;
    let mut destination = destination_begin + start_off;

    while cmd_stream < cmd_stream_end {
        let flag = source_buf[cmd_stream];
        cmd_stream += 1;

        if flag >= 24 {
            let new_dist = read_u16_le(off16_buf, off16_stream) as i32;
            let use_distance: i32 = if (flag >> 7) == 0 { -1 } else { 0 };
            let lit_len = (flag & 7) as usize;

            copy8_cross(dest, destination, source_buf, lit_stream);
            destination += lit_len;
            lit_stream += lit_len;

            let recent_i32 = recent_offs as i32;
            let xor_val = recent_i32 ^ (-new_dist);
            recent_offs = (recent_i32 ^ (use_distance & xor_val)) as i64;

            off16_stream += (use_distance & 2) as usize;

            let match_pos = (destination as i64 + recent_offs) as usize;
            copy8_same(dest, destination, match_pos);
            copy8_same(dest, destination + 8, match_pos + 8);
            destination += ((flag >> 3) & 0xf) as usize;
        } else if flag > 2 {
            let length = (flag as usize) + 5;
            if off32_stream == off32_stream_end {
                return Err(DecoderException::new(
                    "MermaidMode1: off32Stream == off32StreamEnd",
                ));
            }
            let off32val = read_u32_le(scratch_buf, off32_stream) as i64;
            off32_stream += 4;
            let match_pos_signed = destination_start + destination_begin as i64 - off32val;
            recent_offs = match_pos_signed - destination as i64;
            if (destination_end - destination) < length {
                return Err(DecoderException::new(
                    "MermaidMode1: destinationEnd - destination < length",
                ));
            }
            let match_pos = match_pos_signed as usize;
            copy8_same(dest, destination, match_pos);
            copy8_same(dest, destination + 8, match_pos + 8);
            copy8_same(dest, destination + 16, match_pos + 16);
            copy8_same(dest, destination + 24, match_pos + 24);
            destination += length;
        } else if flag == 0 {
            if source_end - length_stream == 0 {
                return Err(DecoderException::new(
                    "MermaidMode1: no length bytes (flag 0)",
                ));
            }
            let mut length: i64 = source_buf[length_stream] as i64;
            if length > 251 {
                if source_end - length_stream < 3 {
                    return Err(DecoderException::new(
                        "MermaidMode1: need 3 length bytes (flag 0)",
                    ));
                }
                length += (read_u16_le(source_buf, length_stream + 1) as i64) * 4;
                length_stream += 2;
            }
            length_stream += 1;
            length += 64;
            if (destination_end - destination) < length as usize
                || (lit_stream_end - lit_stream) < length as usize
            {
                return Err(DecoderException::new("MermaidMode1: overflow (flag 0)"));
            }
            loop {
                copy8_cross(dest, destination, source_buf, lit_stream);
                copy8_cross(dest, destination + 8, source_buf, lit_stream + 8);
                destination += 16;
                lit_stream += 16;
                length -= 16;
                if length <= 0 {
                    break;
                }
            }
            destination = (destination as i64 + length) as usize;
            lit_stream = (lit_stream as i64 + length) as usize;
        } else if flag == 1 {
            if source_end - length_stream == 0 {
                return Err(DecoderException::new(
                    "MermaidMode1: no length bytes (flag 1)",
                ));
            }
            let mut length: i64 = source_buf[length_stream] as i64;
            if length > 251 {
                if source_end - length_stream < 3 {
                    return Err(DecoderException::new(
                        "MermaidMode1: need 3 length bytes (flag 1)",
                    ));
                }
                length += (read_u16_le(source_buf, length_stream + 1) as i64) * 4;
                length_stream += 2;
            }
            length_stream += 1;
            length += 91;
            if off16_stream == off16_stream_end {
                return Err(DecoderException::new(
                    "MermaidMode1: off16Stream == off16StreamEnd",
                ));
            }
            let off16val = read_u16_le(off16_buf, off16_stream) as i64;
            off16_stream += 2;
            let match_pos_signed = destination as i64 - off16val;
            recent_offs = match_pos_signed - destination as i64;
            let mut match_pos = match_pos_signed;
            loop {
                copy8_same(dest, destination, match_pos as usize);
                copy8_same(dest, destination + 8, (match_pos + 8) as usize);
                destination += 16;
                match_pos += 16;
                length -= 16;
                if length <= 0 {
                    break;
                }
            }
            destination = (destination as i64 + length) as usize;
        } else {
            if source_end - length_stream == 0 {
                return Err(DecoderException::new(
                    "MermaidMode1: no length bytes (flag 2)",
                ));
            }
            let mut length: i64 = source_buf[length_stream] as i64;
            if length > 251 {
                if source_end - length_stream < 3 {
                    return Err(DecoderException::new(
                        "MermaidMode1: need 3 length bytes (flag 2)",
                    ));
                }
                length += (read_u16_le(source_buf, length_stream + 1) as i64) * 4;
                length_stream += 2;
            }
            length_stream += 1;
            length += 29;
            if off32_stream == off32_stream_end {
                return Err(DecoderException::new(
                    "MermaidMode1: off32Stream == off32StreamEnd (flag 2)",
                ));
            }
            let off32val = read_u32_le(scratch_buf, off32_stream) as i64;
            off32_stream += 4;
            let match_pos_signed = destination_start + destination_begin as i64 - off32val;
            recent_offs = match_pos_signed - destination as i64;
            let mut match_pos = match_pos_signed;
            loop {
                copy8_same(dest, destination, match_pos as usize);
                copy8_same(dest, destination + 8, (match_pos + 8) as usize);
                destination += 16;
                match_pos += 16;
                length -= 16;
                if length <= 0 {
                    break;
                }
            }
            destination = (destination as i64 + length) as usize;
        }
    }

    // Trailing literals.
    let mut length = destination_end - destination;
    if length >= 8 {
        loop {
            copy8_cross(dest, destination, source_buf, lit_stream);
            destination += 8;
            lit_stream += 8;
            length -= 8;
            if length < 8 {
                break;
            }
        }
    }
    if length > 0 {
        loop {
            dest[destination] = source_buf[lit_stream];
            destination += 1;
            lit_stream += 1;
            length -= 1;
            if length == 0 {
                break;
            }
        }
    }

    *saved_dist = recent_offs;
    lz.length_stream = length_stream;
    lz.offset16_stream = off16_stream;
    lz.lit_stream = lit_stream;
    Ok(length_stream)
}

#[cfg(test)]
mod tests {
    //! Parity test ported from
    //! `package/ts-replay-parser/src/ooz/kraken.test.ts`: decompress each
    //! fixture and assert byte-exact (length + SHA-256) match against the
    //! reference values generated from the original C# OozSharp, committed
    //! in `__decompress_refs__.json`.

    use super::super::decompress_replay_data;
    use sha2::{Digest, Sha256};

    struct Ref {
        file: &'static str,
        size: usize,
        length: usize,
        sha256: &'static str,
    }

    // Mirrors __decompress_refs__.json (checked in the ts-replay-parser
    // package); kept inline here since parsing arbitrary JSON just for two
    // fixed reference rows would add nothing but indirection.
    const REFS: [Ref; 2] = [
        Ref {
            file: "mermaid-fortnite.dump",
            size: 405273,
            length: 405273,
            sha256: "F67174B6A5CB47FF79AA8920F80EF31CA351246E230026B5621A599AE3465E5E",
        },
        Ref {
            file: "mermaid-fortnite2.dump",
            size: 262151,
            length: 262151,
            sha256: "10F850FBB17F78A1C086932E7349A74E4C2EB00A7BACE2C8C0777F6A3C1D4AAD",
        },
    ];

    fn fixture(name: &str) -> Vec<u8> {
        let base = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../package/ts-replay-parser/test-fixtures/"
        );
        std::fs::read(format!("{base}{name}")).unwrap_or_else(|e| {
            panic!("failed to read fixture {name}: {e}");
        })
    }

    fn sha256_hex_upper(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let digest = hasher.finalize();
        digest.iter().map(|b| format!("{b:02X}")).collect()
    }

    #[test]
    fn decompresses_byte_for_byte() {
        for r in REFS.iter() {
            let compressed = fixture(r.file);
            let out = decompress_replay_data(&compressed, r.size)
                .unwrap_or_else(|e| panic!("{}: decompress failed: {e}", r.file));
            assert_eq!(out.len(), r.length, "{}: length mismatch", r.file);
            let hash = sha256_hex_upper(&out);
            assert_eq!(hash, r.sha256, "{}: sha256 mismatch", r.file);
        }
    }
}
