//! Unreal replication engine layer — ported from
//! `package/ts-replay-parser/src/unreal/`. Depends only on `crate::replay::io`
//! (never the other way around — see `PORTING.md`'s layering rule:
//! `valorant -> unreal -> {io, ooz, transform}`).

pub mod enums;
pub mod models;
pub mod net_field_parser;
pub mod net_guid_cache;
pub mod registry;
pub mod replay_reader;
pub mod string_utils;

pub use enums::{
    export_flags, replay_header_flags, BuildTargetType, ChannelCloseReason, ChannelName,
    ChannelType, FBitArchiveEndIndex, NetworkVersionHistory, PacketState, ParseMode,
    RepLayoutCmdType, ReplayChunkType, ReplayVersionHistory,
};
pub use models::{
    Actor, DataBunch, ETextHistoryType, ExternalData, FFastArraySerializerHeader, FText,
    FieldValue, HandleNetFieldExportGroup, NetDeltaUpdate, NetFieldExport, NetFieldExportGroup,
    NetFieldModel, NetGuidCacheObject, NetworkGUID, Property, Replay, ReplayHeader, ReplayInfo,
    UChannel,
};
pub use net_field_parser::NetFieldParser;
pub use net_guid_cache::NetGuidCache;
pub use registry::{
    ClassNetCacheDescriptor, ClassNetCacheProperty, NetFieldDescriptor,
    NetFieldExportGroupDescriptor, NetFieldRegistry, RepMovementSpec,
};
pub use replay_reader::{ExportedValue, ReplayLike, ReplayReader, ReplayReaderHooks};
pub use string_utils::{clean_path_suffix, remove_all_path_prefixes, remove_path_prefix};
