//! FArchive — abstract base for the Unreal replay readers.
//! Ported from `package/ts-replay-parser/src/io/farchive.ts`
//! (itself ported from Unreal.Core/FArchive.cs — state + abstract surface only).
//!
//! Design choice: the TS version is an abstract class carrying shared mutable
//! state (`EngineNetworkVersion`, `ReplayHeaderFlags`, `IsError`, ...) plus
//! abstract read* methods implemented differently by `BinaryReader` (byte
//! granular) and `BitReader` (bit granular). Rust has no single concrete base
//! class to embed cleanly in both without either duplicating fields or boxing
//! trait objects, so this is ported as a trait (`FArchive`) with default
//! methods for the shared bit-flag helpers (`has_level_streaming_fixes`, etc.),
//! implemented against a handful of small required accessor methods. Both
//! `BinaryReader` and `BitReader` store the shared fields directly (mirroring
//! the TS instance fields) and implement the trait's accessors as thin
//! passthroughs.

use super::enums::EngineNetworkVersionHistory;
use super::models::NetworkReplayVersion;

/// Mirrors the TS `SeekOrigin` numeric enum (Begin=0, Current=1, End=2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SeekOrigin {
    Begin = 0,
    Current = 1,
    End = 2,
}

/// Shared archive state, mirroring the instance fields declared directly on
/// the TS `FArchive` abstract class. Embedded (not inherited) by both
/// concrete readers.
#[derive(Clone, Debug)]
#[allow(non_snake_case)]
pub struct ArchiveState {
    pub EngineNetworkVersion: EngineNetworkVersionHistory,
    pub ReplayHeaderFlags: u32,
    pub NetworkVersion: u32,
    pub ReplayVersion: u32,
    pub NetworkReplayVersion: Option<NetworkReplayVersion>,
    pub IsError: bool,
}

impl Default for ArchiveState {
    fn default() -> Self {
        ArchiveState {
            EngineNetworkVersion: EngineNetworkVersionHistory::HistoryInitial,
            ReplayHeaderFlags: 0,
            NetworkVersion: 0,
            ReplayVersion: 0,
            NetworkReplayVersion: None,
            IsError: false,
        }
    }
}

/// Trait mirroring the shared (non-abstract) behaviour on TS `FArchive`:
/// `setError`, `hasLevelStreamingFixes`, `hasGameSpecificFrameData`,
/// `hasDeltaCheckpoints`. The abstract read*/seek/atEnd/canRead surface is
/// intentionally NOT part of this trait — `BinaryReader` and `BitReader` each
/// implement their own inherent methods for those, matching the TS class
/// split (byte-aligned vs bit-granular access patterns) rather than unifying
/// behind one generic reader interface.
pub trait FArchive {
    fn archive_state(&self) -> &ArchiveState;
    fn archive_state_mut(&mut self) -> &mut ArchiveState;

    fn set_error(&mut self) {
        self.archive_state_mut().IsError = true;
    }

    fn is_error(&self) -> bool {
        self.archive_state().IsError
    }

    // ReplayHeaderFlags bit checks. HasStreamingFixes=1<<1, DeltaCheckpoints=1<<2,
    // GameSpecificFrameData=1<<3 (see ReplayHeaderFlags enum).
    fn has_level_streaming_fixes(&self) -> bool {
        (self.archive_state().ReplayHeaderFlags & (1 << 1)) != 0
    }
    fn has_game_specific_frame_data(&self) -> bool {
        (self.archive_state().ReplayHeaderFlags & (1 << 3)) != 0
    }
    fn has_delta_checkpoints(&self) -> bool {
        (self.archive_state().ReplayHeaderFlags & (1 << 2)) != 0
    }
}
