//! Enums from Unreal.Core/Models/Enums — only the values the IO layer needs.
//! Ported from `package/ts-replay-parser/src/io/enums.ts`
//! (originally the C# `EngineNetworkVersionHistory`, `VectorQuantization`,
//! `RotatorQuantization`, and `UniqueIdEncodingFlags`).

/// The TS enum is compared with `<` / `>=` for version gating throughout
/// bit-reader.ts / net-bit-reader.ts, so this is ported as a `#[repr(u32)]`
/// enum with derived `PartialOrd`/`Ord`. The variants are declared in the
/// exact same order as their explicit discriminants (1..=36, no gaps), so the
/// derived ordering matches numeric/TS enum ordering exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u32)]
pub enum EngineNetworkVersionHistory {
    HistoryInitial = 1,
    HistoryReplayBackwardsCompat = 2,
    HistoryMaxActorChannelsCustomization = 3,
    HistoryRepcmdChecksumRemovePrintf = 4,
    HistoryNewActorOverrideLevel = 5,
    HistoryChannelNames = 6,
    HistoryChannelCloseReason = 7,
    HistoryAcksIncludedInHeader = 8,
    HistoryNetexportSerialization = 9,
    HistoryNetexportSerializeFix = 10,
    HistoryFastArrayDeltaStruct = 11,
    HistoryFixEnumSerialization = 12,
    HistoryOptionallyQuantizeSpawnInfo = 13,
    HistoryJitterInHeader = 14,
    HistoryClassnetcacheFullname = 15,
    HistoryReplayDormancy = 16,
    HistoryEnumSerializationCompat = 17,
    HistorySubobjectOuterChain = 18,
    HistoryHitresultInstancehandle = 19,
    HistoryInterfacePropertySerialization = 20,
    HistoryMontagePlayInstIdSerialization = 21,
    HistorySerializeDoubleVectorsAsDoubles = 22,
    HistoryPackedVectorLwcSupport = 23,
    HistoryPawnRemoteviewpitch = 24,
    HistoryRepmoveServerframeAndHandle = 25,
    History21AndViewpitchOnlyDoNotUse = 26,
    HistoryPlaceholder = 27,
    HistoryRuntimeFeaturesCompatibility = 28,
    HistorySoftobjectptrNetguids = 29,
    HistorySubobjectDestroyFlag = 30,
    HistoryGamestateReplciatedTimeAsDouble = 31,
    HistoryCustomverion = 32,
    DynamicMontageSerialization = 33,
    PredictionKeyBaseNotReplicated = 34,
    RepMoveOptionalAcceleration = 35,
    CustomExports = 36,
}

/// Mirrors TS `VectorQuantization` numeric enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VectorQuantization {
    RoundWholeNumber = 0,
    RoundOneDecimal = 1,
    RoundTwoDecimals = 2,
}

impl Default for VectorQuantization {
    fn default() -> Self {
        VectorQuantization::RoundWholeNumber
    }
}

/// Mirrors TS `RotatorQuantization` numeric enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RotatorQuantization {
    ByteComponents = 0,
    ShortComponents = 1,
}

impl Default for RotatorQuantization {
    fn default() -> Self {
        RotatorQuantization::ByteComponents
    }
}

/// Mirrors TS `UniqueIdEncodingFlags`. This is used purely as bitmask
/// constants (`encodingFlags & UniqueIdEncodingFlags.IsEncoded`), never
/// compared for ordering, so it's ported as plain `u8` constants in a module
/// rather than an enum.
pub mod unique_id_encoding_flags {
    pub const NOT_ENCODED: u8 = 0;
    pub const IS_ENCODED: u8 = 1 << 0;
    pub const IS_EMPTY: u8 = 1 << 1;
    pub const UNUSED1: u8 = 1 << 2;
    pub const RESERVED1: u8 = 1 << 3;
    pub const FLAGS_MASK: u8 = (1 << 3) - 1;
    pub const TYPE_MASK: u8 = 255 ^ ((1 << 3) - 1);
}
