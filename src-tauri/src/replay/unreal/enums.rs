//! Replication-layer enums from Unreal.Core/Models/Enums.
//! Ported from `package/ts-replay-parser/src/unreal/enums.ts`.
//! (Reader-layer enums live in `crate::replay::io::enums`.)

/// The single most load-bearing enum in the port: the property-kind tag used
/// by the registry/field-parser dispatch (`net_field_parser.rs`). Discriminants
/// are copied verbatim from the TS `enum RepLayoutCmdType` (note the gap:
/// 0..=25 then jumps to 94..=100) — this is only ever compared for equality
/// (never ordinally), so no `Ord` derive is needed, unlike `ParseMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum RepLayoutCmdType {
    DynamicArray = 0,
    Return = 1,
    Property = 2,
    PropertyBool = 3,
    PropertyFloat = 4,
    PropertyInt = 5,
    PropertyByte = 6,
    PropertyName = 7,
    PropertyObject = 8,
    PropertyUInt32 = 9,
    PropertyVector = 10,
    PropertyRotator = 11,
    PropertyPlane = 12,
    PropertyVector100 = 13,
    PropertyNetId = 14,
    RepMovement = 15,
    PropertyVectorNormal = 16,
    PropertyVector10 = 17,
    PropertyVectorQ = 18,
    PropertyString = 19,
    PropertyUInt64 = 20,
    PropertyNativeBool = 21,
    PropertySoftObject = 22,
    PropertyWeakObject = 23,
    PropertyInterface = 24,
    NetSerializeStructWithObjectReferences = 25,
    PropertyDouble = 94,
    PropertyVector2D = 95,
    PropertyInt16 = 96,
    PropertyUInt16 = 97,
    PropertyQuat = 98,
    Enum = 99,
    Ignore = 100,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum ChannelName {
    Control = 0,
    Voice = 1,
    Actor = 2,
    None = 3,
}

