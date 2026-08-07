//! Replication-layer model types from Unreal.Core/Models.
//! Ported from `package/ts-replay-parser/src/unreal/models.ts`.
//!
//! TS interfaces become Rust traits:
//! - `IProperty` -> [`Property`] (serialize from a `NetBitReader`)
//! - `IResolvable` -> folded into `Property::resolve` as a default no-op
//!   (TS used a runtime `hasResolve` duck-type check; Rust dispatches
//!   statically/dynamically through the trait instead)
//! - `IHandleNetFieldExportGroup` -> [`HandleNetFieldExportGroup`]
//! - `INetFieldExportGroup` (a marker interface with no members) has no
//!   direct Rust equivalent; objects produced by registered factories
//!   implement [`NetFieldModel`] instead (see module docs on that trait).
//! - `IExternalData` -> implemented directly on [`ExternalData`] (only one
//!   implementer existed in TS)

#![allow(non_snake_case)]

use std::any::Any;

use crate::replay::io::binary_reader::BinaryReader;
use crate::replay::io::models::{FQuat, FRotator, FVector};
use crate::replay::io::net_bit_reader::NetBitReader;

use super::enums::{ChannelCloseReason, ChannelName, ChannelType, NetworkVersionHistory, ReplayVersionHistory};
use super::net_guid_cache::NetGuidCache;

/// A property that can deserialize itself from a `NetBitReader`, and
/// optionally resolve netguids afterward (default no-op — mirrors TS's
/// `hasResolve` duck-type check being false for most `IProperty`
/// implementers).
pub trait Property {
    fn serialize(&mut self, reader: &mut NetBitReader);
    fn resolve(&mut self, _cache: &NetGuidCache) {}
    /// Added in the valorant phase: lets callers downcast a `Box<dyn Property>`
    /// back to its concrete type (e.g. `ComponentDataStream`) after
    /// `RepLayoutCmdType::Property`/`PropertyQuat` deserialize it generically
    /// via a registered `element_factory`. TS has no equivalent — JS values
    /// are already concretely typed at the call site — so this is a Rust-only
    /// addition mirroring `NetFieldModel::as_any` below.
    fn as_any(&self) -> &dyn Any;
}

