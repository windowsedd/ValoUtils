//! ReplayReader — the central state machine implementing default UE replay
//! parsing. Ported from `package/ts-replay-parser/src/unreal/replay-reader.ts`
//! (itself ported from Unreal.Core/ReplayReader.cs).
//!
//! The C#/TS class is generic over the concrete `Replay` subtype and is
//! `abstract`, with a handful of overridable hooks (`decompress`,
//! `decryptBuffer`, `onExportRead`, `onChannelOpened`, ...) that the next
//! (valorant) phase's `ValorantReplayReader` overrides. See the
//! [`ReplayReaderHooks`] and [`ReplayLike`] trait docs below for how that
//! maps onto Rust, and the module-level "Structural judgment calls" doc
//! further down for everything that deviates from the phase brief's sketch.
//!
//! # Structural judgment calls (read this before extending in the next phase)
//!
//! 1. **`archive: FArchive` is, in every real call path, a concrete
//!    `BinaryReader`.** TS types the top-level read methods
//!    (`readReplayInfo`, `readReplayHeader`, `readReplayChunks`, `readEvent`,
//!    `readReplayData`, `readExportData`, `readNetExportGuids`,
//!    `readNetFieldExports`, `readDemoFrameIntoPlaybackPackets`,
//!    `readExternalData`, `readPacket`) as taking the abstract `FArchive`
//!    base, but every call site in `valorant/replay-reader.ts` constructs a
//!    `new BinaryReader(bytes)` and never a `BitReader` for these — confirmed
//!    by grep across the whole `ts-replay-parser` package. So these methods
//!    take `&mut BinaryReader` directly here, not a generic/trait-object
//!    `FArchive`.
//! 2. **The one genuine exception is `readNetFieldExport`**, which TS calls
//!    both from a `BinaryReader` context (`readNetFieldExports`) *and* a
//!    `BitReader` context (`receiveNetFieldExportsCompat`, which is itself
//!    only reachable via `receiveNetGUIDBunch` on a bunch's `BitReader`
//!    archive). Introducing a shared trait for this one call site felt like
//!    overkill, so it's ported as two near-identical private free functions
//!    (`read_net_field_export_binary` / `read_net_field_export_bit`) — a
//!    small, deliberate duplication instead of new trait machinery.
//! 3. **`decryptBuffer`/`decompress` hooks.** TS's default bodies live on
//!    `ReplayReader` itself and check `this.replay.Info.IsEncrypted`/
//!    `IsCompressed` before throwing — i.e. they're "abstract in practice,
//!    concrete in typing". Here, `ReplayReader::read_replay_data` itself
//!    checks those flags and only calls into the hook when actually needed;
//!    the hook's own default implementation just panics (mirrors the TS
//!    `throw new Error(...)` when a subclass hasn't overridden it and the
//!    flag is nonetheless set). When *not* encrypted/compressed,
//!    `read_replay_data` reads `length` bytes directly into a fresh owned
//!    `BinaryReader` itself rather than calling the hook at all — see that
//!    method's doc comment for why this is equivalent to TS's "same archive,
//!    keep reading" default given the chunk-boundary reseek that always
//!    follows in `read_replay_chunks`.
//! 4. **Generic over the concrete `Replay` type.** TS's `class ReplayReader<T
//!    extends Replay>` becomes `ReplayReader<R: ReplayLike, H:
//!    ReplayReaderHooks<R>>` here — [`ReplayLike`] is a small new trait (not
//!    in the phase brief's sketch) exposing `.info()`/`.header()` access
//!    generically, since the base `unreal` layer doesn't know about the
//!    valorant phase's extended `Replay` subtype fields. `replay` is stored
//!    as `Option<R>` (not `R` directly) because TS's `replay!: T` is
//!    definite-assignment-asserted (uninitialized until
//!    `readReplayFromArchive` runs) — Rust has no equivalent unsafe
//!    escape hatch we're willing to use here, so `Option` + an
//!    "must have been initialized" `expect()` in a couple of accessors is the
//!    direct, honest translation.
//! 5. **`onExportRead`'s value union.** TS's `onExportRead(_channelIndex, _exportGroup: INetFieldExportGroup | object | null)`
//!    is called with either a full registered model object (`receiveProperties`)
//!    or a raw custom-struct `IProperty` instance (`receiveCustomProperty`) —
//!    two unrelated Rust traits ([`crate::replay::unreal::models::NetFieldModel`] and
//!    [`crate::replay::unreal::models::Property`]). [`ExportedValue`] is a small enum
//!    added to carry either, faithfully preserving the union.
//! 6. **`setTempEnd`/`restoreTempEnd` RAII.** TS uses `try { ... } finally { archive.restoreTempEnd(idx); }`
//!    in several places, including inside loops with early `return`s
//!    (`processBunch`'s content-block loop, `receivedReplicatorBunch`'s field
//!    loop, `receivedPacket`'s per-bunch loop). Every one of those is ported
//!    with an explicit RAII guard ([`TempEndGuard`]) whose `Drop` impl calls
//!    `restore_temp_end`, so early `return`/`?`/loop `continue`/`break` can
//!    never skip the restore — this was flagged as a risk area in the phase
//!    brief and is the reason a guard type exists here instead of manual
//!    restore calls sprinkled at each exit point.

use crate::replay::io::binary_reader::BinaryReader;
use crate::replay::io::bit_reader::BitReader;
use crate::replay::io::enums::EngineNetworkVersionHistory;
use crate::replay::io::farchive::{FArchive, SeekOrigin};
use crate::replay::io::models::{FRotator, FVector};
use crate::replay::io::net_bit_reader::NetBitReader;

use super::enums::{
    ChannelCloseReason, ChannelName, ChannelType, FBitArchiveEndIndex, NetworkVersionHistory, PacketState, ParseMode,
    ReplayChunkType, ReplayVersionHistory,
};
use super::models::{
    Actor, DataBunch, ExternalData, FFastArraySerializerHeader, NetDeltaUpdate, NetFieldExport, NetFieldExportGroup,
    NetFieldModel, NetworkGUID, Property, ReplayHeader, ReplayInfo, UChannel,
};
use super::net_field_parser::NetFieldParser;
use super::net_guid_cache::NetGuidCache;
use super::registry::NetFieldRegistry;
use super::string_utils::remove_all_path_prefixes;

const DEFAULT_MAX_CHANNEL_SIZE: usize = 32767;
const FILE_MAGIC: u32 = 1140125661;
const NETWORK_MAGIC: u32 = 0x2cf5a13d;
const MAX_PACKET_SIZE_IN_BITS: u32 = 16384;
const OLD_MAX_ACTOR_CHANNELS: u32 = 10240;
const MAX_GUID_COUNT: u32 = 2048;

/// Generic access to the two fields every `Replay` subtype carries. See
/// judgment call #4 above.
pub trait ReplayLike {
    fn info(&self) -> &ReplayInfo;
    fn set_info(&mut self, info: ReplayInfo);
    fn set_header(&mut self, header: ReplayHeader);
    /// Added in the valorant phase: `ValorantReplayReader.resolveBranch()`
    /// falls back to `this.replay.Header.Branch` when no explicit version was
    /// given, so the payload-transform hook needs read access to it. The base
    /// `unreal` layer's `Replay` struct already stores `Header.Branch`; this
    /// just exposes it generically like `info()` does for `ReplayInfo`.
    fn header_branch(&self) -> &str;
}

impl ReplayLike for super::models::Replay {
    fn info(&self) -> &ReplayInfo {
        &self.Info
    }
    fn set_info(&mut self, info: ReplayInfo) {
        self.Info = info;
    }
    fn set_header(&mut self, header: ReplayHeader) {
        self.Header = header;
    }
    fn header_branch(&self) -> &str {
        &self.Header.Branch
    }
}

