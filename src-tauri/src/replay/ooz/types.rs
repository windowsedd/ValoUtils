//! OozSharp types — DecoderTypes, Kraken/Mermaid headers, LZ table.
//! Ported from `package/ts-replay-parser/src/ooz/types.ts`
//! (itself ported from OozSharp/{DecoderTypes,KrakenHeader,KrakenQuantumHeader,MermaidLzTable}.cs).
//!
//! The original C# is `unsafe` code with raw `byte*` pointers; the TS layer
//! models a "pointer" as a `{ buf, off }` cursor into one of the working
//! buffers (compressed source, output, or scratch). Reading through the TS
//! source confirms every `Ptr` cursor either:
//!   - Points into the *source* (compressed input) buffer — always read-only,
//!     produced once by `decodeBytes` and never re-aliased for writes.
//!   - Points into the *scratch* buffer — written once while building the LZ
//!     table (`mermaidReadLzTable`/`mermaidCombineOffset16`/
//!     `mermaidDecodeFarOffsets`), then only read from during
//!     `mermaidProcessLzRuns`/`mermaidMode1`. No two cursors alias the *same*
//!     live (concurrently written) scratch region across those two phases.
//!   - Points into the *destination* (output) buffer, which genuinely is
//!     self-aliased: LZ matches copy from an earlier offset in the same
//!     buffer to a later offset (classic LZ77), and can even overlap when the
//!     match distance is less than the copy width. That aliasing is real and
//!     load-bearing (`copy64` in kraken.rs relies on sequential byte-at-a-time
//!     semantics to reproduce overlap/RLE behavior) — it is NOT the kind of
//!     "two independent cursors into disjoint regions" case, so it can't be
//!     modeled as two ordinary Rust references; it's handled by taking the
//!     whole destination buffer as a single `&mut [u8]` and indexing into it
//!     directly (see kraken.rs `copy8_same`).
//!
//! Given that, this port does NOT introduce an `Rc<RefCell<..>>`-style shared
//! cursor type. Every cursor in kraken.rs is a plain `usize` offset, and the
//! *buffer* it indexes into is threaded through explicitly as a function
//! parameter (`&[u8]` for source, `&mut [u8]`/`&[u8]` for scratch depending on
//! phase, `&mut [u8]` for destination). This is simpler than the TS `Ptr` and
//! carries the same information — which buffer, what offset — without needing
//! a live reference embedded in a stored struct.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DecoderTypes {
    Lzh = 1,
    Lzhlw = 2,
    Lznib = 3,
    None = 4,
    Lzb16 = 5,
    Lzblw = 6,
    Lza = 7,
    Lzna = 8,
    Kraken = 9,
    Mermaid = 10,
    BitKnit = 11,
    Selkie = 12,
    Akkorokamui = 13,
    /// Any value not covered by the known set — the TS enum is a plain
    /// numeric enum, so an out-of-range byte just becomes an unlabeled
    /// number; we mirror that instead of erroring at parse time (the error
    /// surfaces later, at first use, exactly like the TS `switch`/`===`
    /// checks do).
    Unknown(u8),
}

impl DecoderTypes {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => DecoderTypes::Lzh,
            2 => DecoderTypes::Lzhlw,
            3 => DecoderTypes::Lznib,
            4 => DecoderTypes::None,
            5 => DecoderTypes::Lzb16,
            6 => DecoderTypes::Lzblw,
            7 => DecoderTypes::Lza,
            8 => DecoderTypes::Lzna,
            9 => DecoderTypes::Kraken,
            10 => DecoderTypes::Mermaid,
            11 => DecoderTypes::BitKnit,
            12 => DecoderTypes::Selkie,
            13 => DecoderTypes::Akkorokamui,
            other => DecoderTypes::Unknown(other),
        }
    }
}

impl fmt::Display for DecoderTypes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecoderTypes::Unknown(v) => write!(f, "{v}"),
            other => write!(f, "{:?}", other),
        }
    }
}

/// Mirrors the TS `DecoderException` (a custom `Error` subclass).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecoderException(pub String);

impl DecoderException {
    pub fn new(message: impl Into<String>) -> Self {
        DecoderException(message.into())
    }
}

impl fmt::Display for DecoderException {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DecoderException: {}", self.0)
    }
}

impl std::error::Error for DecoderException {}

pub type DResult<T> = Result<T, DecoderException>;

/// Ported from TS `KrakenHeader` constructor.
#[derive(Clone, Copy, Debug)]
pub struct KrakenHeader {
    pub decoder_type: DecoderTypes,
    pub restart_decoder: bool,
    pub uncompressed: bool,
    pub use_checksums: bool,
}