/// Replaces TS's dynamic `obj[key] = value` assignment (`NetFieldParser.setType`)
/// and `Object.entries(exportGroup)` (`onExportRead`)/`exportGroup.constructor.name`
/// duck typing. Every registered net-field export group's backing struct (the
/// ~36 Valorant models in the next phase) implements this trait.
pub trait NetFieldModel: Any {
    fn set_field(&mut self, key: &str, value: FieldValue);
    fn to_export_fields(&self) -> Vec<(&'static str, FieldValue)>;
    fn type_name(&self) -> &'static str;
    fn as_any(&self) -> &dyn Any;
    /// Mirrors TS's `IHandleNetFieldExportGroup.readFieldHandle` duck-type
    /// probe (`typeof obj.readFieldHandle === "function"`) in
    /// `NetFieldParser.readField`: tried unconditionally before the normal
    /// name/handle descriptor lookup; returning `true` means "field fully
    /// consumed by custom logic", `false` (the default — no override) means
    /// "fall through to normal dispatch". Only `AresAttributeSet` overrides
    /// this in the valorant phase.
    fn read_field_handle(&mut self, _handle: u32, _reader: &mut NetBitReader) -> bool {
        false
    }
}

/// An export group that consumes fields by handle with custom logic —
/// `readFieldHandle` returning `true` short-circuits the normal
/// name/handle-lookup dispatch in `NetFieldParser::read_field`.
pub trait HandleNetFieldExportGroup {
    fn read_field_handle(&mut self, handle: u32, reader: &mut NetBitReader) -> bool;
}

/// Dynamic value plumbing for `NetFieldModel::set_field`/`to_export_fields`.
/// Each `RepLayoutCmdType` data-producing arm in `net_field_parser.rs` maps to
/// one variant here.
pub enum FieldValue {
    Bool(bool),
    U8(u8),
    I16(i16),
    U16(u16),
    I32(i32),
    U32(u32),
    U64(u64),
    F32(f32),
    F64(f64),
    Str(String),
    Vector(FVector),
    Vector2D(crate::replay::io::models::FVector2D),
    Quat(FQuat),
    Rotator(FRotator),
    RepMovement(crate::replay::io::models::FRepMovement),
    Array(Vec<FieldValue>),
    Object(Box<dyn NetFieldModel>),
    /// `RepLayoutCmdType::Property`/`PropertyQuat`: a single `IProperty`-like
    /// value built via a descriptor's `element_factory` (e.g. `FText`,
    /// `NetworkGUID`, `FQuat`-wrapping structs) — distinct from `Object`,
    /// which holds a full `NetFieldModel` (used for `DynamicArray` group-type
    /// elements). These are deliberately different Rust traits (see
    /// `registry.rs` module docs), so they need separate `FieldValue` arms.
    PropertyValue(Box<dyn Property>),
    Null,
}

/// see Unreal `Text.cpp` `NetSerialize`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i8)]
pub enum ETextHistoryType {
    None = -1,
    Base = 0,
}

/// Localized text.
#[derive(Clone, Debug, Default)]
pub struct FText {
    pub Namespace: String,
    pub Key: String,
    pub Text: String,
}

impl Property for FText {
    fn serialize(&mut self, reader: &mut NetBitReader) {
        reader.read_int32(); // flags
        let history_type = reader.read_byte();
        if history_type == ETextHistoryType::Base as u8 {
            self.Namespace = reader.read_fstring();
            self.Key = reader.read_fstring();
            self.Text = reader.read_fstring();
        }
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NetworkGUID {
    pub Value: u32,
}

impl NetworkGUID {
    pub fn is_valid(&self) -> bool {
        self.Value > 0
    }
    pub fn is_dynamic(&self) -> bool {
        self.Value > 0 && (self.Value & 1) != 1
    }
    pub fn is_default(&self) -> bool {
        self.Value == 1
    }
}

impl Property for NetworkGUID {
    fn serialize(&mut self, reader: &mut NetBitReader) {
        self.Value = reader.read_int_packed();
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[derive(Clone, Debug)]
pub struct NetFieldExport {
    pub IsExported: bool,
    pub Handle: u32,
    pub CompatibleChecksum: u32,
    pub Name: String,
    pub Type: String,
    pub Incompatible: bool,
    /// -1 unknown, -2 not found.
    pub PropertyId: i32,
}

impl Default for NetFieldExport {
    fn default() -> Self {
        NetFieldExport {
            IsExported: false,
            Handle: 0,
            CompatibleChecksum: 0,
            Name: String::new(),
            Type: String::new(),
            Incompatible: false,
            PropertyId: -1,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NetFieldExportGroup {
    pub PathName: String,
    pub PathNameIndex: u32,
    pub NetFieldExportsLength: u32,
    pub NetFieldExports: Vec<Option<NetFieldExport>>,
    /// -1 unknown, -2 not found.
    pub GroupId: i32,
}

impl Default for NetFieldExportGroup {
    fn default() -> Self {
        NetFieldExportGroup {
            PathName: String::new(),
            PathNameIndex: 0,
            NetFieldExportsLength: 0,
            NetFieldExports: Vec::new(),
            GroupId: -1,
        }
    }
}

impl NetFieldExportGroup {
    pub fn is_valid_index(&self, handle: u32) -> bool {
        handle < self.NetFieldExportsLength
    }
}

#[derive(Clone, Debug, Default)]
pub struct Actor {
    pub ActorNetGUID: NetworkGUID,
    pub Archetype: Option<NetworkGUID>,
    pub Level: Option<NetworkGUID>,
    pub Location: Option<FVector>,
    pub Rotation: Option<FRotator>,
    pub Scale: Option<FVector>,
    pub Velocity: Option<FVector>,
}

#[derive(Debug, Default)]
pub struct UChannel {
    ignore: std::collections::HashSet<String>,
    pub ChannelName: ChannelName,
    pub ChannelIndex: u32,
    pub ChannelType: ChannelType,
    pub Actor: Option<Actor>,
}

impl UChannel {
    pub fn ignore_group(&mut self, group: &str) {
        self.ignore.insert(group.to_string());
    }
    pub fn is_ignoring_group(&self, group: &str) -> bool {
        self.ignore.contains(group)
    }
    pub fn archetype_id(&self) -> Option<u32> {
        self.Actor.as_ref().and_then(|a| a.Archetype).map(|g| g.Value)
    }
    pub fn actor_id(&self) -> Option<u32> {
        self.Actor.as_ref().map(|a| a.ActorNetGUID.Value)
    }
}

/// `Archive` is a plain [`crate::replay::io::bit_reader::BitReader`] in TS (`DataBunch.Archive!: BitReader`),
/// never a `NetBitReader` — the reused `NetBitReader` instances (`packetReader`/
/// `exportReader`/`cmdReader`) on `ReplayReader` are separate fields filled
/// from bunch archives as needed.
pub struct DataBunch {
    pub Archive: crate::replay::io::bit_reader::BitReader,
    pub PacketId: u32,
    pub ChIndex: u32,
    pub ChType: ChannelType,
    pub ChName: ChannelName,
    pub ChSequence: u32,
    pub bOpen: bool,
    pub bClose: bool,
    pub bDormant: bool,
    pub bIsReplicationPaused: bool,
    pub bReliable: bool,
    pub bPartial: bool,
    pub bPartialInitial: bool,
    pub bHasPartialCustomExportsFinalBit: bool,
    pub bPartialFinal: bool,
    pub bHasPackageMapExports: bool,
    pub bHasMustBeMappedGUIDs: bool,
    pub bIgnoreRPCs: bool,
    pub CloseReason: ChannelCloseReason,
}

impl DataBunch {
    pub fn new(archive: crate::replay::io::bit_reader::BitReader) -> Self {
        DataBunch {
            Archive: archive,
            PacketId: 0,
            ChIndex: 0,
            ChType: ChannelType::None,
            ChName: ChannelName::None,
            ChSequence: 0,
            bOpen: false,
            bClose: false,
            bDormant: false,
            bIsReplicationPaused: false,
            bReliable: false,
            bPartial: false,
            bPartialInitial: false,
            bHasPartialCustomExportsFinalBit: false,
            bPartialFinal: false,
            bHasPackageMapExports: false,
            bHasMustBeMappedGUIDs: false,
            bIgnoreRPCs: false,
            CloseReason: ChannelCloseReason::Destroyed,
        }
    }

    /// Mirrors the TS `constructor(other?: DataBunch)` copy-constructor used by
    /// `partialBunch = new DataBunch(bunch)`. Takes ownership of `other`'s
    /// archive (the TS version just aliases the same `BitReader` object —
    /// `this.Archive = other.Archive` — since JS objects are reference types;
    /// here we move it, which is the closest Rust equivalent given `BitReader`
    /// isn't `Clone`).
    pub fn from_other(other: DataBunch) -> Self {
        DataBunch {
            Archive: other.Archive,
            PacketId: other.PacketId,
            ChIndex: other.ChIndex,
            ChType: other.ChType,
            ChName: other.ChName,
            ChSequence: other.ChSequence,
            bOpen: other.bOpen,
            bClose: other.bClose,
            bDormant: other.bDormant,
            bIsReplicationPaused: other.bIsReplicationPaused,
            bReliable: other.bReliable,
            bPartial: other.bPartial,
            bPartialInitial: other.bPartialInitial,
            bHasPartialCustomExportsFinalBit: other.bHasPartialCustomExportsFinalBit,
            bPartialFinal: other.bPartialFinal,
            bHasPackageMapExports: other.bHasPackageMapExports,
            bHasMustBeMappedGUIDs: other.bHasMustBeMappedGUIDs,
            bIgnoreRPCs: other.bIgnoreRPCs,
            CloseReason: other.CloseReason,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct NetGuidCacheObject {
    pub OuterGuid: Option<NetworkGUID>,
    pub PathName: String,
    pub NetworkChecksum: u32,
    pub Flags: u32,
}

pub struct NetDeltaUpdate {
    pub ElementIndex: i32,
    pub Export: Option<Box<dyn NetFieldModel>>,
    pub Deleted: bool,
    pub ChannelIndex: u32,
}

impl Default for NetDeltaUpdate {
    fn default() -> Self {
        NetDeltaUpdate {
            ElementIndex: 0,
            Export: None,
            Deleted: false,
            ChannelIndex: 0,
        }
    }
}

pub struct FFastArraySerializerHeader {
    pub ArrayReplicationKey: i32,
    pub BaseReplicationKey: i32,
    pub NumDeletes: i32,
    pub NumChanged: i32,
}

#[derive(Clone, Debug, Default)]
pub struct EventInfo {
    pub Id: String,
    pub Group: String,
    pub Metadata: String,
    pub StartTime: u32,
    pub EndTime: u32,
    pub SizeInBytes: i32,
}
pub type CheckpointInfo = EventInfo;

#[derive(Clone, Debug, Default)]
pub struct ReplayDataInfo {
    pub Start: Option<u32>,
    pub End: Option<u32>,
    pub Length: u32,
}

#[derive(Clone, Debug)]
pub struct ReplayInfo {
    pub FileVersion: ReplayVersionHistory,
    pub LengthInMs: u32,
    pub NetworkVersion: u32,
    pub Changelist: u32,
    pub FriendlyName: String,
    pub IsLive: bool,
    pub Timestamp: Option<i64>,
    pub IsCompressed: bool,
    pub IsEncrypted: bool,
    pub EncryptionKey: Vec<u8>,
}

impl Default for ReplayInfo {
    fn default() -> Self {
        ReplayInfo {
            FileVersion: ReplayVersionHistory::HistoryInitial,
            LengthInMs: 0,
            NetworkVersion: 0,
            Changelist: 0,
            FriendlyName: String::new(),
            IsLive: false,
            Timestamp: None,
            IsCompressed: false,
            IsEncrypted: false,
            EncryptionKey: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ReplayHeader {
    pub NetworkVersion: NetworkVersionHistory,
    pub NetworkChecksum: u32,
    pub EngineNetworkVersion: crate::replay::io::enums::EngineNetworkVersionHistory,
    pub GameNetworkProtocolVersion: u32,
    pub Guid: String,
    pub Major: u16,
    pub Minor: u16,
    pub Patch: u16,
    pub Changelist: u32,
    pub Branch: String,
    pub UE4Version: u32,
    pub UE5Version: u32,
    pub PackageVersionLicenseeUE: u32,
    pub LevelNamesAndTimes: Vec<(String, u32)>,
    /// Real bit flags (see `enums::replay_header_flags`); stored raw as `u32`.
    pub Flags: u32,
    pub GameSpecificData: Vec<String>,
    pub Platform: String,
    /// Raw byte, loosely typed like the TS field (see `enums::BuildTargetType` doc).
    pub BuildTargetType: u8,
}

impl Default for ReplayHeader {
    fn default() -> Self {
        ReplayHeader {
            NetworkVersion: NetworkVersionHistory::HistoryReplayInitial,
            NetworkChecksum: 0,
            EngineNetworkVersion: crate::replay::io::enums::EngineNetworkVersionHistory::HistoryInitial,
            GameNetworkProtocolVersion: 0,
            Guid: String::new(),
            Major: 0,
            Minor: 0,
            Patch: 0,
            Changelist: 0,
            Branch: String::new(),
            UE4Version: 0,
            UE5Version: 0,
            PackageVersionLicenseeUE: 0,
            LevelNamesAndTimes: Vec::new(),
            Flags: 0,
            GameSpecificData: Vec::new(),
            Platform: String::new(),
            BuildTargetType: 0,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Replay {
    pub Info: ReplayInfo,
    pub Header: ReplayHeader,
}

/// Implements TS `IExternalData` directly (only implementer). `Archive` is
/// always a concrete `BinaryReader` in TS (`readExternalData` does
/// `new BinaryReader(...)`, never a `BitReader`), so this is ported as the
/// concrete type rather than a trait object.
pub struct ExternalData {
    pub NetGUID: u32,
    pub Archive: BinaryReader,
    pub TimeSeconds: f64,
}