/// See judgment call #5 above.
pub enum ExportedValue<'a> {
    Model(&'a dyn NetFieldModel),
    Property(&'a dyn Property),
}

/// Overridable hooks — see judgment calls #3 and #5 above for the
/// `decrypt_buffer`/`decompress`/`on_export_read` design.
pub trait ReplayReaderHooks<R: ReplayLike> {
    /// Replaces the TS `protected abstract createReplay(): T`.
    fn create_replay(&mut self) -> R;

    /// Called only when `replay.Info.IsEncrypted`; default mirrors TS's
    /// "not implemented" throw.
    fn decrypt_buffer(&mut self, archive: &mut BinaryReader, size: u32) -> BinaryReader {
        let _ = (archive, size);
        panic!("Replay is marked as encrypted; decrypt_buffer not implemented");
    }
    /// Called only when `replay.Info.IsCompressed`; default mirrors TS's
    /// "not implemented" throw.
    fn decompress(&mut self, archive: BinaryReader) -> BinaryReader {
        let _ = archive;
        panic!("Replay is marked as compressed; decompress not implemented");
    }

    fn on_export_read(&mut self, _channel_index: u32, _export_group: Option<ExportedValue>) {}
    fn on_external_data_read(&mut self, _channel_index: u32, _data: Option<&ExternalData>) {}
    fn on_net_delta_read(&mut self, _channel_index: u32, _update: &NetDeltaUpdate) {}
    /// Extended (beyond the phase-brief sketch) with `actor_location` and
    /// `archetype_path`, plus the reader's `current_frame_time_seconds` —
    /// TS's `AppReader.onChannelOpened` override needs `this.channels[
    /// channelIndex].Actor.Location`, `this.netGuidCache.tryGetPathName(
    /// channel.ArchetypeId)`, and `this.currentFrameTimeSeconds`, none of
    /// which a bare `(channel_index, actor_guid)` hook call can reach from
    /// the hooks struct alone (unlike `on_export_read`, whose one parameter
    /// already carries everything needed). The base `ReplayReader::process_bunch`
    /// call site already computes all of this locally (channel actor +
    /// archetype-id -> path lookup), so it's threaded through here instead of
    /// requiring the hook to reach back into the reader.
    fn on_channel_opened(&mut self, _channel_index: u32, _actor: Option<&Actor>, _archetype_path: Option<&str>, _frame_time_seconds: f32) {}
    fn on_channel_closed(&mut self, _channel_index: u32, _actor: Option<NetworkGUID>) {}

    /// Added in the valorant phase, replacing the TS override point
    /// `ValorantReplayReader.receivedReplicatorBunch`. TS overrides that
    /// *entire* method (copy payload, transform, build a new reader, delegate
    /// to `super`); Rust's `received_replicator_bunch` below is a concrete
    /// (non-virtual) method on `ReplayReader`, so instead of duplicating its
    /// ~100 lines in the valorant layer, the transform is exposed as a
    /// narrow hook called once at the very top (before any group/property
    /// parsing), given the raw payload bits, the payload's bit length, and
    /// the owning actor's netguid (TS: `this.channels[bunch.ChIndex]?.ActorId`,
    /// used to fold into the transform seed). Default: identity (no
    /// transform), matching the base `ReplayReader`'s untransformed reads.
    fn transform_bunch_payload(&mut self, _actor_guid: Option<u32>, payload: Vec<u8>, _payload_bits: u32, _header_branch: &str) -> Vec<u8> {
        payload
    }
}

/// RAII guard for `BitReader::set_temp_end`/`restore_temp_end` — see
/// judgment call #6 above. Holds a raw pointer to the reader rather than a
/// borrow because several call sites need to keep using/reborrowing the same
/// reader for other purposes while the guard is alive (e.g. reading the
/// payload's contents) in ways that would otherwise fight the borrow checker
/// across early-return control flow; this is safe because the guard never
/// outlives the function scope that created it and the reader is never moved
/// while it's alive (mirrors the TS `try/finally`'s dynamic-scope guarantee).
struct TempEndGuard {
    reader: *mut BitReader,
    index: u32,
}

impl TempEndGuard {
    fn new(reader: &mut BitReader, size: usize, index: FBitArchiveEndIndex) -> Self {
        reader.set_temp_end(size, index as u32);
        TempEndGuard {
            reader: reader as *mut BitReader,
            index: index as u32,
        }
    }
}

impl Drop for TempEndGuard {
    fn drop(&mut self) {
        // SAFETY: see struct doc — the reader outlives this guard and is
        // never moved/aliased mutably elsewhere while the guard is alive.
        unsafe {
            (*self.reader).restore_temp_end(self.index);
        }
    }
}

pub struct ReplayReader<R: ReplayLike, H: ReplayReaderHooks<R>> {
    mode: ParseMode,
    replay: Option<R>,
    pub net_guid_cache: NetGuidCache,
    pub net_field_parser: NetFieldParser,
    pub registry: NetFieldRegistry,
    pub hooks: H,

    replay_data_index: u32,
    #[allow(dead_code)]
    checkpoint_index: u32,
    #[allow(dead_code)]
    packet_index: u32,
    bunch_index: u32,
    in_packet_id: u32,
    partial_bunch: Option<DataBunch>,
    in_reliable: u32,

    /// Time (seconds) of the demo frame currently being parsed.
    pub current_frame_time_seconds: f32,

    channels: Vec<Option<UChannel>>,
    #[allow(dead_code)]
    ignoring_channels: Vec<Option<u32>>,

    packet_reader: NetBitReader,
    cmd_reader: NetBitReader,
    delta_update: NetDeltaUpdate,
}

impl<R: ReplayLike, H: ReplayReaderHooks<R>> ReplayReader<R, H> {
    pub fn new(mode: ParseMode, hooks: H, registry: NetFieldRegistry) -> Self {
        ReplayReader {
            mode,
            replay: None,
            net_guid_cache: NetGuidCache::new(),
            net_field_parser: NetFieldParser::new(mode),
            registry,
            hooks,
            replay_data_index: 0,
            checkpoint_index: 0,
            packet_index: 0,
            bunch_index: 0,
            in_packet_id: 0,
            partial_bunch: None,
            in_reliable: 0,
            current_frame_time_seconds: 0.0,
            channels: (0..DEFAULT_MAX_CHANNEL_SIZE).map(|_| None).collect(),
            ignoring_channels: (0..DEFAULT_MAX_CHANNEL_SIZE).map(|_| None).collect(),
            packet_reader: NetBitReader::new(Vec::new(), None),
            cmd_reader: NetBitReader::new(Vec::new(), None),
            delta_update: NetDeltaUpdate::default(),
        }
    }

    pub fn replay(&self) -> &R {
        self.replay.as_ref().expect("replay not yet initialized — call read_replay_from_archive first")
    }

    // ---- top-level -----------------------------------------------------------

    pub fn read_replay_from_archive(&mut self, archive: &mut BinaryReader) -> &R {
        self.replay = Some(self.hooks.create_replay());
        self.read_replay_info(archive);
        self.read_replay_chunks(archive);
        self.cleanup();
        self.replay()
    }

    fn cleanup(&mut self) {
        self.in_reliable = 0;
        self.channels = (0..DEFAULT_MAX_CHANNEL_SIZE).map(|_| None).collect();
        self.ignoring_channels = (0..DEFAULT_MAX_CHANNEL_SIZE).map(|_| None).collect();
        self.replay_data_index = 0;
        self.checkpoint_index = 0;
        self.packet_index = 0;
        self.bunch_index = 0;
        self.in_packet_id = 0;
        self.partial_bunch = None;
        self.net_guid_cache.cleanup();
    }

    // ---- replay info / header ------------------------------------------------

    pub fn read_replay_info(&mut self, archive: &mut BinaryReader) {
        let magic_number = archive.read_uint32();
        if magic_number != FILE_MAGIC {
            panic!("Invalid replay file");
        }
        let file_version_raw = archive.read_uint32();
        archive.archive_state_mut().ReplayVersion = file_version_raw;

        if file_version_raw >= ReplayVersionHistory::HistoryCustomVersions as u32 {
            let custom_version_count = archive.read_int32();
            archive.skip_bytes((custom_version_count as usize) * 20);
        }

        let mut info = ReplayInfo::default();
        info.FileVersion = replay_version_from_u32(file_version_raw);
        info.LengthInMs = archive.read_uint32();
        info.NetworkVersion = archive.read_uint32();
        info.Changelist = archive.read_uint32();
        info.FriendlyName = archive.read_fstring();
        info.IsLive = archive.read_uint32_as_boolean();

        if file_version_raw >= ReplayVersionHistory::HistoryRecordedTimestamp as u32 {
            // C# DateTime.FromBinary; we keep the raw (mask-stripped, epoch-shifted) ticks-as-ms.
            let ticks = archive.read_int64();
            info.Timestamp = Some(ticks_to_epoch_ms(ticks));
        }
        if file_version_raw >= ReplayVersionHistory::HistoryCompression as u32 {
            info.IsCompressed = archive.read_uint32_as_boolean();
        }
        if file_version_raw >= ReplayVersionHistory::HistoryEncryption as u32 {
            info.IsEncrypted = archive.read_uint32_as_boolean();
            let size = archive.read_uint32();
            info.EncryptionKey = archive.read_bytes(size as usize);
        }

        if !info.IsLive && info.IsEncrypted && info.EncryptionKey.is_empty() {
            panic!("Completed replay is marked encrypted but has no key!");
        }
        if info.IsLive && info.IsEncrypted {
            panic!("Replay is marked encrypted but not yet marked as completed!");
        }
        self.replay_mut().set_info(info);
    }

    fn replay_mut(&mut self) -> &mut R {
        self.replay.as_mut().expect("replay not yet initialized — call read_replay_from_archive first")
    }

    pub fn read_replay_chunks(&mut self, archive: &mut BinaryReader) {
        while !archive.at_end() {
            let chunk_type_raw = archive.read_uint32();
            let chunk_type = ReplayChunkType::from_u32(chunk_type_raw);
            let chunk_size = archive.read_int32();
            let offset = archive.position();

            if chunk_size <= 0 {
                archive.set_error();
                return;
            }

            if chunk_type == ReplayChunkType::ReplayData && self.mode > ParseMode::EventsOnly {
                self.read_replay_data(archive, chunk_size);
            } else if chunk_type == ReplayChunkType::Checkpoint {
                // skipped: only needed for fast-forward
            } else if chunk_type == ReplayChunkType::Event {
                self.read_event(archive);
            } else if chunk_type == ReplayChunkType::Header {
                self.read_replay_header(archive);
            }

            if archive.position() != offset + chunk_size as usize {
                archive.seek((offset + chunk_size as usize) as i64, SeekOrigin::Begin);
            }
        }
    }

    /// Override to handle text events; default reads + ignores.
    pub fn read_event(&mut self, archive: &mut BinaryReader) {
        archive.read_fstring(); // id
        archive.read_fstring(); // group
        archive.read_fstring(); // metadata
        archive.read_uint32(); // start
        archive.read_uint32(); // end
        archive.read_int32(); // size
    }

    /// See judgment call #3 above for why the non-encrypted/non-compressed
    /// default path materializes an owned copy rather than truly aliasing
    /// the same archive.
    pub fn read_replay_data(&mut self, archive: &mut BinaryReader, fallback_chunk_size: i32) {
        let mut length = fallback_chunk_size;
        if (archive.archive_state().ReplayVersion & (ReplayVersionHistory::HistoryStreamChunkTimes as u32)) != 0 {
            archive.read_uint32(); // start
            archive.read_uint32(); // end
            length = archive.read_uint32() as i32;
        }
        if (archive.archive_state().ReplayVersion & (ReplayVersionHistory::HistoryEncryption as u32)) != 0 {
            archive.read_int32(); // memorySizeInBytes
        }

        let is_encrypted = self.replay().info().IsEncrypted;
        let is_compressed = self.replay().info().IsCompressed;

        let decrypted = if is_encrypted {
            self.hooks.decrypt_buffer(archive, length as u32)
        } else {
            BinaryReader::new(archive.read_bytes(length.max(0) as usize))
        };

        let mut binary_archive = if is_compressed { self.hooks.decompress(decrypted) } else { decrypted };
        // Bisected bug fix: a freshly-constructed `BinaryReader` (whether
        // from `decrypt_buffer`'s/`decompress`'s default `BinaryReader::new(...)`
        // or a concrete hook impl doing the same) starts with
        // `ArchiveState::default()`, not the encoding-relevant fields the
        // *original* `archive` already carries post-header-parse
        // (`EngineNetworkVersion`/`NetworkVersion`/`ReplayHeaderFlags`/
        // `ReplayVersion`). TS's per-concrete-reader `decompress` override
        // copies these explicitly from `this.replay.Header`/`Info`onto the
        // new reader; since this generic base method is exactly where every
        // concrete reader needs the same copy (not valorant-specific —
        // mirrors the existing copy pattern used elsewhere in this file for
        // `packet_reader`/`cmd_reader`), it's done once here instead of
        // pushing it onto every hook implementation.
        binary_archive.archive_state_mut().EngineNetworkVersion = archive.archive_state().EngineNetworkVersion;
        binary_archive.archive_state_mut().NetworkVersion = archive.archive_state().NetworkVersion;
        binary_archive.archive_state_mut().ReplayHeaderFlags = archive.archive_state().ReplayHeaderFlags;
        binary_archive.archive_state_mut().ReplayVersion = archive.archive_state().ReplayVersion;

        while !binary_archive.at_end() {
            self.read_demo_frame_into_playback_packets(&mut binary_archive);
        }
        self.replay_data_index += 1;
    }

    pub fn read_replay_header(&mut self, archive: &mut BinaryReader) {
        let magic = archive.read_uint32();
        if magic != NETWORK_MAGIC {
            panic!("Header.Magic != NETWORK_DEMO_MAGIC");
        }
        let mut header = ReplayHeader::default();
        let network_version_raw = archive.read_uint32();
        header.NetworkVersion = network_version_from_u32(network_version_raw);

        if network_version_raw >= NetworkVersionHistory::HistoryUseCustomVersion as u32 {
            let custom_version_count = archive.read_int32();
            archive.skip_bytes((custom_version_count as usize) * 20);
        }
        header.NetworkChecksum = archive.read_uint32();
        let engine_net_version_raw = archive.read_uint32();
        header.EngineNetworkVersion = engine_network_version_from_u32(engine_net_version_raw);
        header.GameNetworkProtocolVersion = archive.read_uint32();

        if network_version_raw >= NetworkVersionHistory::HistoryHeaderGuid as u32 {
            header.Guid = archive.read_guid_default();
        }
        if network_version_raw >= NetworkVersionHistory::HistorySaveFullEngineVersion as u32 {
            header.Major = archive.read_uint16();
            header.Minor = archive.read_uint16();
            header.Patch = archive.read_uint16();
            header.Changelist = archive.read_uint32();
            header.Branch = archive.read_fstring();
            archive.archive_state_mut().NetworkReplayVersion = Some(crate::replay::io::models::NetworkReplayVersion {
                Major: header.Major as i32,
                Minor: header.Minor as i32,
                Patch: header.Patch as i32,
                Changelist: header.Changelist as i32,
                Branch: header.Branch.clone(),
            });
        } else {
            header.Changelist = archive.read_uint32();
        }

        // VALORANT-specific byte skip
        let bytes_to_skip = archive.read_uint32();
        archive.skip_bytes(bytes_to_skip as usize);

        if network_version_raw >= NetworkVersionHistory::HistoryRecordingMetadata as u32 {
            header.UE4Version = archive.read_uint32();
            header.UE5Version = archive.read_uint32();
            header.PackageVersionLicenseeUE = archive.read_uint32();
        }

        if network_version_raw <= NetworkVersionHistory::HistoryMultipleLevels as u32 {
            panic!("HISTORY_MULTIPLE_LEVELS not supported yet.");
        } else {
            let count = archive.read_uint32();
            header.LevelNamesAndTimes = Vec::with_capacity(count as usize);
            for _ in 0..count {
                header.LevelNamesAndTimes.push((archive.read_fstring(), archive.read_uint32()));
            }
        }

        if network_version_raw >= NetworkVersionHistory::HistoryHeaderFlags as u32 {
            header.Flags = archive.read_uint32();
            archive.archive_state_mut().ReplayHeaderFlags = header.Flags;
        }

        let game_specific_count = archive.read_uint32();
        header.GameSpecificData = (0..game_specific_count).map(|_| archive.read_fstring()).collect();

        if network_version_raw >= NetworkVersionHistory::HistorySavePackageVersionUe as u32 {
            archive.read_single(); // minRecordHz
            archive.read_single(); // maxRecordHz
            archive.read_single(); // frameLimitInMS
            archive.read_single(); // checkpointLimitInMS
            header.Platform = archive.read_fstring();
            archive.read_byte(); // buildConfig
            header.BuildTargetType = archive.read_byte();
        }

        archive.archive_state_mut().EngineNetworkVersion = header.EngineNetworkVersion;
        archive.archive_state_mut().NetworkVersion = network_version_raw;

        for r in [&mut self.packet_reader, &mut self.cmd_reader] {
            r.archive_state_mut().EngineNetworkVersion = header.EngineNetworkVersion;
            r.archive_state_mut().NetworkVersion = network_version_raw;
            r.archive_state_mut().ReplayHeaderFlags = header.Flags;
        }

        self.replay_mut().set_header(header);
    }

    // ---- export data / net field exports -------------------------------------

    pub fn read_export_data(&mut self, archive: &mut BinaryReader) {
        self.read_net_field_exports(archive);
        self.read_net_export_guids(archive);
    }

    pub fn read_net_export_guids(&mut self, archive: &mut BinaryReader) {
        let num_guids = archive.read_int_packed();
        for _ in 0..num_guids {
            let size = archive.read_int32();
            let bytes = archive.read_bytes(size.max(0) as usize);
            let mut export_reader = BinaryReader::new(bytes);
            self.internal_load_object_binary(&mut export_reader, true, 0);
        }
    }

    pub fn read_net_field_exports(&mut self, archive: &mut BinaryReader) {
        let num_layout_cmd_exports = archive.read_int_packed();
        for _ in 0..num_layout_cmd_exports {
            let path_name_index = archive.read_int_packed();
            let is_exported = archive.read_int_packed() == 1;

            let group_path: Option<String> = if is_exported {
                let path_name = archive.read_fstring();
                let num_exports = archive.read_int_packed();
                if let Some(existing) = self.net_guid_cache.get_group_map_entry_mut(&path_name) {
                    if num_exports > existing.NetFieldExportsLength {
                        let old = std::mem::take(&mut existing.NetFieldExports);
                        existing.NetFieldExports = vec![None; num_exports as usize];
                        existing.NetFieldExportsLength = num_exports;
                        for (j, v) in old.into_iter().enumerate() {
                            existing.NetFieldExports[j] = v;
                        }
                    }
                } else {
                    let mut group = NetFieldExportGroup::default();
                    group.PathName = path_name.clone();
                    group.PathNameIndex = path_name_index;
                    group.NetFieldExportsLength = num_exports;
                    group.NetFieldExports = vec![None; num_exports as usize];
                    self.net_guid_cache.add_to_export_group_map(&path_name, group);
                }
                Some(path_name)
            } else {
                // Use the actual `group_map` key this index resolves to, not
                // the resolved group's `.PathName` field — see doc comment
                // on `get_net_field_export_group_key_from_index`.
                self.net_guid_cache
                    .get_net_field_export_group_key_from_index(Some(path_name_index))
                    .cloned()
            };

            let net_field = read_net_field_export_binary(archive);
            if let (Some(path), Some(field)) = (&group_path, &net_field) {
                if let Some(group) = self.net_guid_cache.get_group_map_entry_mut(path) {
                    if group.is_valid_index(field.Handle) {
                        group.NetFieldExports[field.Handle as usize] = Some(field.clone());
                    }
                }
            }
        }
    }

    // ---- demo frame ----------------------------------------------------------

    pub fn read_demo_frame_into_playback_packets(&mut self, archive: &mut BinaryReader) {
        if archive.archive_state().NetworkVersion >= NetworkVersionHistory::HistoryMultipleLevels as u32 {
            archive.read_int32(); // currentLevelIndex
        }
        self.current_frame_time_seconds = archive.read_single();

        if archive.archive_state().NetworkVersion >= NetworkVersionHistory::HistoryLevelStreamingFixes as u32 {
            self.read_export_data(archive);
        }

        if archive.has_level_streaming_fixes() {
            let num_streaming_levels = archive.read_int_packed();
            for _ in 0..num_streaming_levels {
                archive.read_fstring();
            }
        } else {
            let num_streaming_levels = archive.read_int_packed();
            for _ in 0..num_streaming_levels {
                archive.read_fstring();
                archive.read_fstring();
                archive.read_ftransform();
            }
        }

        if archive.has_level_streaming_fixes() {
            archive.read_uint64(); // externalOffset
        }

        self.read_external_data(archive);

        if archive.has_game_specific_frame_data() {
            let skip_external_offset = archive.read_uint64();
            if skip_external_offset > 0 {
                archive.skip_bytes(skip_external_offset as usize);
            }
        }

        loop {
            if archive.has_level_streaming_fixes() {
                archive.read_int_packed(); // seenLevelIndex
            }
            let state = self.read_packet(archive);
            if state != PacketState::Success {
                break;
            }
        }
    }

    pub fn read_external_data(&mut self, archive: &mut BinaryReader) {
        loop {
            let external_data_num_bits = archive.read_int_packed();
            if external_data_num_bits == 0 {
                return;
            }
            let net_guid = archive.read_int_packed();
            let num_bytes = (external_data_num_bits + 7) >> 3;
            let mut sub = BinaryReader::new(archive.read_bytes(num_bytes as usize));
            sub.archive_state_mut().NetworkReplayVersion = archive.archive_state().NetworkReplayVersion.clone();
            sub.archive_state_mut().EngineNetworkVersion = archive.archive_state().EngineNetworkVersion;
            sub.archive_state_mut().ReplayHeaderFlags = archive.archive_state().ReplayHeaderFlags;
            sub.archive_state_mut().ReplayVersion = archive.archive_state().ReplayVersion;
            sub.archive_state_mut().NetworkVersion = archive.archive_state().NetworkVersion;
            let data = ExternalData {
                NetGUID: net_guid,
                Archive: sub,
                TimeSeconds: 0.0,
            };
            self.net_guid_cache.external_data.insert(net_guid, data);
        }
    }

    pub fn read_packet(&mut self, archive: &mut BinaryReader) -> PacketState {
        let buffer_size = archive.read_int32();
        if buffer_size == 0 {
            return PacketState::End;
        }
        if buffer_size > 2048 || buffer_size < 0 {
            return PacketState::Error;
        }
        let packet = archive.read_bytes(buffer_size as usize);
        self.received_raw_packet(packet);
        PacketState::Success
    }

    fn received_raw_packet(&mut self, packet: Vec<u8>) {
        let mut last_byte = *packet.last().expect("packet must be non-empty");
        if last_byte != 0 {
            let mut bit_size = packet.len() * 8 - 1;
            while (last_byte & 0x80) < 1 {
                last_byte = last_byte.wrapping_mul(2);
                bit_size -= 1;
            }
            self.packet_reader.fill_buffer(packet, Some(bit_size));
            // Work around borrowing `self.packet_reader` and `self` mutably at
            // once: temporarily swap the reused NetBitReader out.
            let mut reader = std::mem::replace(&mut self.packet_reader, NetBitReader::new(Vec::new(), None));
            self.received_packet(&mut reader.0);
            self.packet_reader = reader;
        } else {
            panic!("Malformed packet: 0 in last byte");
        }
    }

    // ---- net guid loading ----------------------------------------------------

    pub fn internal_load_object_binary(&mut self, archive: &mut BinaryReader, is_exporting_net_guid_bunch: bool, recursion: u32) -> NetworkGUID {
        if recursion > 16 {
            return NetworkGUID::default();
        }
        let mut net_guid = NetworkGUID::default();
        net_guid.Value = archive.read_int_packed();
        if !net_guid.is_valid() {
            return net_guid;
        }

        if net_guid.is_default() || is_exporting_net_guid_bunch {
            let flags = archive.read_byte();
            if (flags & super::enums::export_flags::B_HAS_PATH) != 0 {
                self.internal_load_object_binary(archive, true, recursion + 1); // outerGuid
                let path_name = archive.read_fstring();
                if (flags & super::enums::export_flags::B_HAS_NETWORK_CHECKSUM) != 0 {
                    archive.read_uint32();
                }
                if is_exporting_net_guid_bunch {
                    self.net_guid_cache
                        .net_guid_to_path_name
                        .insert(net_guid.Value, remove_all_path_prefixes(&path_name));
                }
                return net_guid;
            }
        }
        net_guid
    }

    pub fn internal_load_object_bit(&mut self, archive: &mut BitReader, is_exporting_net_guid_bunch: bool, recursion: u32) -> NetworkGUID {
        if recursion > 16 {
            return NetworkGUID::default();
        }
        let mut net_guid = NetworkGUID::default();
        net_guid.Value = archive.read_int_packed();
        if !net_guid.is_valid() {
            return net_guid;
        }

        if net_guid.is_default() || is_exporting_net_guid_bunch {
            let flags = archive.read_byte();
            if (flags & super::enums::export_flags::B_HAS_PATH) != 0 {
                self.internal_load_object_bit(archive, true, recursion + 1); // outerGuid
                let path_name = archive.read_fstring();
                if (flags & super::enums::export_flags::B_HAS_NETWORK_CHECKSUM) != 0 {
                    archive.read_uint32();
                }
                if is_exporting_net_guid_bunch {
                    self.net_guid_cache
                        .net_guid_to_path_name
                        .insert(net_guid.Value, remove_all_path_prefixes(&path_name));
                }
                return net_guid;
            }
        }
        net_guid
    }

    pub fn receive_net_guid_bunch(&mut self, archive: &mut BitReader) {
        let b_has_rep_layout_export = archive.read_bit();
        if b_has_rep_layout_export {
            self.receive_net_field_exports_compat(archive);
            return;
        }
        let num_guids_in_bunch = archive.read_int32();
        if num_guids_in_bunch as u32 > MAX_GUID_COUNT {
            return;
        }
        let mut read = 0;
        while read < num_guids_in_bunch {
            self.internal_load_object_bit(archive, true, 0);
            read += 1;
        }
    }

    pub fn receive_net_field_exports_compat(&mut self, archive: &mut BitReader) {
        let num_layout_cmd_exports = archive.read_uint32();
        for _ in 0..num_layout_cmd_exports {
            let path_name_index = archive.read_int_packed();
            let group_path: Option<String> = if archive.read_bit() {
                let path_name = archive.read_fstring();
                let num_exports = archive.read_uint32();
                if self.net_guid_cache.get_group_map_entry(&path_name).is_none() {
                    let mut group = NetFieldExportGroup::default();
                    group.PathName = path_name.clone();
                    group.PathNameIndex = path_name_index;
                    group.NetFieldExportsLength = num_exports;
                    group.NetFieldExports = vec![None; num_exports as usize];
                    self.net_guid_cache.add_to_export_group_map(&path_name, group);
                }
                Some(path_name)
            } else {
                // Same fix as `read_net_field_exports`: use the actual
                // `group_map` key, not the resolved group's `.PathName`.
                self.net_guid_cache
                    .get_net_field_export_group_key_from_index(Some(path_name_index))
                    .cloned()
            };
            let net_field = read_net_field_export_bit(archive);
            if let (Some(path), Some(field)) = (&group_path, &net_field) {
                if let Some(group) = self.net_guid_cache.get_group_map_entry_mut(path) {
                    if group.is_valid_index(field.Handle) {
                        group.NetFieldExports[field.Handle as usize] = Some(field.clone());
                    }
                }
            }
        }
    }

    pub fn received_packet(&mut self, bit_reader: &mut BitReader) {
        self.in_packet_id += 1;
        let b_has_partial_custom_exports_final_bit = !(bit_reader.archive_state().EngineNetworkVersion < EngineNetworkVersionHistory::CustomExports);

        while !bit_reader.at_end() {
            if bit_reader.archive_state().EngineNetworkVersion < EngineNetworkVersionHistory::HistoryAcksIncludedInHeader {
                bit_reader.read_bit(); // isAckDummy
            }

            let b_control = bit_reader.read_bit();
            let b_open = b_control && bit_reader.read_bit();
            let b_close = b_control && bit_reader.read_bit();

            let (b_dormant, close_reason) = if bit_reader.archive_state().EngineNetworkVersion < EngineNetworkVersionHistory::HistoryChannelCloseReason {
                let dormant = b_close && bit_reader.read_bit();
                (dormant, if dormant { ChannelCloseReason::Dormancy } else { ChannelCloseReason::Destroyed })
            } else {
                let reason = if b_close {
                    channel_close_reason_from_u32(bit_reader.read_serialized_int(ChannelCloseReason::Max as u32))
                } else {
                    ChannelCloseReason::Destroyed
                };
                (reason == ChannelCloseReason::Dormancy, reason)
            };

            let b_is_replication_paused = bit_reader.read_bit();
            let b_reliable = bit_reader.read_bit();

            let ch_index = if bit_reader.archive_state().EngineNetworkVersion < EngineNetworkVersionHistory::HistoryMaxActorChannelsCustomization {
                bit_reader.read_serialized_int(OLD_MAX_ACTOR_CHANNELS)
            } else {
                bit_reader.read_int_packed()
            };

            let b_has_package_map_exports = bit_reader.read_bit();
            let b_has_must_be_mapped_guids = bit_reader.read_bit();
            let b_partial = bit_reader.read_bit();

            let ch_sequence = if b_reliable {
                self.in_reliable + 1
            } else if b_partial {
                self.in_packet_id
            } else {
                0
            };

            let b_partial_initial = b_partial && bit_reader.read_bit();
            let b_has_partial_custom_exports_final_bit = if b_partial && b_has_partial_custom_exports_final_bit {
                bit_reader.read_bit()
            } else {
                false
            };
            let b_partial_final = b_partial && bit_reader.read_bit();

            if bit_reader.archive_state().EngineNetworkVersion < EngineNetworkVersionHistory::HistoryChannelNames {
                bit_reader.read_serialized_int(ChannelType::Max as u32);
            } else {
                bit_reader.read_bit();
                if b_reliable || b_open {
                    bit_reader.read_fname();
                }
            }

            let channel_exists = self.channels[ch_index as usize].is_some();
            let bunch_data_bits = bit_reader.read_serialized_int(MAX_PACKET_SIZE_IN_BITS);

            let mut bunch = if b_partial {
                let sub_bytes = bit_reader.read_bits(bunch_data_bits as i64);
                let mut sub = BitReader::new(sub_bytes, Some(bunch_data_bits as usize));
                sub.archive_state_mut().EngineNetworkVersion = bit_reader.archive_state().EngineNetworkVersion;
                sub.archive_state_mut().NetworkVersion = bit_reader.archive_state().NetworkVersion;
                sub.archive_state_mut().ReplayHeaderFlags = bit_reader.archive_state().ReplayHeaderFlags;
                DataBunch::new(sub)
            } else {
                // Non-partial bunches read directly from `bit_reader` within a
                // `set_temp_end`-bounded window; ported via an owned copy of
                // the remaining bits (see `DataBunch::Archive` doc — a plain
                // `BitReader`, never aliased) bounded to exactly
                // `bunch_data_bits`, which is equivalent to TS's "read from the
                // same archive but clamped by set_temp_end/restore_temp_end"
                // since nothing outside `[position, position+bunchDataBits)`
                // is legally readable during that window anyway.
                let guard_start = bit_reader.position();
                let _guard = TempEndGuardMarker; // no-op placeholder, real bound enforced by read_bits below
                let _ = guard_start;
                let sub_bytes = bit_reader.read_bits(bunch_data_bits as i64);
                let mut sub = BitReader::new(sub_bytes, Some(bunch_data_bits as usize));
                // Bug fix: this owned copy must carry over the same
                // EngineNetworkVersion/NetworkVersion/ReplayHeaderFlags as
                // `bit_reader` — TS aliases the very same `BitReader` object
                // for `bunch.Archive` here (see this function's module doc
                // comment), so it never loses this state. Without this copy,
                // every version-gated read inside `processBunch`/content-block/
                // field parsing on this bunch's `Archive` silently took the
                // wrong (default `HistoryInitial`/`0`) branch — e.g. skipping
                // the `HistoryPackedVectorLwcSupport` quantized-vector path,
                // the `HistoryOptionallyQuantizeSpawnInfo` extra bit, and the
                // `HistorySubobjectDestroyFlag` destroy-message bit — which
                // desyncs the bitstream by a handful of bits per bunch and
                // eventually spins the content-block loop forever on a bunch
                // whose `IsError` got set with 0 bits ever consumed again.
                // (The `bPartial` branch just above already did this copy
                // correctly — this mirrors it.)
                sub.archive_state_mut().EngineNetworkVersion = bit_reader.archive_state().EngineNetworkVersion;
                sub.archive_state_mut().NetworkVersion = bit_reader.archive_state().NetworkVersion;
                sub.archive_state_mut().ReplayHeaderFlags = bit_reader.archive_state().ReplayHeaderFlags;
                DataBunch::new(sub)
            };

            bunch.PacketId = self.in_packet_id;
            bunch.bOpen = b_open;
            bunch.bClose = b_close;
            bunch.bDormant = b_dormant;
            bunch.CloseReason = close_reason;
            bunch.bIsReplicationPaused = b_is_replication_paused;
            bunch.bReliable = b_reliable;
            bunch.ChIndex = ch_index;
            bunch.bHasPackageMapExports = b_has_package_map_exports;
            bunch.bHasMustBeMappedGUIDs = b_has_must_be_mapped_guids;
            bunch.bPartial = b_partial;
            bunch.ChSequence = ch_sequence;
            bunch.bPartialInitial = b_partial_initial;
            bunch.bHasPartialCustomExportsFinalBit = b_has_partial_custom_exports_final_bit;
            bunch.bPartialFinal = b_partial_final;
            bunch.ChType = ChannelType::None;
            bunch.ChName = ChannelName::None;

            self.bunch_index += 1;

            if bunch.bHasPackageMapExports {
                let mut archive = std::mem::replace(&mut bunch.Archive, BitReader::new(Vec::new(), None));
                self.receive_net_guid_bunch(&mut archive);
                bunch.Archive = archive;
            }

            if !channel_exists {
                let mut new_channel = UChannel::default();
                new_channel.ChannelIndex = bunch.ChIndex;
                self.channels[bunch.ChIndex as usize] = Some(new_channel);
            }

            // TS: `try { this.receivedRawBunch(bunch); } catch { /* swallow */ }
            //      finally { if (!bunch.bPartial) bitReader.restoreTempEnd(BUNCH); }`
            // We never actually called `set_temp_end` on `bit_reader` above
            // (we consumed the bits into an owned `sub` reader instead — see
            // the non-partial branch's comment), so there's nothing to
            // restore on `bit_reader` here; the equivalent "don't let a panic
            // escape a single malformed bunch" behavior is preserved with
            // `catch_unwind`.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.received_raw_bunch(bunch);
            }));
            let _ = result;
        }
    }

    pub fn received_raw_bunch(&mut self, bunch: DataBunch) {
        self.received_next_bunch(bunch);
    }

    pub fn received_next_bunch(&mut self, bunch: DataBunch) {
        if bunch.bReliable {
            self.in_reliable = bunch.ChSequence;
        }

        if bunch.bPartial {
            if bunch.bPartialInitial {
                if self.partial_bunch.is_some() {
                    let keep = {
                        let pb = self.partial_bunch.as_ref().unwrap();
                        if !pb.bPartialFinal && pb.bReliable {
                            // reliable destroying reliable (or not) — TS returns either way
                            return;
                        }
                        false
                    };
                    let _ = keep;
                    self.partial_bunch = None;
                }
                let mut bunch = bunch;
                let bits_left = bunch.Archive.get_bits_left();
                let has_package_map_exports = bunch.bHasPackageMapExports;
                self.partial_bunch = Some(DataBunch::from_other({
                    // TS keeps `bunch` itself as the new partialBunch (aliasing);
                    // we move it in directly since we own it here.
                    std::mem::replace(&mut bunch, DataBunch::new(BitReader::new(Vec::new(), None)))
                }));
                if !has_package_map_exports && bits_left > 0 {
                    if bits_left % 8 != 0 {
                        return;
                    }
                    // initial partial bunches are byte-aligned; payload appended on merge
                }
                return;
            }

            // non-initial partial
            let mut b_sequence_matches = false;
            if let Some(pb) = &self.partial_bunch {
                let b_reliable_matches = bunch.ChSequence == pb.ChSequence + 1;
                let b_unreliable_matches = b_reliable_matches || bunch.ChSequence == pb.ChSequence;
                b_sequence_matches = if pb.bReliable { b_reliable_matches } else { b_unreliable_matches };
            }

            let continue_merge = match &self.partial_bunch {
                Some(pb) => !pb.bPartialFinal && b_sequence_matches && pb.bReliable == bunch.bReliable,
                None => false,
            };

            if continue_merge {
                let mut bunch = bunch;
                let bits_left = bunch.Archive.get_bits_left();
                if !bunch.bHasPackageMapExports && bits_left > 0 {
                    let bits = bunch.Archive.read_bits(bits_left);
                    let pb = self.partial_bunch.as_mut().unwrap();
                    pb.Archive.append_data_from_checked(&bits, bits_left as usize);
                }
                if !bunch.bHasPackageMapExports && !bunch.bPartialFinal && bits_left % 8 != 0 {
                    return;
                }
                let pb = self.partial_bunch.as_mut().unwrap();
                pb.ChSequence = bunch.ChSequence;
                if bunch.bPartialFinal {
                    if bunch.bHasPackageMapExports {
                        return;
                    }
                    pb.bPartialFinal = true;
                    pb.bClose = bunch.bClose;
                    pb.bDormant = bunch.bDormant;
                    pb.CloseReason = bunch.CloseReason;
                    pb.bIsReplicationPaused = bunch.bIsReplicationPaused;
                    pb.bHasMustBeMappedGUIDs = bunch.bHasMustBeMappedGUIDs;
                    let finished = self.partial_bunch.take().unwrap();
                    self.received_sequenced_bunch(finished);
                    return;
                }
                return;
            }
            return;
        }

        self.received_sequenced_bunch(bunch);
    }

    pub fn received_sequenced_bunch(&mut self, bunch: DataBunch) -> bool {
        let ch_index = bunch.ChIndex;
        let b_close = bunch.bClose;
        self.received_actor_bunch(bunch);
        if b_close {
            let actor = self.channels[ch_index as usize].as_ref().and_then(|c| c.Actor.as_ref()).map(|a| a.ActorNetGUID);
            self.channels[ch_index as usize] = None;
            self.hooks.on_channel_closed(ch_index, actor);
            return true;
        }
        false
    }

    pub fn received_actor_bunch(&mut self, mut bunch: DataBunch) {
        if bunch.bHasMustBeMappedGUIDs {
            let num = bunch.Archive.read_uint16();
            for _ in 0..num {
                bunch.Archive.read_int_packed();
            }
        }
        self.process_bunch(bunch);
    }

    pub fn conditionally_serialize_quantized_vector(&mut self, archive: &mut BitReader, def: FVector) -> FVector {
        let b_was_serialized = archive.read_bit();
        if b_was_serialized {
            let b_should_quantize = archive.archive_state().EngineNetworkVersion < EngineNetworkVersionHistory::HistoryOptionallyQuantizeSpawnInfo
                || archive.read_bit();
            if b_should_quantize {
                archive.read_packed_vector(10.0, 24)
            } else {
                archive.read_fvector()
            }
        } else {
            def
        }
    }

    pub fn process_bunch(&mut self, mut bunch: DataBunch) {
        let channel_has_actor = self.channels[bunch.ChIndex as usize].as_ref().map(|c| c.Actor.is_some());
        if channel_has_actor == Some(false) {
            if !bunch.bOpen {
                return;
            }

            let mut in_actor = Actor::default();
            {
                let mut archive = std::mem::replace(&mut bunch.Archive, BitReader::new(Vec::new(), None));
                in_actor.ActorNetGUID = self.internal_load_object_bit(&mut archive, false, 0);

                if archive.at_end() && in_actor.ActorNetGUID.is_dynamic() {
                    bunch.Archive = archive;
                    return;
                }

                if in_actor.ActorNetGUID.is_dynamic() {
                    in_actor.Archetype = Some(self.internal_load_object_bit(&mut archive, false, 0));
                    if archive.archive_state().EngineNetworkVersion >= EngineNetworkVersionHistory::HistoryNewActorOverrideLevel {
                        in_actor.Level = Some(self.internal_load_object_bit(&mut archive, false, 0));
                    }
                    in_actor.Location = Some(self.conditionally_serialize_quantized_vector(&mut archive, FVector::new(0.0, 0.0, 0.0)));
                    if archive.read_bit() {
                        in_actor.Rotation = Some(archive.read_rotation_short());
                    } else {
                        in_actor.Rotation = Some(FRotator::new(0.0, 0.0, 0.0));
                    }
                    in_actor.Scale = Some(self.conditionally_serialize_quantized_vector(&mut archive, FVector::new(1.0, 1.0, 1.0)));
                    in_actor.Velocity = Some(self.conditionally_serialize_quantized_vector(&mut archive, FVector::new(0.0, 0.0, 0.0)));
                }
                bunch.Archive = archive;
            }

            let channel_index = self.channels[bunch.ChIndex as usize].as_ref().unwrap().ChannelIndex;
            let archetype_id = {
                let channel = self.channels[bunch.ChIndex as usize].as_mut().unwrap();
                channel.Actor = Some(in_actor.clone());
                channel.archetype_id()
            };
            let path = self.net_guid_cache.try_get_path_name(archetype_id.unwrap_or(0)).cloned();
            self.hooks
                .on_channel_opened(channel_index, Some(&in_actor), path.as_deref(), self.current_frame_time_seconds);

            if let Some(path) = path {
                if self.net_field_parser.player_controller_groups(&self.registry).contains(path.as_str()) {
                    bunch.Archive.read_byte(); // netPlayerIndex
                }
            }
        }

        while !bunch.Archive.at_end() {
            let block = self.read_content_block_payload(&mut bunch);
            let payload = match block.payload {
                Some(p) => p,
                None => continue,
            };

            // Bug fix: the `TempEndGuard` below holds a raw pointer to
            // whatever `BitReader` sits at the address it's constructed
            // against, keyed by `ContentBlockPayload` in that reader's own
            // `temp_last_bit` map. The old code constructed the guard
            // against `&mut bunch.Archive` *before* swapping `bunch.Archive`
            // out via `mem::replace` for the `received_replicator_bunch`
            // call below. That swap overwrites the memory at
            // `bunch.Archive`'s storage slot with a brand-new placeholder
            // `BitReader` (a fresh, empty `temp_last_bit` map) while the
            // *real* reader — the one `set_temp_end` actually inserted the
            // `ContentBlockPayload` entry into — gets moved into the local
            // `archive` variable for the duration of the call. If anything
            // inside that call panics (e.g. a desynced bitstream tripping a
            // bounds check deep in field parsing — expected to happen on
            // malformed/edge-case real replays and meant to be caught by the
            // `catch_unwind` further up the stack), unwinding runs the
            // guard's `Drop`, which calls `restore_temp_end` on the
            // *placeholder* sitting at that address — whose map never had
            // the entry — panicking a second time. A panic during unwind
            // aborts the whole process (no exit code, no chance for
            // `catch_unwind` to swallow anything), which is exactly the
            // "crash on real replay files" bug this fixes.
            //
            // Fix: swap first, then construct (and later drop) the guard
            // against the *local* `archive` binding, whose address is
            // stable for as long as the guard lives — never against the
            // struct field slot that gets overwritten mid-flight. Only
            // write `archive` back into `bunch.Archive` after the guard has
            // already run its `restore_temp_end`.
            let rep_object = block.rep_object;
            let b_has_rep_layout = block.b_has_rep_layout;
            let mut archive = std::mem::replace(&mut bunch.Archive, BitReader::new(Vec::new(), None));
            let guard = TempEndGuard::new(&mut archive, payload as usize, FBitArchiveEndIndex::ContentBlockPayload);
            if block.b_object_deleted {
                drop(guard);
                bunch.Archive = archive;
                continue;
            }
            if archive.archive_state().IsError {
                drop(guard);
                bunch.Archive = archive;
                break;
            }
            if rep_object.is_none() || archive.at_end() {
                drop(guard);
                bunch.Archive = archive;
                continue;
            }
            let ok = self.received_replicator_bunch(&mut bunch, &mut archive, rep_object, b_has_rep_layout);
            drop(guard);
            bunch.Archive = archive;
            if !ok {
                continue;
            }
        }
    }

    pub fn received_replicator_bunch(&mut self, bunch: &mut DataBunch, archive: &mut BitReader, rep_object: Option<u32>, b_has_rep_layout: bool) -> bool {
        // NOTE: `bunch.Archive` has been swapped out for a placeholder by the
        // caller (`process_bunch`) for the duration of this call — `archive`
        // is the real, live reader (see judgment call #1's sibling note in
        // `process_bunch`). TS reads `bunch.Archive.EngineNetworkVersion`
        // here, but since `archive === bunch.Archive` there, reading it off
        // `archive` instead is the correct Rust equivalent.
        // Valorant payload de-obfuscation hook (see `ReplayReaderHooks::transform_bunch_payload`
        // doc comment — replaces TS's full-method override of
        // `receivedReplicatorBunch`). No-op for the base reader (default hook
        // impl returns the payload unchanged).
        let payload_bits = archive.get_bits_left();
        // TS: `ValorantReplayReader.receivedReplicatorBunch` builds a brand
        // new `transformedBunch`/`transformedReader` and recurses into
        // `super.receivedReplicatorBunch` with *those*, leaving the caller's
        // original `bunch.Archive` object completely untouched. That matters:
        // the caller (`process_bunch`'s content-block loop) already holds a
        // `TempEndGuard` on that same original archive (via
        // `set_temp_end`/`restore_temp_end`, keyed by a `temp_last_bit` map
        // that lives *on* the `BitReader` instance). Replacing `*archive`'s
        // entire contents in place (as this used to do) silently wiped that
        // instance's `temp_last_bit` map, so the guard's later
        // `restore_temp_end` call couldn't find its entry and panicked ("no
        // entry found for key") — or, once caught, left the archive
        // desynced forever. Shadowing `archive` with a reference to a
        // separate, locally-owned reader (instead of overwriting the
        // caller's object) mirrors TS's separate-object approach exactly.
        let mut new_archive_storage: Option<BitReader> = None;
        if payload_bits > 0 {
            let start = archive.position();
            let raw_payload = archive.read_bits(payload_bits);
            archive.seek(start as i64, SeekOrigin::Begin);
            let actor_guid = self.channels[bunch.ChIndex as usize].as_ref().and_then(|c| c.actor_id());
            let header_branch = self.replay().header_branch().to_string();
            let transformed = self
                .hooks
                .transform_bunch_payload(actor_guid, raw_payload, payload_bits as u32, &header_branch);
            let mut new_archive = BitReader::new(transformed, Some(payload_bits as usize));
            *new_archive.archive_state_mut() = archive.archive_state().clone();
            new_archive_storage = Some(new_archive);
        }
        let archive: &mut BitReader = match &mut new_archive_storage {
            Some(a) => a,
            None => archive,
        };

        let engine_version = archive.archive_state().EngineNetworkVersion;
        // Same fix as `class_net_cache` below: use the group object returned
        // here directly (matching TS) instead of re-looking it up by its own
        // `.PathName` field, which isn't guaranteed to match the (possibly
        // fuzzy-matched) key it's stored under in `group_map`.
        let export_group = match self.net_guid_cache.get_net_field_export_group_by_guid(rep_object) {
            Some(g) => g.clone(),
            None => return true,
        };

        if b_has_rep_layout {
            let res = self.receive_properties(archive, &export_group, bunch.ChIndex, true, false);
            if !res.0 {
                return false;
            }
            self.receive_external_data(&export_group, bunch.ChIndex);
        }

        if archive.at_end() {
            return true;
        }

        let use_full_name = engine_version >= EngineNetworkVersionHistory::HistoryClassnetcacheFullname;
        // TS uses the object `tryGetClassNetCache` returns directly (no
        // re-lookup). The previous port instead grabbed the returned group's
        // own `.PathName` field and re-fetched it from `group_map` by that
        // name — but a group's `.PathName` field isn't guaranteed to equal
        // the (possibly fuzzy-matched/normalized) key it's actually stored
        // under in `group_map`, so that second lookup could miss and panic
        // on the `.unwrap()`. Cloning the already-found group directly avoids
        // the redundant, unsound re-lookup.
        let class_net_cache = match self.net_guid_cache.try_get_class_net_cache(Some(&export_group.PathName), use_full_name) {
            Some(c) => c.clone(),
            None => return false,
        };

        loop {
            let fh = self.read_field_header_and_payload(archive, &class_net_cache);
            if !fh.more {
                break;
            }
            let payload = match fh.payload {
                Some(p) => p,
                None => continue,
            };

            let guard = TempEndGuard::new(archive, payload as usize, FBitArchiveEndIndex::FieldHeaderPayload);
            let field_cache = match &fh.out_field {
                Some(f) => f,
                None => {
                    drop(guard);
                    continue;
                }
            };
            if field_cache.Incompatible {
                drop(guard);
                continue;
            }
            if archive.archive_state().IsError || archive.at_end() {
                drop(guard);
                continue;
            }
            if !self.net_field_parser.will_read_class_net_cache(&self.registry, &class_net_cache.PathName) {
                drop(guard);
                continue;
            }

            let class_net_property = self
                .net_field_parser
                .try_get_class_net_cache_property(&self.registry, &field_cache.Name, &class_net_cache.PathName)
                .map(|p| (p.name, p.path_name, p.is_function, p.is_custom_struct, p.enable_property_checksum));

            if let Some((prop_name, path_name, is_function, is_custom_struct, enable_property_checksum)) = class_net_property {
                if is_function {
                    // TS uses the object `getNetFieldExportGroupByPath` returns
                    // directly (no re-lookup by the returned group's own
                    // `.PathName`). `get_net_field_export_group_by_path` is an
                    // exact `group_map` lookup keyed on `path_name`, but a
                    // group's stored `.PathName` field can differ from the key
                    // it's stored under (e.g. `ClassNetCache` groups get
                    // `remove_all_path_prefixes` applied to `.PathName` in
                    // `add_to_export_group_map`), so re-fetching by `.PathName`
                    // could silently miss and resolve to `None`/the wrong
                    // entry. Clone the already-found group directly instead.
                    let function_group = self.net_guid_cache.get_net_field_export_group_by_path(path_name).cloned();
                    if !self.received_rpc(archive, function_group.as_ref(), bunch.ChIndex) {
                        drop(guard);
                        return false;
                    }
                } else if is_custom_struct {
                    let field_cache_owned = field_cache.clone();
                    self.receive_custom_property(archive, &class_net_cache, &field_cache_owned, bunch.ChIndex, prop_name);
                } else {
                    // Same fix as the `is_function` branch above: use the
                    // group `get_net_field_export_group_by_path` returns
                    // directly instead of re-fetching it by its own
                    // `.PathName`.
                    let group = match self.net_guid_cache.get_net_field_export_group_by_path(path_name).cloned() {
                        Some(g) => g,
                        None => {
                            drop(guard);
                            continue;
                        }
                    };
                    if !self.net_field_parser.will_read_type(&self.registry, &group.PathName) {
                        drop(guard);
                        continue;
                    }
                    self.receive_custom_delta_property(archive, &group, bunch.ChIndex, enable_property_checksum);
                }
            }
            drop(guard);
        }
        true
    }

    pub fn receive_external_data(&mut self, group: &NetFieldExportGroup, channel_index: u32) -> bool {
        let actor_guid_value = match self.channels[channel_index as usize].as_ref() {
            Some(channel) => {
                if channel.is_ignoring_group(&group.PathName) {
                    return false;
                }
                channel.Actor.as_ref().map(|a| a.ActorNetGUID.Value)
            }
            None => return false,
        };
        if let Some(external_data) = self.net_guid_cache.try_get_external_data(actor_guid_value) {
            self.hooks.on_external_data_read(channel_index, Some(&external_data));
        }
        true
    }

    pub fn received_rpc(&mut self, reader: &mut BitReader, net_field_export_group: Option<&NetFieldExportGroup>, channel_index: u32) -> bool {
        let group = match net_field_export_group {
            Some(g) => g,
            None => return false,
        };
        self.receive_properties(reader, group, channel_index, true, false);
        if reader.archive_state().IsError {
            return false;
        }
        let ignoring = self.channels[channel_index as usize].as_ref().unwrap().is_ignoring_group(&group.PathName);
        if !ignoring && self.net_field_parser.will_read_type(&self.registry, &group.PathName) && !reader.at_end() {
            return false;
        }
        true
    }

    pub fn receive_custom_property(
        &mut self,
        reader: &mut BitReader,
        class_net_cache: &NetFieldExportGroup,
        field_cache: &NetFieldExport,
        channel_index: u32,
        _property_name: &'static str,
    ) -> bool {
        let export_obj = self
            .net_field_parser
            .create_property_type(&self.registry, &class_net_cache.PathName, &field_cache.Name);
        if let Some(mut export_obj) = export_obj {
            let num_bits = reader.get_bits_left();
            let bits = reader.read_bits(num_bits);
            self.cmd_reader.fill_buffer(bits, Some(num_bits as usize));
            let mut cmd_reader = std::mem::replace(&mut self.cmd_reader, NetBitReader::new(Vec::new(), None));
            export_obj.serialize(&mut cmd_reader);
            self.cmd_reader = cmd_reader;
            self.hooks.on_export_read(channel_index, Some(ExportedValue::Property(export_obj.as_ref())));
            return true;
        }
        false
    }

    pub fn receive_custom_delta_property(&mut self, reader: &mut BitReader, group: &NetFieldExportGroup, channel_index: u32, enable_property_checksum: bool) -> bool {
        if reader.archive_state().EngineNetworkVersion >= EngineNetworkVersionHistory::HistoryFastArrayDeltaStruct {
            reader.read_bit(); // bSupportsFastArrayDeltaStructSerialization
        }
        self.net_delta_serialize(reader, group, channel_index, enable_property_checksum)
    }

    pub fn net_delta_serialize_header(&mut self, reader: &mut BitReader) -> FFastArraySerializerHeader {
        FFastArraySerializerHeader {
            ArrayReplicationKey: reader.read_int32(),
            BaseReplicationKey: reader.read_int32(),
            NumDeletes: reader.read_int32(),
            NumChanged: reader.read_int32(),
        }
    }

    pub fn net_delta_serialize(&mut self, reader: &mut BitReader, group: &NetFieldExportGroup, channel_index: u32, enable_property_checksum: bool) -> bool {
        let header = self.net_delta_serialize_header(reader);
        if reader.archive_state().IsError {
            return false;
        }

        if header.NumDeletes > 0 {
            for _ in 0..header.NumDeletes {
                let element_index = reader.read_int32();
                self.delta_update.Deleted = true;
                self.delta_update.ElementIndex = element_index;
                self.delta_update.Export = None;
                self.delta_update.ChannelIndex = channel_index;
                self.hooks.on_net_delta_read(channel_index, &self.delta_update);
            }
        }
        for _ in 0..header.NumChanged {
            let element_index = reader.read_int32();
            let (_ok, export_group) = self.receive_properties(reader, group, channel_index, !enable_property_checksum, true);
            self.delta_update.Deleted = true;
            self.delta_update.ElementIndex = element_index;
            self.delta_update.Export = export_group;
            self.delta_update.ChannelIndex = channel_index;
            self.hooks.on_net_delta_read(channel_index, &self.delta_update);
        }
        true
    }

    /// Returns `(ok, export_group)`. `export_group` mirrors TS's returned
    /// `{ exportGroup }` (used by `netDeltaSerialize` to stash into
    /// `NetDeltaUpdate.Export`).
    pub fn receive_properties(
        &mut self,
        archive: &mut BitReader,
        group: &NetFieldExportGroup,
        channel_index: u32,
        enable_property_checksum: bool,
        net_delta_update: bool,
    ) -> (bool, Option<Box<dyn NetFieldModel>>) {
        {
            let channel = match self.channels[channel_index as usize].as_ref() {
                Some(c) => c,
                None => return (false, None),
            };
            if channel.is_ignoring_group(&group.PathName) {
                return (false, None);
            }
        }
        if !self.net_field_parser.will_read_type(&self.registry, &group.PathName) {
            self.channels[channel_index as usize].as_mut().unwrap().ignore_group(&group.PathName);
            return (false, None);
        }

        if enable_property_checksum {
            archive.read_bit();
        }

        let mut export_group = match self.net_field_parser.create_type(&self.registry, &group.PathName) {
            Some(g) => g,
            None => return (false, None),
        };

        let mut hasdata = false;
        // NOTE: `NetFieldExportGroup.NetFieldExports` (specifically each
        // entry's `Incompatible` flag) must be treated as *shared, mutable
        // storage keyed by class path* — Unreal only ever registers one
        // field/handle table per class, shared by every instance of that
        // class, and TS mutates the actual object living in
        // `NetFieldExportGroupMap` in place (`group` there is a reference,
        // not a copy). The Rust callers all hand this function a *clone* of
        // the group (see the `.clone()` call sites in `received_replicator_
        // bunch`/`receive_custom_delta_property`/etc.), so mutating a local
        // copy of `group` here — as a previous version of this function did
        // — silently discarded every `Incompatible` marking at the end of
        // the call. That let already-known-bad fields re-trigger `hasdata =
        // true` (and a fresh, spurious export) on every subsequent bunch for
        // that class instead of being skipped, which is why `AresWorldSettings`
        // (and similar always-open, long-lived channels) way overcounted.
        // Reading/writing directly against `self.net_guid_cache`'s stored
        // copy (keyed by `group.PathName`, which is the exact `group_map`
        // key outside of the `ClassNetCache`-suffix normalization case) is
        // what makes the fix stick across calls.
        loop {
            let mut handle = archive.read_int_packed();
            if handle == 0 {
                break;
            }
            handle -= 1;

            let export_field = match self.net_guid_cache.get_group_map_entry(&group.PathName) {
                Some(live_group) => {
                    if !live_group.is_valid_index(handle) {
                        return (false, None);
                    }
                    live_group.NetFieldExports[handle as usize].clone()
                }
                None => return (false, None),
            };
            let num_bits = archive.read_int_packed();
            if num_bits == 0 {
                continue;
            }
            let mut export_field = match export_field {
                Some(f) => f,
                None => {
                    archive.skip_bits(num_bits as i64);
                    continue;
                }
            };
            if export_field.Incompatible {
                archive.skip_bits(num_bits as i64);
                continue;
            }

            hasdata = true;
            let bits = archive.read_bits(num_bits as i64);
            self.cmd_reader.fill_buffer(bits, Some(num_bits as usize));
            let mut cmd_reader = std::mem::replace(&mut self.cmd_reader, NetBitReader::new(Vec::new(), None));
            let read_ok = self
                .net_field_parser
                .read_field(&self.registry, export_group.as_mut(), &export_field, handle, group, &mut cmd_reader, &self.net_guid_cache);
            if !read_ok {
                export_field.Incompatible = true;
            }
            let cmd_error = cmd_reader.archive_state().IsError;
            let cmd_at_end = cmd_reader.at_end();
            self.cmd_reader = cmd_reader;
            if cmd_error {
                export_field.Incompatible = true;
            } else if !cmd_at_end {
                export_field.Incompatible = true;
            }
            if let Some(live_group) = self.net_guid_cache.get_group_map_entry_mut(&group.PathName) {
                if live_group.is_valid_index(handle) {
                    live_group.NetFieldExports[handle as usize] = Some(export_field);
                }
            }
        }

        if !net_delta_update && hasdata {
            self.hooks.on_export_read(channel_index, Some(ExportedValue::Model(export_group.as_ref())));
        }
        (true, Some(export_group))
    }

    pub fn read_field_header_and_payload(&mut self, archive: &mut BitReader, group: &NetFieldExportGroup) -> FieldHeaderResult {
        if archive.at_end() {
            return FieldHeaderResult { more: false, out_field: None, payload: None };
        }

        let net_field_export_handle = archive.read_serialized_int(group.NetFieldExportsLength.max(2));
        if archive.archive_state().IsError {
            return FieldHeaderResult { more: false, out_field: None, payload: None };
        }

        let mut out_field = if group.is_valid_index(net_field_export_handle) {
            group.NetFieldExports[net_field_export_handle as usize].clone()
        } else {
            None
        };
        if out_field.is_none() {
            let mut f = NetFieldExport::default();
            f.Handle = net_field_export_handle;
            f.Name = format!("Handle_{net_field_export_handle}");
            out_field = Some(f);
        }

        let payload = archive.read_int_packed();
        if archive.archive_state().IsError {
            return FieldHeaderResult { more: false, out_field: None, payload: None };
        }
        if !archive.can_read(payload as i64) {
            return FieldHeaderResult { more: false, out_field, payload: None };
        }
        FieldHeaderResult { more: true, out_field, payload: Some(payload) }
    }

    pub fn read_content_block_payload(&mut self, bunch: &mut DataBunch) -> ContentBlockPayloadResult {
        let header = self.read_content_block_header(bunch);
        let payload = if !header.b_object_deleted { Some(bunch.Archive.read_int_packed()) } else { None };
        ContentBlockPayloadResult {
            rep_object: header.rep_object,
            b_object_deleted: header.b_object_deleted,
            b_has_rep_layout: header.b_has_rep_layout,
            payload,
        }
    }

    pub fn read_content_block_header(&mut self, bunch: &mut DataBunch) -> ContentBlockHeaderResult {
        let b_has_rep_layout = bunch.Archive.read_bit();
        let b_is_actor = bunch.Archive.read_bit();
        if b_is_actor {
            let channel = self.channels[bunch.ChIndex as usize].as_ref();
            let rep_object = channel.and_then(|c| c.archetype_id()).or_else(|| channel.and_then(|c| c.actor_id()));
            return ContentBlockHeaderResult { rep_object, b_has_rep_layout, b_object_deleted: false };
        }

        let mut archive = std::mem::replace(&mut bunch.Archive, BitReader::new(Vec::new(), None));
        let net_guid = self.internal_load_object_bit(&mut archive, false, 0);
        let b_stably_named = archive.read_bit();
        if b_stably_named {
            bunch.Archive = archive;
            return ContentBlockHeaderResult { rep_object: Some(net_guid.Value), b_has_rep_layout, b_object_deleted: false };
        }

        let mut b_delete_sub_object = false;
        let mut b_serialize_class = true;
        if archive.archive_state().EngineNetworkVersion >= EngineNetworkVersionHistory::HistorySubobjectDestroyFlag {
            let b_is_destroy_message = archive.read_bit();
            if b_is_destroy_message {
                b_delete_sub_object = true;
                b_serialize_class = false;
                archive.read_byte(); // destroyFlags
            }
        }

        let mut class_net_guid = NetworkGUID::default();
        if b_serialize_class {
            class_net_guid = self.internal_load_object_bit(&mut archive, false, 0);
            b_delete_sub_object = !class_net_guid.is_valid();
        }
        if b_delete_sub_object {
            bunch.Archive = archive;
            return ContentBlockHeaderResult { rep_object: None, b_has_rep_layout, b_object_deleted: true };
        }

        if archive.archive_state().EngineNetworkVersion >= EngineNetworkVersionHistory::HistorySubobjectOuterChain {
            let b_actor_is_outer = archive.at_end() || archive.read_bit();
            if !b_actor_is_outer {
                self.internal_load_object_bit(&mut archive, false, 0);
            }
        }
        bunch.Archive = archive;
        ContentBlockHeaderResult { rep_object: Some(class_net_guid.Value), b_has_rep_layout, b_object_deleted: false }
    }
}

