//! Oodle/Kraken (Mermaid) decompressor — port of
//! `package/ts-replay-parser/src/ooz/` (itself a port of OozSharp, ported
//! from raw C pointer code). Only the Mermaid path is implemented, matching
//! upstream (the only decoder Fortnite/Valorant replay chunks use).
//!
//! Layer dependency: `ooz` depends on nothing else in this crate (it sits at
//! the bottom alongside `io`/`transform`).

pub mod kraken;
pub mod types;

pub use kraken::Kraken;
pub use types::{DecoderException, DecoderTypes, KrakenHeader, KrakenQuantumHeader};

/// Ported from `package/ts-replay-parser/src/ooz/index.ts`
/// `decompressReplayData`.
pub fn decompress_replay_data(buffer: &[u8], uncompressed_size: usize) -> types::DResult<Vec<u8>> {
    let mut kraken = Kraken::new();
    kraken.decompress(buffer, uncompressed_size)
}