impl KrakenHeader {
    pub fn new(source: &[u8], source_off: usize) -> DResult<Self> {
        let first_byte = source[source_off];
        let second_byte = source[source_off + 1];
        if (first_byte & 0xf) == 0xc {
            if ((first_byte >> 4) & 3) != 0 {
                return Err(DecoderException::new(
                    "Failed to decode header. ((source[0] >> 4) & 3) != 0",
                ));
            }
            let restart_decoder = ((first_byte >> 7) & 0x1) == 0x01;
            let uncompressed = ((first_byte >> 6) & 0x1) == 0x01;
            let decoder_type = DecoderTypes::from_u8(second_byte & 0x7f);
            let use_checksums = ((second_byte >> 7) & 0x1) == 0x01;
            Ok(KrakenHeader {
                decoder_type,
                restart_decoder,
                uncompressed,
                use_checksums,
            })
        } else {
            Err(DecoderException::new(
                "Failed to decode header. (source[0] & 0xF) != 0xC",
            ))
        }
    }
}

/// Ported from TS `KrakenQuantumHeader` constructor.
#[derive(Clone, Copy, Debug, Default)]
pub struct KrakenQuantumHeader {
    pub compressed_size: u32,
    pub checksum: u32,
    pub flag1: u32,
    pub flag2: u32,
    pub whole_match_distance: u32,
    pub bytes_read: usize,
}

impl KrakenQuantumHeader {
    pub fn new(source: &[u8], source_off: usize, use_checksums: bool) -> DResult<Self> {
        let v: u32 = ((source[source_off] as u32) << 16)
            | ((source[source_off + 1] as u32) << 8)
            | (source[source_off + 2] as u32);
        let size = v & 0x3ffff;
        if size != 0x3ffff {
            let mut h = KrakenQuantumHeader {
                compressed_size: size + 1,
                flag1: (v >> 18) & 1,
                flag2: (v >> 19) & 1,
                ..Default::default()
            };
            if use_checksums {
                h.checksum = ((source[source_off + 3] as u32) << 16)
                    | ((source[source_off + 4] as u32) << 8)
                    | (source[source_off + 5] as u32);
                h.bytes_read = 6;
            } else {
                h.bytes_read = 3;
            }
            return Ok(h);
        }
        let v2 = v >> 18;
        if v2 == 1 {
            return Ok(KrakenQuantumHeader {
                checksum: source[source_off + 3] as u32,
                compressed_size: 0,
                whole_match_distance: 0,
                bytes_read: 4,
                ..Default::default()
            });
        }
        Err(DecoderException::new("Failed to parse KrakenQuantumHeader"))
    }
}

/// Which underlying buffer a stream cursor indexes into. `CmdStream`,
/// `LengthStream`, and `LitStream` are always backed by the source
/// (compressed input) buffer in this port — `decodeBytes` only ever
/// implements the "raw stored" chunk type (entropy-coded chunks throw
/// `DecoderException` upstream too), so its returned `Ptr` always points
/// into the source buffer, never scratch. `Offset16Stream` is the only
/// stream that can be backed by either buffer, depending on whether the
/// 16-bit offsets arrived pre-split (low/high byte streams combined into
/// scratch) or as a plain packed array directly in the source buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamBuf {
    Source,
    Scratch,
}

/// Working streams for Mermaid decoding — mirrors the TS `MermaidLzTable`
/// interface. Every cursor is a plain byte offset into whichever buffer
/// `StreamBuf`/context indicates; see the module doc comment for why this
/// crate doesn't need an `Rc<RefCell<..>>`-style aliased cursor type.
#[derive(Clone, Debug)]
pub struct MermaidLzTable {
    pub cmd_stream: usize,
    pub cmd_stream_end: usize,
    pub length_stream: usize,
    pub lit_stream: usize,
    pub lit_stream_end: usize,

    pub offset16_buf: StreamBuf,
    pub offset16_stream: usize,
    pub offset16_stream_end: usize,

    /// Offset32Stream1/2 are always written into scratch by
    /// `mermaidDecodeFarOffsets` (or left pointing at an empty run of
    /// scratch when `temp == 0`), so no buffer tag is needed for them.
    pub offset32_stream1: usize,
    pub offset32_stream2: usize,
    pub offset32_stream1_size: usize,
    pub offset32_stream2_size: usize,

    /// The "current" offset32 stream/end selected per-iteration in
    /// `mermaidProcessLzRuns` (mirrors `lz.Offset32Stream`/`Offset32StreamEnd`
    /// being reassigned each iteration in the TS).
    pub offset32_stream: usize,
    pub offset32_stream_end: usize,

    pub cmd_stream2_offsets: usize,
    pub cmd_stream2_offsets_end: usize,
}