pub struct FieldHeaderResult {
    pub more: bool,
    pub out_field: Option<NetFieldExport>,
    pub payload: Option<u32>,
}

pub struct ContentBlockPayloadResult {
    pub rep_object: Option<u32>,
    pub b_object_deleted: bool,
    pub b_has_rep_layout: bool,
    pub payload: Option<u32>,
}

pub struct ContentBlockHeaderResult {
    pub rep_object: Option<u32>,
    pub b_has_rep_layout: bool,
    pub b_object_deleted: bool,
}

/// No-op placeholder used only as a readability marker in `received_packet`'s
/// non-partial-bunch branch (see the comment there) — intentionally does
/// nothing on drop.
struct TempEndGuardMarker;

fn replay_version_from_u32(v: u32) -> ReplayVersionHistory {
    match v {
        0 => ReplayVersionHistory::HistoryInitial,
        1 => ReplayVersionHistory::HistoryFixedsizeFriendlyName,
        2 => ReplayVersionHistory::HistoryCompression,
        3 => ReplayVersionHistory::HistoryRecordedTimestamp,
        4 => ReplayVersionHistory::HistoryStreamChunkTimes,
        5 => ReplayVersionHistory::HistoryFriendlyNameEncoding,
        6 => ReplayVersionHistory::HistoryEncryption,
        _ => ReplayVersionHistory::HistoryCustomVersions,
    }
}