impl Default for ChannelName {
    fn default() -> Self {
        ChannelName::None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum ChannelType {
    None = 0,
    Control = 1,
    Actor = 2,
    File = 3,
    Voice = 4,
    Max = 8,
}

impl Default for ChannelType {
    fn default() -> Self {
        ChannelType::None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum ChannelCloseReason {
    Destroyed = 0,
    Dormancy = 1,
    LevelUnloaded = 2,
    Relevancy = 3,
    TearOff = 4,
    Max = 15,
}

impl Default for ChannelCloseReason {
    fn default() -> Self {
        ChannelCloseReason::Destroyed
    }
}

/// Compared with `>=`/`<=` in `replay_reader.rs` (`fileVersion >= ...`), so
/// this needs `Ord` like `EngineNetworkVersionHistory` in `io::enums`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u32)]
pub enum NetworkVersionHistory {
    HistoryReplayInitial = 1,
    HistorySaveAbsTimeMs = 2,
    HistoryIncreaseBuffer = 3,
    HistorySaveEngineVersion = 4,
    HistoryExtraVersion = 5,
    HistoryMultipleLevels = 6,
    HistoryMultipleLevelsTimeChanges = 7,
    HistoryDeletedStartupActors = 8,
    HistoryHeaderFlags = 9,
    HistoryLevelStreamingFixes = 10,
    HistorySaveFullEngineVersion = 11,
    HistoryHeaderGuid = 12,
    HistoryCharacterMovement = 13,
    HistoryCharacterMovementNointerp = 14,
    HistoryGuidNametable = 15,
    HistoryGuidcacheChecksums = 16,
    HistorySavePackageVersionUe = 17,
    HistoryRecordingMetadata = 18,
    HistoryUseCustomVersion = 19,
}
pub const NETWORK_VERSION_HISTORY_LATEST: NetworkVersionHistory = NetworkVersionHistory::HistoryUseCustomVersion;

/// Compared with `>=` in `replay_reader.rs`, and also used with bitwise `&`
/// against the raw `ReplayVersion` u32 (mirrors the TS source verbatim —
/// `archive.ReplayVersion & ReplayVersionHistory.HISTORY_STREAM_CHUNK_TIMES`
/// — preserved exactly even though it looks unusual for a monotonic version
/// history; that's what the original does, so we don't "fix" it).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u32)]
pub enum ReplayVersionHistory {
    HistoryInitial = 0,
    HistoryFixedsizeFriendlyName = 1,
    HistoryCompression = 2,
    HistoryRecordedTimestamp = 3,
    HistoryStreamChunkTimes = 4,
    HistoryFriendlyNameEncoding = 5,
    HistoryEncryption = 6,
    HistoryCustomVersions = 7,
}
pub const REPLAY_VERSION_HISTORY_LATEST: ReplayVersionHistory = ReplayVersionHistory::HistoryCustomVersions;

/// Real bit flags (see PORTING.md correctness anchor: `HasStreamingFixes = 1<<1`,
/// not `1<<0`). Not further bit-tested in `replay_reader.rs` itself (that
/// happens via `FArchive::has_level_streaming_fixes` etc. in `io::farchive`),
/// so this is just documentation/constants; `ReplayHeader.Flags` is stored as
/// a plain `u32`.
pub mod replay_header_flags {
    pub const NONE: u32 = 0;
    pub const CLIENT_RECORDED: u32 = 1 << 0;
    pub const HAS_STREAMING_FIXES: u32 = 1 << 1;
    pub const DELTA_CHECKPOINTS: u32 = 1 << 2;
    pub const GAME_SPECIFIC_FRAME_DATA: u32 = 1 << 3;
    pub const REPLAY_CONNECTION: u32 = 1 << 4;
    pub const ACTOR_PRIORITIZATION_ENABLED: u32 = 1 << 5;
    pub const NET_RELEVANCY_ENABLED: u32 = 1 << 6;
    pub const ASYNC_RECORDED: u32 = 1 << 7;
}

/// Bit-tested directly in `internalLoadObject` (`flags & ExportFlags.bHasPath`),
/// so kept as plain `u8` bit constants; `flags` locals are `u8`.
pub mod export_flags {
    pub const NONE: u8 = 0;
    pub const B_HAS_PATH: u8 = 1;
    pub const B_NO_LOAD: u8 = 2;
    pub const B_HAS_PATH_AND_NO_LOAD: u8 = 3;
    pub const B_HAS_NETWORK_CHECKSUM: u8 = 4;
    pub const B_HAS_PATH_AND_NETWORK_CHECKSUM: u8 = 5;
    pub const B_NO_LOAD_AND_NETWORK_CHECKSUM: u8 = 6;
    pub const ALL: u8 = 7;
}

/// Ordered `EventsOnly < Minimal < Normal < Full < Debug < Ignore` — verified
/// against the TS source (`enums.ts` lines 125-132): declaration order already
/// matches ascending numeric discriminants (0..=5), so the derived `Ord`
/// matches TS `<`/`>=` gating exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u32)]
pub enum ParseMode {
    EventsOnly = 0,
    Minimal = 1,
    Normal = 2,
    Full = 3,
    Debug = 4,
    Ignore = 5,
}

/// Assigned directly from a raw byte in `readReplayHeader`
/// (`header.BuildTargetType = archive.readByte();` — no cast in TS, since TS
/// enums are structurally numbers). We keep `ReplayHeader.BuildTargetType` as
/// a plain `u8` in `models.rs` to mirror that loose assignment faithfully
/// (a byte that doesn't match a known variant is still stored verbatim in TS);
/// this enum exists for documentation/lookup purposes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum BuildTargetType {
    Unknown = 0,
    Game = 1,
    Server = 2,
    Client = 3,
    Editor = 4,
    Program = 5,
}

/// Keys for `BitReader::set_temp_end`/`restore_temp_end`'s `index` parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum FBitArchiveEndIndex {
    Bunch = 0,
    ContentBlockPayload = 1,
    FieldHeaderPayload = 2,
    ReadArrayField = 3,
}

/// `Unknown` deliberately breaks the dense 0..=3 range (mirrors TS
/// `0xffffffff`), so this isn't a plain sequential enum; use
/// [`ReplayChunkType::from_u32`] rather than a raw transmute/cast.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum ReplayChunkType {
    Header = 0,
    ReplayData = 1,
    Checkpoint = 2,
    Event = 3,
    Unknown = 0xffffffff,
}

impl ReplayChunkType {
    pub fn from_u32(v: u32) -> ReplayChunkType {
        match v {
            0 => ReplayChunkType::Header,
            1 => ReplayChunkType::ReplayData,
            2 => ReplayChunkType::Checkpoint,
            3 => ReplayChunkType::Event,
            _ => ReplayChunkType::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum PacketState {
    Success = 0,
    End = 1,
    Error = 2,
}