fn network_version_from_u32(v: u32) -> NetworkVersionHistory {
    match v {
        1 => NetworkVersionHistory::HistoryReplayInitial,
        2 => NetworkVersionHistory::HistorySaveAbsTimeMs,
        3 => NetworkVersionHistory::HistoryIncreaseBuffer,
        4 => NetworkVersionHistory::HistorySaveEngineVersion,
        5 => NetworkVersionHistory::HistoryExtraVersion,
        6 => NetworkVersionHistory::HistoryMultipleLevels,
        7 => NetworkVersionHistory::HistoryMultipleLevelsTimeChanges,
        8 => NetworkVersionHistory::HistoryDeletedStartupActors,
        9 => NetworkVersionHistory::HistoryHeaderFlags,
        10 => NetworkVersionHistory::HistoryLevelStreamingFixes,
        11 => NetworkVersionHistory::HistorySaveFullEngineVersion,
        12 => NetworkVersionHistory::HistoryHeaderGuid,
        13 => NetworkVersionHistory::HistoryCharacterMovement,
        14 => NetworkVersionHistory::HistoryCharacterMovementNointerp,
        15 => NetworkVersionHistory::HistoryGuidNametable,
        16 => NetworkVersionHistory::HistoryGuidcacheChecksums,
        17 => NetworkVersionHistory::HistorySavePackageVersionUe,
        18 => NetworkVersionHistory::HistoryRecordingMetadata,
        _ => NetworkVersionHistory::HistoryUseCustomVersion,
    }
}

fn engine_network_version_from_u32(v: u32) -> EngineNetworkVersionHistory {
    use EngineNetworkVersionHistory::*;
    match v {
        1 => HistoryInitial,
        2 => HistoryReplayBackwardsCompat,
        3 => HistoryMaxActorChannelsCustomization,
        4 => HistoryRepcmdChecksumRemovePrintf,
        5 => HistoryNewActorOverrideLevel,
        6 => HistoryChannelNames,
        7 => HistoryChannelCloseReason,
        8 => HistoryAcksIncludedInHeader,
        9 => HistoryNetexportSerialization,
        10 => HistoryNetexportSerializeFix,
        11 => HistoryFastArrayDeltaStruct,
        12 => HistoryFixEnumSerialization,
        13 => HistoryOptionallyQuantizeSpawnInfo,
        14 => HistoryJitterInHeader,
        15 => HistoryClassnetcacheFullname,
        16 => HistoryReplayDormancy,
        17 => HistoryEnumSerializationCompat,
        18 => HistorySubobjectOuterChain,
        19 => HistoryHitresultInstancehandle,
        20 => HistoryInterfacePropertySerialization,
        21 => HistoryMontagePlayInstIdSerialization,
        22 => HistorySerializeDoubleVectorsAsDoubles,
        23 => HistoryPackedVectorLwcSupport,
        24 => HistoryPawnRemoteviewpitch,
        25 => HistoryRepmoveServerframeAndHandle,
        26 => History21AndViewpitchOnlyDoNotUse,
        27 => HistoryPlaceholder,
        28 => HistoryRuntimeFeaturesCompatibility,
        29 => HistorySoftobjectptrNetguids,
        30 => HistorySubobjectDestroyFlag,
        31 => HistoryGamestateReplciatedTimeAsDouble,
        32 => HistoryCustomverion,
        33 => DynamicMontageSerialization,
        34 => PredictionKeyBaseNotReplicated,
        35 => RepMoveOptionalAcceleration,
        _ => CustomExports,
    }
}

fn channel_close_reason_from_u32(v: u32) -> ChannelCloseReason {
    match v {
        0 => ChannelCloseReason::Destroyed,
        1 => ChannelCloseReason::Dormancy,
        2 => ChannelCloseReason::LevelUnloaded,
        3 => ChannelCloseReason::Relevancy,
        4 => ChannelCloseReason::TearOff,
        _ => ChannelCloseReason::Max,
    }
}

/// C# `DateTime.FromBinary(ticks)` — ticks are 100ns since `0001-01-01`.
/// Returns milliseconds since the Unix epoch (matches the value a JS `Date`
/// would carry internally; a full `Date`-like type isn't part of this port).
fn ticks_to_epoch_ms(ticks: i64) -> i64 {
    const TICKS_MASK: i64 = 0x3fffffffffffffff; // strip Kind flags
    let t = ticks & TICKS_MASK;
    const EPOCH_TICKS: i64 = 621355968000000000; // 1970-01-01 in .NET ticks
    (t - EPOCH_TICKS) / 10000
}

// Silence "never constructed" lints for the doc-only marker type.
impl Drop for TempEndGuardMarker {
    fn drop(&mut self) {}
}

/// See judgment call #2 in the module docs: `readNetFieldExport` is the one
/// TS method genuinely called with both a `BinaryReader` and a `BitReader`
/// archive, so it's ported as two small duplicated functions rather than
/// introducing shared trait machinery for a single call site.
fn read_net_field_export_binary(archive: &mut BinaryReader) -> Option<NetFieldExport> {
    let is_exported = archive.read_boolean();
    if !is_exported {
        return None;
    }
    let mut field_export = NetFieldExport {
        IsExported: true,
        ..NetFieldExport::default()
    };
    field_export.Handle = archive.read_int_packed();
    field_export.CompatibleChecksum = archive.read_uint32();
    let engine_version = archive.archive_state().EngineNetworkVersion;
    if engine_version < EngineNetworkVersionHistory::HistoryNetexportSerialization {
        field_export.Name = archive.read_fstring();
        field_export.Type = archive.read_fstring();
    } else if engine_version < EngineNetworkVersionHistory::HistoryNetexportSerializeFix {
        field_export.Name = archive.read_fstring();
    } else {
        field_export.Name = archive.read_fname();
    }
    Some(field_export)
}

fn read_net_field_export_bit(archive: &mut BitReader) -> Option<NetFieldExport> {
    let is_exported = archive.read_boolean();
    if !is_exported {
        return None;
    }
    let mut field_export = NetFieldExport {
        IsExported: true,
        ..NetFieldExport::default()
    };
    field_export.Handle = archive.read_int_packed();
    field_export.CompatibleChecksum = archive.read_uint32();
    let engine_version = archive.archive_state().EngineNetworkVersion;
    if engine_version < EngineNetworkVersionHistory::HistoryNetexportSerialization {
        field_export.Name = archive.read_fstring();
        field_export.Type = archive.read_fstring();
    } else if engine_version < EngineNetworkVersionHistory::HistoryNetexportSerializeFix {
        field_export.Name = archive.read_fstring();
    } else {
        field_export.Name = archive.read_fname();
    }
    Some(field_export)
}
