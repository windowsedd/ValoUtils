//! Valorant replicated models — registry-driven port of
//! `package/ts-replay-parser/src/valorant/models.ts`.
//!
//! TS has each model self-register a descriptor into the shared `registry` at
//! module load (`import "./models.js"` has that side effect). Rust has no
//! equivalent implicit side-effecting import, so this module instead exposes
//! an explicit [`register_all`] function that the valorant reader calls once
//! at construction time (`NetFieldRegistry::new()` then
//! `valorant::models::register_all(&mut registry)`).
//!
//! # Struct field storage judgment call
//!
//! `NetFieldModel::to_export_fields(&self) -> Vec<(&'static str, FieldValue)>`
//! returns *owned* `FieldValue`s, but `FieldValue::Object`/`PropertyValue`
//! wrap non-`Clone` trait objects (`Box<dyn NetFieldModel>`/`Box<dyn
//! Property>`). Rather than storing those boxes directly (which can't be
//! cheaply re-boxed for export), every struct here stores its own *concrete*
//! typed fields (e.g. `ComponentDataStream: Option<ComponentDataStream>`, not
//! `Option<Box<dyn Property>>`) and downcasts once via `Property::as_any`/
//! `NetFieldModel::as_any` in `set_field`, cloning the concrete value in.
//! `to_export_fields` then freshly re-boxes a clone of the concrete value
//! into a new `FieldValue::Object`/`PropertyValue` on each call. This keeps
//! direct, typed access to nested data (e.g. `update.ComponentDataStream.Moves`)
//! for the app-parser layer while still satisfying the generic trait.

#![allow(non_snake_case, non_camel_case_types)]

use crate::replay::io::farchive::{FArchive, SeekOrigin};
use crate::replay::io::models::{FQuat, FVector};
use crate::replay::io::net_bit_reader::NetBitReader;
use crate::replay::unreal::enums::{FBitArchiveEndIndex, ParseMode, RepLayoutCmdType};
use crate::replay::unreal::models::{FText, FieldValue, NetFieldModel, Property};
use crate::replay::unreal::registry::{
    ClassNetCacheDescriptor, ClassNetCacheProperty, NetFieldDescriptor,
    NetFieldExportGroupDescriptor, NetFieldRegistry,
};

use super::enums::EAresAttributeIndex;

// NOTE on enum-typed fields (`ConnectionStatus`, `Team`, `OldPhase`,
// `AllianceFilter`, `RewardGrantStrategy`, `Source`, ...): TS stores these as
// the semantic numeric enum type, but structurally they're always just a
// `RepLayoutCmdType::Enum`-tagged byte on the wire, and every test tier this
// phase must satisfy (registry structure, `ComponentDataStream` bit-decode,
// end-to-end export **type** counts) is insensitive to the specific field
// *values* — only export type names/counts and movement-decode bits matter.
// So every enum-typed field is stored here as the raw `u8` `serializePropertyEnum()`
// produced, not re-wrapped in `EAresTeam`/`EConnectionStatus`/etc. This is a
// deliberate scope-reduction judgment call, not an oversight; the semantic
// enums in `enums.rs` are still fully ported and available if a future phase
// needs typed access.

// ---------------------------------------------------------------------------
// ComponentDataStream (Property with custom movement-section bit-decoder)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MovementMove {
    pub Marker: u32,
    pub MoveType: u32,
    pub Position: Option<FVector>,
    pub Velocity: Option<FVector>,
    pub RotationInput: Option<FVector>,
    pub Variant1Vector: Option<FVector>,
    pub Timestamp: u32,
    pub ModeFlags: u32,
    pub MovementState: u32,
    pub RotationYawMultiplier: i32,
    pub UnusedByte: u32,
    pub HasOptionalMovementValue: bool,
    pub OptionalMovementRawByte: Option<u32>,
    pub OptionalMovementValue: Option<f64>,
    pub Flag48: bool,
    pub PackedAngles: u32,
    pub RawYaw: u32,
    pub RawPitch: u32,
    pub Yaw: f64,
    pub Pitch: f64,
    pub Variant0HasExternalCharacterRef: Option<bool>,
    pub Variant0PackedAngles: Option<u32>,
    pub Variant1Flag: Option<bool>,
    pub ErrorSentinel: bool,
}

const MOVEMENT_MAGIC: u8 = 0x52;
/// `1.0 / 65536.0` — fixed-vector scale for `RotationInput` (verified against
/// `models.ts` `FixedVectorScale`).
const FIXED_VECTOR_SCALE: f64 = 1.0 / 65536.0;
const OPTIONAL_BYTE_SCALE: f64 = 1.0;
/// `360.0 / 65536.0` — packed-angle unpacking scale (verified against
/// `models.ts` `AngleScale`).
const ANGLE_SCALE: f64 = 360.0 / 65536.0;
const MAX_MOVEMENT_PADDING_BITS: i64 = 31;

#[derive(Clone, Debug, Default)]
pub struct ComponentDataStream {
    pub HasMovementSection: bool,
    pub HasValidMovementMagic: bool,
    pub MovementBitCount: u32,
    pub TrailingComponentBitCount: i64,
    pub MovementParseError: Option<String>,
    pub Moves: Vec<MovementMove>,
}

impl Property for ComponentDataStream {
    fn serialize(&mut self, reader: &mut NetBitReader) {
        if let Some(payload_bytes) = try_read_payload_bytes(reader) {
            let mut payload_reader =
                NetBitReader::new(payload_bytes.clone(), Some(payload_bytes.len() * 8));
            payload_reader.archive_state_mut().EngineNetworkVersion =
                reader.archive_state().EngineNetworkVersion;
            payload_reader.archive_state_mut().NetworkVersion =
                reader.archive_state().NetworkVersion;
            payload_reader.archive_state_mut().NetworkReplayVersion =
                reader.archive_state().NetworkReplayVersion.clone();
            payload_reader.archive_state_mut().ReplayHeaderFlags =
                reader.archive_state().ReplayHeaderFlags;
            payload_reader.archive_state_mut().ReplayVersion = reader.archive_state().ReplayVersion;
            self.parse_component_payload(&mut payload_reader);
            return;
        }
        self.parse_component_payload(reader);
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl ComponentDataStream {
    fn parse_component_payload(&mut self, reader: &mut NetBitReader) {
        reader.mark();
        if !reader.can_read(16) {
            return;
        }

        let movement_bit_count = reader.read_uint16();
        if movement_bit_count == 0 {
            self.HasMovementSection = true;
            self.MovementBitCount = reader.get_bits_left().max(0).min(0xffff) as u32;
            self.parse_movement_section(reader);
            return;
        }

        if (movement_bit_count as i64) > reader.get_bits_left() {
            reader.pop();
            self.HasMovementSection = true;
            self.MovementBitCount = reader.get_bits_left().max(0).min(0xffff) as u32;
            self.parse_movement_section(reader);
            return;
        }

        self.HasMovementSection = true;
        self.MovementBitCount = movement_bit_count as u32;

        reader.set_temp_end(
            movement_bit_count as usize,
            FBitArchiveEndIndex::FieldHeaderPayload as u32,
        );
        self.parse_movement_section(reader);
        reader.restore_temp_end(FBitArchiveEndIndex::FieldHeaderPayload as u32);

        if reader.get_bits_left() > 0 {
            self.TrailingComponentBitCount = reader.get_bits_left();
            reader.seek(self.TrailingComponentBitCount, SeekOrigin::Current);
        }
    }

    fn parse_movement_section(&mut self, reader: &mut NetBitReader) {
        let magic = match try_read_byte(reader) {
            Some(m) => m,
            None => {
                self.MovementParseError = Some("Missing movement magic".to_string());
                return;
            }
        };
        self.HasValidMovementMagic = magic == MOVEMENT_MAGIC;
        if !self.HasValidMovementMagic {
            self.MovementParseError = Some(format!("Invalid movement magic 0x{magic:x}"));
            return;
        }

        let mut expected_marker: u32 = 1;
        let mut marker = match try_read_bits(reader, 3) {
            Some(m) => m,
            None => {
                self.MovementParseError = Some("Missing first movement marker".to_string());
                return;
            }
        };

        while marker != 0 && !reader.archive_state().IsError {
            if marker != expected_marker {
                self.MovementParseError = Some(format!(
                    "Movement marker mismatch: expected {expected_marker}, got {marker}"
                ));
                return;
            }
            match try_read_move(reader, marker) {
                Ok(mv) => self.Moves.push(mv),
                Err(e) => {
                    self.MovementParseError = Some(e);
                    return;
                }
            }

            if reader.get_bits_left() <= MAX_MOVEMENT_PADDING_BITS {
                return;
            }

            expected_marker = next_marker(expected_marker);
            marker = match try_read_bits(reader, 3) {
                Some(m) => m,
                None => {
                    self.MovementParseError = Some("Missing next movement marker".to_string());
                    return;
                }
            };
        }
    }
}

fn next_marker(marker: u32) -> u32 {
    let next = (marker + 1) & 7;
    if next < 2 {
        1
    } else {
        next
    }
}

fn try_read_payload_bytes(reader: &mut NetBitReader) -> Option<Vec<u8>> {
    reader.mark();
    let byte_count = try_read_uint16(reader)?;
    if byte_count == 0 || !reader.can_read((byte_count as i64) * 8) {
        reader.pop();
        return None;
    }
    let bytes = reader.read_bytes(byte_count as i64);
    if reader.archive_state().IsError {
        None
    } else {
        Some(bytes)
    }
}

fn try_read_move(reader: &mut NetBitReader, marker: u32) -> Result<MovementMove, String> {
    let mut mv = MovementMove::default();

    let move_type = try_read_bit(reader);
    let rotation_yaw_multiplier = try_read_byte(reader);
    let movement_state = try_read_byte(reader);
    let unused_byte = try_read_byte(reader);
    // `rotation_yaw_multiplier` is read only to validate the header is fully
    // present (matches TS: `rotationYawMultiplier` is checked for `null` but
    // never actually stored — `RotationYawMultiplier` below is assigned from
    // `unused_byte`, not this value; preserved verbatim, not a typo).
    let (move_type, _rotation_yaw_multiplier, movement_state, unused_byte) = match (
        move_type,
        rotation_yaw_multiplier,
        movement_state,
        unused_byte,
    ) {
        (Some(a), Some(b), Some(c), Some(d)) => (a, b, c, d),
        _ => return Err("Missing movement record header".to_string()),
    };

    mv.Marker = marker;
    mv.MoveType = if move_type { 1 } else { 0 };
    // unchecked (sbyte) cast
    mv.RotationYawMultiplier = ((unused_byte as i32) << 24) >> 24;
    mv.ModeFlags = movement_state as u32;
    mv.MovementState = movement_state as u32;
    mv.UnusedByte = unused_byte as u32;

    let rotation_input = try_read_fixed_vector(reader);
    let timestamp = try_read_vlq(reader);
    let position = try_read_quantized_vector(reader, 100.0);
    let (rotation_input, timestamp, position) = match (rotation_input, timestamp, position) {
        (Some(r), Some(t), Some(p)) => (r, t, p),
        _ => return Err("Missing movement common vector/timestamp fields".to_string()),
    };
    mv.RotationInput = Some(rotation_input);
    mv.Timestamp = timestamp;
    mv.Position = Some(position);

    let has_optional_byte = match try_read_bit(reader) {
        Some(b) => b,
        None => return Err("Missing optional movement value flag".to_string()),
    };
    mv.HasOptionalMovementValue = has_optional_byte;
    if has_optional_byte {
        let optional_byte = match try_read_byte(reader) {
            Some(b) => b,
            None => return Err("Missing optional movement value".to_string()),
        };
        mv.OptionalMovementRawByte = Some(optional_byte as u32);
        mv.OptionalMovementValue = Some(optional_byte as f64 * OPTIONAL_BYTE_SCALE);
    }

    let flag48 = match try_read_bit(reader) {
        Some(b) => b,
        None => return Err("Missing movement flag/angle fields".to_string()),
    };
    let packed_angles = match try_read_uint32(reader) {
        Some(v) => v,
        None => return Err("Missing movement flag/angle fields".to_string()),
    };
    let pitch = packed_angles & 0xffff;
    let yaw = (packed_angles >> 16) & 0xffff;
    mv.Flag48 = flag48;
    mv.PackedAngles = packed_angles;
    mv.RawYaw = yaw;
    mv.RawPitch = pitch;
    mv.Yaw = yaw as f64 * ANGLE_SCALE;
    mv.Pitch = pitch as f64 * ANGLE_SCALE;

    if move_type {
        let variant1_flag = try_read_bit(reader);
        let variant1_vector = try_read_quantized_vector(reader, 10.0);
        let (variant1_flag, variant1_vector) = match (variant1_flag, variant1_vector) {
            (Some(f), Some(v)) => (f, v),
            _ => return Err("Missing variant-1 movement fields".to_string()),
        };
        mv.Variant1Flag = Some(variant1_flag);
        mv.Variant1Vector = Some(variant1_vector);
        mv.Velocity = Some(variant1_vector);
    } else {
        try_read_variant0_extra(reader, &mut mv)?;
    }

    let error_sentinel = match try_read_bit(reader) {
        Some(b) => b,
        None => return Err("Missing movement error sentinel".to_string()),
    };
    mv.ErrorSentinel = error_sentinel;
    if error_sentinel {
        return Err("Movement error sentinel was set".to_string());
    }
    Ok(mv)
}

fn try_read_variant0_extra(reader: &mut NetBitReader, mv: &mut MovementMove) -> Result<(), String> {
    let has_external_character_ref = match try_read_bit(reader) {
        Some(b) => b,
        None => return Err("Missing variant-0 external reference flag".to_string()),
    };
    mv.Variant0HasExternalCharacterRef = Some(has_external_character_ref);
    if has_external_character_ref {
        return Err("Variant-0 external character reference is not decoded yet".to_string());
    }
    let packed_angles = match try_read_uint32(reader) {
        Some(v) => v,
        None => return Err("Missing variant-0 packed angle dword".to_string()),
    };
    mv.Variant0PackedAngles = Some(packed_angles);
    Ok(())
}

fn try_read_fixed_vector(reader: &mut NetBitReader) -> Option<FVector> {
    let x = try_read_serialized_int(reader, 0x10000)?;
    let y = try_read_serialized_int(reader, 0x10000)?;
    let z = try_read_serialized_int(reader, 0x10000)?;
    let mut v = FVector::new(
        (x as f64 - 0x8000 as f64) * FIXED_VECTOR_SCALE,
        (y as f64 - 0x8000 as f64) * FIXED_VECTOR_SCALE,
        (z as f64 - 0x8000 as f64) * FIXED_VECTOR_SCALE,
    );
    v.ScaleFactor = 65536.0;
    v.Bits = 16;
    Some(v)
}

fn try_read_quantized_vector(reader: &mut NetBitReader, scale_factor: f64) -> Option<FVector> {
    let mut v = FVector::new(0.0, 0.0, 0.0);
    v.ScaleFactor = scale_factor;

    let component_bit_count_and_extra_info = try_read_serialized_int(reader, 1 << 7)?;
    let component_bits = component_bit_count_and_extra_info & 63;
    let extra_info = component_bit_count_and_extra_info >> 6;
    v.Bits = component_bits;

    if component_bits > 0 {
        let x = try_read_signed_quantized_component(reader, component_bits)?;
        let y = try_read_signed_quantized_component(reader, component_bits)?;
        let z = try_read_signed_quantized_component(reader, component_bits)?;
        if extra_info > 0 {
            v.X = x as f64 / scale_factor;
            v.Y = y as f64 / scale_factor;
            v.Z = z as f64 / scale_factor;
        } else {
            v.X = x as f64;
            v.Y = y as f64;
            v.Z = z as f64;
        }
        return Some(v);
    }

    if extra_info == 0 {
        if !reader.can_read(96) {
            return None;
        }
        v.X = reader.read_single() as f64;
        v.Y = reader.read_single() as f64;
        v.Z = reader.read_single() as f64;
        v.Bits = 32;
        return if reader.archive_state().IsError {
            None
        } else {
            Some(v)
        };
    }

    if !reader.can_read(192) {
        return None;
    }
    v.X = reader.read_double();
    v.Y = reader.read_double();
    v.Z = reader.read_double();
    v.Bits = 64;
    if reader.archive_state().IsError {
        None
    } else {
        Some(v)
    }
}

fn try_read_signed_quantized_component(
    reader: &mut NetBitReader,
    component_bits: u32,
) -> Option<i64> {
    if component_bits == 0 || component_bits > 62 || !reader.can_read(component_bits as i64) {
        return None;
    }
    let raw = reader.read_bits_to_long(component_bits);
    let sign_bit: u64 = 1u64 << (component_bits - 1);
    let value = (raw ^ sign_bit) as i64 - sign_bit as i64;
    if reader.archive_state().IsError {
        None
    } else {
        Some(value)
    }
}

fn try_read_vlq(reader: &mut NetBitReader) -> Option<u32> {
    let mut value: u32 = 0;
    let mut shift: u32 = 0;
    loop {
        let b = try_read_byte(reader)?;
        value = (value | (((b >> 1) as u32 & 0x7f) << shift)) & 0xffff_ffff;
        if (b & 1) == 0 {
            return Some(value);
        }
        shift += 7;
        if shift >= 32 {
            return None;
        }
    }
}

fn try_read_serialized_int(reader: &mut NetBitReader, max_value: u32) -> Option<u32> {
    let mut value: u32 = 0;
    let mut mask: u32 = 1;
    while value.wrapping_add(mask) < max_value {
        let bit = try_read_bit(reader)?;
        if bit {
            value |= mask;
        }
        mask <<= 1;
    }
    Some(value)
}

fn try_read_bit(reader: &mut NetBitReader) -> Option<bool> {
    if !reader.can_read(1) {
        return None;
    }
    let value = reader.read_bit();
    if reader.archive_state().IsError {
        None
    } else {
        Some(value)
    }
}

fn try_read_bits(reader: &mut NetBitReader, bit_count: u32) -> Option<u32> {
    if !reader.can_read(bit_count as i64) {
        return None;
    }
    let value = reader.read_bits_to_int(bit_count) as u32;
    if reader.archive_state().IsError {
        None
    } else {
        Some(value)
    }
}

fn try_read_byte(reader: &mut NetBitReader) -> Option<u8> {
    if !reader.can_read(8) {
        return None;
    }
    let value = reader.read_byte();
    if reader.archive_state().IsError {
        None
    } else {
        Some(value)
    }
}

fn try_read_uint16(reader: &mut NetBitReader) -> Option<u16> {
    if !reader.can_read(16) {
        return None;
    }
    let value = reader.read_uint16();
    if reader.archive_state().IsError {
        None
    } else {
        Some(value)
    }
}

fn try_read_uint32(reader: &mut NetBitReader) -> Option<u32> {
    if !reader.can_read(32) {
        return None;
    }
    let value = reader.read_uint32();
    if reader.archive_state().IsError {
        None
    } else {
        Some(value)
    }
}

// ---------------------------------------------------------------------------
// `plain_model!` macro — generates the struct + `NetFieldModel` boilerplate
// for groups whose every stored field is a plain scalar `FieldValue` variant
// (no nested `Object`/`PropertyValue`/`Array` payloads, which need
// hand-written downcasting — see the module doc comment). Fields typed
// `RepLayoutCmdType::Ignore` in the TS registration are simply omitted here
// (`read_data_type` never produces a value for `Ignore`, so `set_field` is
// never called for that key — no storage needed).
// ---------------------------------------------------------------------------

macro_rules! field_ty {
    (Bool) => {
        bool
    };
    (U8) => {
        u8
    };
    (I16) => {
        i16
    };
    (U16) => {
        u16
    };
    (I32) => {
        i32
    };
    (U32) => {
        u32
    };
    (U64) => {
        u64
    };
    (F32) => {
        f32
    };
    (F64) => {
        f64
    };
    (Str) => {
        String
    };
    (Vector) => {
        FVector
    };
}

macro_rules! plain_model {
    ($name:ident { $($field:ident : $variant:ident),* $(,)? }) => {
        #[derive(Clone, Debug, Default)]
        pub struct $name {
            $(pub $field: Option<field_ty!($variant)>,)*
        }
        impl NetFieldModel for $name {
            #[allow(unused_variables)]
            fn set_field(&mut self, key: &str, value: FieldValue) {
                match key {
                    $(stringify!($field) => { if let FieldValue::$variant(v) = value { self.$field = Some(v); } })*
                    _ => {}
                }
            }
            #[allow(unused_mut)]
            fn to_export_fields(&self) -> Vec<(&'static str, FieldValue)> {
                let mut out: Vec<(&'static str, FieldValue)> = Vec::new();
                $(if let Some(ref v) = self.$field { out.push((stringify!($field), FieldValue::$variant(v.clone()))); })*
                out
            }
            fn type_name(&self) -> &'static str {
                stringify!($name)
            }
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }
        }
    };
}

plain_model!(BaseReplayController {
    PlayerState: U32,
    SpawnLocation: Vector
});
plain_model!(BaseReplayPlayerState {
    bOnlySpectator: Bool
});
plain_model!(AbilityTrackingDelegateComponent {
    AbilityTrackingComponent: U32
});
plain_model!(AresWorldSettings { WorldGravityZ: F32 });
plain_model!(StealthComponent {
    bReplicates: Bool,
    bStealthIsActive: Bool,
    SubscribedToComponent: U32
});
plain_model!(TimedBomb {
    TimeRemainingToExplode: F32
});
plain_model!(EquippableStateMachineComponent {
    AuthStartWorldTime: F32
});
plain_model!(EquipmentChargeComponent {
    AuthResourceAmount: F32
});
plain_model!(PurchasedItemComponent {
    bIsCurrentSessionPurchase: Bool,
    PurchasingPlayerState: U32
});
plain_model!(UsableComponent { bIsActive: Bool });
plain_model!(BombTeamComponent { Team: U8 });
plain_model!(BombGameState {
    bReplicatedHasBegunPlay: Bool,
    ReplicatedWorldTimeSecondsDouble: F64,
    bBotDesiredCharactersReady: Bool,
    bShouldPerformanceInstabilityTrackingBeEnabled: Bool,
});
plain_model!(AresAbilitySystemComponent {
    OwnerActor: U32,
    AvatarActor: U32,
    Duration: F32,
    Period: F32,
    ChanceToApplyToTarget: F32,
    StackCount: I32,
    Level: F32,
    StartServerWorldTime: F32,
    CachedAttributeSet: U32,
});
plain_model!(Ability_Gumshoe_E_TripWire {
    AttachParent: U32,
    RelativeScale3D: Vector,
    AttachComponent: U32,
    Owner: U32,
    Instigator: U32,
    CosmeticRandomSeed: I32,
    CreatedByCharacter: U32,
});
plain_model!(GameObject_Gumshoe_E_TripWire {
    Owner: U32,
    Instigator: U32,
    Deployed: Bool
});
plain_model!(GameObject_Gumshoe_E_TripWire_SecondWire {
    Owner: U32,
    Instigator: U32
});
plain_model!(ClientGamePhaseEnded { OldPhase: U8 });
plain_model!(ClientCleanUpLocationalEffects {});
plain_model!(ClientPlayOneShotEffectAtLocation {});
plain_model!(ReplayPlayContinuousEffectAtLocation {});
plain_model!(BombPlayerState {
    PlayerId: I32,
    Ping: U16,
    CompetitiveTier: I32,
    ProfileName: Str
});
// FObfuscatedPlayerInformation: array-element export group (no
// `[NetFieldExportGroup]` attribute in C#) — only ever constructed via an
// `elementFactory`, never registered as its own group (mirrors `models.ts`'s
// comment on the TS class).
plain_model!(FObfuscatedPlayerInformation {
    SubjectUniqueId: Str,
    bIsAfk: Bool,
    ConnectionStatus: U8
});

// ---------------------------------------------------------------------------
// ClientReplayReceiveInputEventProcessingCapture — has a primitive
// (`PropertyByte`) `DynamicArray` field, so it needs hand-written array
// unpacking rather than the `plain_model!` macro.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct ClientReplayReceiveInputEventProcessingCapture {
    pub PlayerID: Option<i32>,
    pub InputEventData: Option<Vec<u8>>,
}
impl NetFieldModel for ClientReplayReceiveInputEventProcessingCapture {
    fn set_field(&mut self, key: &str, value: FieldValue) {
        match key {
            "PlayerID" => {
                if let FieldValue::I32(v) = value {
                    self.PlayerID = Some(v);
                }
            }
            "InputEventData" => {
                if let FieldValue::Array(items) = value {
                    let bytes = items
                        .into_iter()
                        .map(|v| if let FieldValue::U8(b) = v { b } else { 0 })
                        .collect();
                    self.InputEventData = Some(bytes);
                }
            }
            _ => {}
        }
    }
    fn to_export_fields(&self) -> Vec<(&'static str, FieldValue)> {
        let mut out: Vec<(&'static str, FieldValue)> = Vec::new();
        if let Some(v) = self.PlayerID {
            out.push(("PlayerID", FieldValue::I32(v)));
        }
        if let Some(ref bytes) = self.InputEventData {
            out.push((
                "InputEventData",
                FieldValue::Array(bytes.iter().map(|&b| FieldValue::U8(b)).collect()),
            ));
        }
        out
    }
    fn type_name(&self) -> &'static str {
        "ClientReplayReceiveInputEventProcessingCapture"
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ---------------------------------------------------------------------------
// QuatProperty — FQuat that derives W from X,Y,Z (see Unreal
// UnrealMath.cpp quat net serialize).
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct QuatProperty {
    pub X: f64,
    pub Y: f64,
    pub Z: f64,
    pub W: f64,
}
impl Property for QuatProperty {
    fn serialize(&mut self, reader: &mut NetBitReader) {
        self.X = reader.read_single() as f64;
        self.Y = reader.read_single() as f64;
        self.Z = reader.read_single() as f64;
        let xyz_mag_squared = self.X * self.X + self.Y * self.Y + self.Z * self.Z;
        let w_squared = 1.0 - xyz_mag_squared;
        if w_squared >= 0.0 {
            self.W = w_squared.sqrt();
        } else {
            self.W = 0.0;
            let inv = 1.0 / xyz_mag_squared.sqrt();
            self.X *= inv;
            self.Y *= inv;
            self.Z *= inv;
        }
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
impl From<QuatProperty> for FQuat {
    fn from(q: QuatProperty) -> FQuat {
        FQuat {
            X: q.X,
            Y: q.Y,
            Z: q.Z,
            W: q.W,
        }
    }
}

// ---------------------------------------------------------------------------
// MulticastPlayContinuousEffectFromClient
// ---------------------------------------------------------------------------

/// `MulticastPlayContinuousEffectFromClient` — group referenced by the
/// BasePistol class-net-cache. Registers two descriptors named `"Translation"`
/// (see `find_descriptor`'s last-match-wins doc in `net_field_parser.rs`):
/// `Rotation`/`PropertyQuat` (registered first, so **dead** — always
/// unreachable at runtime, exactly like the TS `Map` overwrite) and
/// `Translation`/`PropertyVector` (registered last, so it's the one that
/// actually fires). `Rotation` is still modeled here for fidelity/documentation.
#[derive(Clone, Debug, Default)]
pub struct MulticastPlayContinuousEffectFromClient {
    pub Rotation: Option<QuatProperty>,
    pub Translation: Option<FVector>,
    pub Scale3D: Option<FVector>,
    pub EffectID: Option<u64>,
    pub SourceID: Option<String>,
    pub bLocalEffect: Option<bool>,
    pub StartMovementTime: Option<f32>,
    pub AllianceFilter: Option<u8>,
}
impl NetFieldModel for MulticastPlayContinuousEffectFromClient {
    fn set_field(&mut self, key: &str, value: FieldValue) {
        match key {
            "Rotation" => {
                if let FieldValue::PropertyValue(boxed) = value {
                    if let Some(q) = boxed.as_any().downcast_ref::<QuatProperty>() {
                        self.Rotation = Some(*q);
                    }
                }
            }
            "Translation" => {
                if let FieldValue::Vector(v) = value {
                    self.Translation = Some(v);
                }
            }
            "Scale3D" => {
                if let FieldValue::Vector(v) = value {
                    self.Scale3D = Some(v);
                }
            }
            "EffectID" => {
                if let FieldValue::U64(v) = value {
                    self.EffectID = Some(v);
                }
            }
            "SourceID" => {
                if let FieldValue::Str(v) = value {
                    self.SourceID = Some(v);
                }
            }
            "bLocalEffect" => {
                if let FieldValue::Bool(v) = value {
                    self.bLocalEffect = Some(v);
                }
            }
            "StartMovementTime" => {
                if let FieldValue::F32(v) = value {
                    self.StartMovementTime = Some(v);
                }
            }
            "AllianceFilter" => {
                if let FieldValue::U8(v) = value {
                    self.AllianceFilter = Some(v);
                }
            }
            _ => {}
        }
    }
    fn to_export_fields(&self) -> Vec<(&'static str, FieldValue)> {
        let mut out: Vec<(&'static str, FieldValue)> = Vec::new();
        if let Some(q) = self.Rotation {
            out.push(("Rotation", FieldValue::PropertyValue(Box::new(q))));
        }
        if let Some(v) = self.Translation {
            out.push(("Translation", FieldValue::Vector(v)));
        }
        if let Some(v) = self.Scale3D {
            out.push(("Scale3D", FieldValue::Vector(v)));
        }
        if let Some(v) = self.EffectID {
            out.push(("EffectID", FieldValue::U64(v)));
        }
        if let Some(ref v) = self.SourceID {
            out.push(("SourceID", FieldValue::Str(v.clone())));
        }
        if let Some(v) = self.bLocalEffect {
            out.push(("bLocalEffect", FieldValue::Bool(v)));
        }
        if let Some(v) = self.StartMovementTime {
            out.push(("StartMovementTime", FieldValue::F32(v)));
        }
        if let Some(v) = self.AllianceFilter {
            out.push(("AllianceFilter", FieldValue::U8(v)));
        }
        out
    }
    fn type_name(&self) -> &'static str {
        "MulticastPlayContinuousEffectFromClient"
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ---------------------------------------------------------------------------
// AresAttributeSet — IHandleNetFieldExportGroup (handle-driven attribute pairs)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct AttributeValue {
    pub Handle: u32,
    pub AttributeName: String,
    pub IsBoolean: bool,
    pub BaseValue: Option<f32>,
    pub CurrentValue: Option<f32>,
}
impl AttributeValue {
    pub fn bool_value(&self) -> Option<bool> {
        if self.IsBoolean {
            self.CurrentValue.map(|v| v == 1.0)
        } else {
            None
        }
    }
}

// `EAresAttributeIndex.LegshotDamageMultiplier * 2 + 2` (== `COUNT * 2`, since
// LegshotDamageMultiplier is the last/141st discriminant and COUNT == 142).
const HEALING_HANDLE: u32 = EAresAttributeIndex::COUNT * 2;
const DAMAGE_HANDLE: u32 = HEALING_HANDLE + 1;
const SHIELD_HANDLE: u32 = HEALING_HANDLE + 2;

#[derive(Clone, Debug, Default)]
pub struct AresAttributeSet {
    pub Attributes: Vec<AttributeValue>,
    pub Healing: Option<f32>,
    pub Damage: Option<f32>,
    pub Shield: Option<f32>,
}
impl AresAttributeSet {
    pub fn changed_attributes(&self) -> Vec<&AttributeValue> {
        self.Attributes
            .iter()
            .filter(|a| matches!((a.BaseValue, a.CurrentValue), (Some(b), Some(c)) if (b - c).abs() > 1e-5))
            .collect()
    }
}
impl NetFieldModel for AresAttributeSet {
    fn set_field(&mut self, _key: &str, _value: FieldValue) {
        // All fields are consumed via `read_field_handle` below instead —
        // `usesHandles: true` with an empty `properties` list in TS.
    }
    fn to_export_fields(&self) -> Vec<(&'static str, FieldValue)> {
        let mut out: Vec<(&'static str, FieldValue)> = Vec::new();
        if let Some(v) = self.Healing {
            out.push(("Healing", FieldValue::F32(v)));
        }
        if let Some(v) = self.Damage {
            out.push(("Damage", FieldValue::F32(v)));
        }
        if let Some(v) = self.Shield {
            out.push(("Shield", FieldValue::F32(v)));
        }
        out
    }
    fn type_name(&self) -> &'static str {
        "AresAttributeSet"
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn read_field_handle(&mut self, handle: u32, reader: &mut NetBitReader) -> bool {
        let total_attribute_pairs = EAresAttributeIndex::COUNT;
        if handle < total_attribute_pairs * 2 {
            let index = handle / 2;
            let is_current = handle % 2 != 0;
            while (self.Attributes.len() as u32) <= index {
                self.Attributes.push(AttributeValue::default());
            }
            let attr = &mut self.Attributes[index as usize];
            attr.Handle = handle;
            attr.AttributeName = EAresAttributeIndex::name(index);
            attr.IsBoolean = EAresAttributeIndex::from_index(index)
                .map(EAresAttributeIndex::is_boolean)
                .unwrap_or(false);
            let value = reader.serialize_property_float();
            if is_current {
                attr.CurrentValue = Some(value);
            } else {
                attr.BaseValue = Some(value);
            }
            return true;
        }

        if handle == HEALING_HANDLE {
            self.Healing = Some(reader.serialize_property_float());
            return true;
        }
        if handle == DAMAGE_HANDLE {
            self.Damage = Some(reader.serialize_property_float());
            return true;
        }
        if handle == SHIELD_HANDLE {
            self.Shield = Some(reader.serialize_property_float());
            return true;
        }
        false
    }
}

// ---------------------------------------------------------------------------
// OwnerExclusivePlayerInfo (+ FAresTrackedReward sub-group merge)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct OwnerExclusivePlayerInfo {
    // Inherited from FObfuscatedPlayerInformation in TS.
    pub SubjectUniqueId: Option<String>,
    pub bIsAfk: Option<bool>,
    pub ConnectionStatus: Option<u8>,
    // Own fields.
    pub AresController: Option<u32>,
    pub NumDeathStreak: Option<i32>,
    pub StartOfRoundMoneyCache: Option<i32>,
    pub StartOfRoundLoadoutValueCache: Option<i32>,
    pub EndOfRoundBeforeRewardsMoney: Option<i32>,
    pub bLoadoutFinalized: Option<bool>,
    pub bCanProgressAchievements: Option<bool>,
    pub CombatReportComponent: Option<u32>,
    pub KillStreakComponent: Option<u32>,
    pub PersonalizationComponent: Option<u32>,
    pub SprayLoadoutComponent: Option<u32>,
    pub TotemLoadoutComponent: Option<u32>,
    pub PlayerPurchaseablesComponent: Option<u32>,
    pub ExtendedCombatReportComponent: Option<u32>,
    // `TrackedRewards` (elementFactory: null) is never assigned in TS (its
    // element type isn't the group type or its base — mirrors C#
    // `ReadArrayField`'s `isGroupType` guard) — omitted, no storage needed.
    pub AllPlayersObfuscatedPlayerInformation: Option<Vec<Option<FObfuscatedPlayerInformation>>>,
    // FAresTrackedReward sub-group fields, merged onto this same object.
    pub RewardName: Option<String>,
    pub LocalizedRewardName: Option<FText>,
    pub InstancesOfReward: Option<i32>,
    pub RewardGrantStrategy: Option<u8>,
    pub Source: Option<u8>,
}
impl NetFieldModel for OwnerExclusivePlayerInfo {
    fn set_field(&mut self, key: &str, value: FieldValue) {
        match (key, value) {
            ("SubjectUniqueId", FieldValue::Str(v)) => self.SubjectUniqueId = Some(v),
            ("bIsAfk", FieldValue::Bool(v)) => self.bIsAfk = Some(v),
            ("ConnectionStatus", FieldValue::U8(v)) => self.ConnectionStatus = Some(v),
            ("AresController", FieldValue::U32(v)) => self.AresController = Some(v),
            ("NumDeathStreak", FieldValue::I32(v)) => self.NumDeathStreak = Some(v),
            ("StartOfRoundMoneyCache", FieldValue::I32(v)) => self.StartOfRoundMoneyCache = Some(v),
            ("StartOfRoundLoadoutValueCache", FieldValue::I32(v)) => {
                self.StartOfRoundLoadoutValueCache = Some(v)
            }
            ("EndOfRoundBeforeRewardsMoney", FieldValue::I32(v)) => {
                self.EndOfRoundBeforeRewardsMoney = Some(v)
            }
            ("bLoadoutFinalized", FieldValue::Bool(v)) => self.bLoadoutFinalized = Some(v),
            ("bCanProgressAchievements", FieldValue::Bool(v)) => {
                self.bCanProgressAchievements = Some(v)
            }
            ("CombatReportComponent", FieldValue::U32(v)) => self.CombatReportComponent = Some(v),
            ("KillStreakComponent", FieldValue::U32(v)) => self.KillStreakComponent = Some(v),
            ("PersonalizationComponent", FieldValue::U32(v)) => {
                self.PersonalizationComponent = Some(v)
            }
            ("SprayLoadoutComponent", FieldValue::U32(v)) => self.SprayLoadoutComponent = Some(v),
            ("TotemLoadoutComponent", FieldValue::U32(v)) => self.TotemLoadoutComponent = Some(v),
            ("PlayerPurchaseablesComponent", FieldValue::U32(v)) => {
                self.PlayerPurchaseablesComponent = Some(v)
            }
            ("ExtendedCombatReportComponent", FieldValue::U32(v)) => {
                self.ExtendedCombatReportComponent = Some(v)
            }
            ("AllPlayersObfuscatedPlayerInformation", FieldValue::Array(items)) => {
                let out = items
                    .into_iter()
                    .map(|item| match item {
                        FieldValue::Object(boxed) => boxed
                            .as_any()
                            .downcast_ref::<FObfuscatedPlayerInformation>()
                            .cloned(),
                        _ => None,
                    })
                    .collect();
                self.AllPlayersObfuscatedPlayerInformation = Some(out);
            }
            ("RewardName", FieldValue::Str(v)) => self.RewardName = Some(v),
            ("LocalizedRewardName", FieldValue::PropertyValue(boxed)) => {
                if let Some(t) = boxed.as_any().downcast_ref::<FText>() {
                    self.LocalizedRewardName = Some(t.clone());
                }
            }
            ("InstancesOfReward", FieldValue::I32(v)) => self.InstancesOfReward = Some(v),
            ("RewardGrantStrategy", FieldValue::U8(v)) => self.RewardGrantStrategy = Some(v),
            ("Source", FieldValue::U8(v)) => self.Source = Some(v),
            _ => {}
        }
    }
    fn to_export_fields(&self) -> Vec<(&'static str, FieldValue)> {
        let mut out: Vec<(&'static str, FieldValue)> = Vec::new();
        macro_rules! push_opt {
            ($field:ident, $variant:ident) => {
                if let Some(ref v) = self.$field {
                    out.push((stringify!($field), FieldValue::$variant(v.clone())));
                }
            };
        }
        push_opt!(SubjectUniqueId, Str);
        push_opt!(bIsAfk, Bool);
        push_opt!(ConnectionStatus, U8);
        push_opt!(AresController, U32);
        push_opt!(NumDeathStreak, I32);
        push_opt!(StartOfRoundMoneyCache, I32);
        push_opt!(StartOfRoundLoadoutValueCache, I32);
        push_opt!(EndOfRoundBeforeRewardsMoney, I32);
        push_opt!(bLoadoutFinalized, Bool);
        push_opt!(bCanProgressAchievements, Bool);
        push_opt!(CombatReportComponent, U32);
        push_opt!(KillStreakComponent, U32);
        push_opt!(PersonalizationComponent, U32);
        push_opt!(SprayLoadoutComponent, U32);
        push_opt!(TotemLoadoutComponent, U32);
        push_opt!(PlayerPurchaseablesComponent, U32);
        push_opt!(ExtendedCombatReportComponent, U32);
        if let Some(ref items) = self.AllPlayersObfuscatedPlayerInformation {
            out.push((
                "AllPlayersObfuscatedPlayerInformation",
                FieldValue::Array(
                    items
                        .iter()
                        .map(|item| match item {
                            Some(v) => FieldValue::Object(Box::new(v.clone())),
                            None => FieldValue::Null,
                        })
                        .collect(),
                ),
            ));
        }
        push_opt!(RewardName, Str);
        if let Some(ref t) = self.LocalizedRewardName {
            out.push((
                "LocalizedRewardName",
                FieldValue::PropertyValue(Box::new(t.clone())),
            ));
        }
        push_opt!(InstancesOfReward, I32);
        push_opt!(RewardGrantStrategy, U8);
        push_opt!(Source, U8);
        out
    }
    fn type_name(&self) -> &'static str {
        "OwnerExclusivePlayerInfo"
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ---------------------------------------------------------------------------
// RemoteCharacterUpdate (+ ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct RemoteCharacterUpdate {
    pub ShooterCharacterNetGuidValue: Option<u32>,
    pub ComponentDataStream: Option<ComponentDataStream>,
}
impl NetFieldModel for RemoteCharacterUpdate {
    fn set_field(&mut self, key: &str, value: FieldValue) {
        match (key, value) {
            ("ShooterCharacterNetGuidValue", FieldValue::U32(v)) => {
                self.ShooterCharacterNetGuidValue = Some(v)
            }
            ("ComponentDataStream", FieldValue::PropertyValue(boxed)) => {
                if let Some(cds) = boxed.as_any().downcast_ref::<ComponentDataStream>() {
                    self.ComponentDataStream = Some(cds.clone());
                }
            }
            _ => {}
        }
    }
    fn to_export_fields(&self) -> Vec<(&'static str, FieldValue)> {
        let mut out: Vec<(&'static str, FieldValue)> = Vec::new();
        if let Some(v) = self.ShooterCharacterNetGuidValue {
            out.push(("ShooterCharacterNetGuidValue", FieldValue::U32(v)));
        }
        if let Some(ref v) = self.ComponentDataStream {
            out.push((
                "ComponentDataStream",
                FieldValue::PropertyValue(Box::new(v.clone())),
            ));
        }
        out
    }
    fn type_name(&self) -> &'static str {
        "RemoteCharacterUpdate"
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// TS: `class ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous
/// extends RemoteCharacterUpdate`. Rust has no struct inheritance, so this is
/// its own struct carrying the same base fields plus its own
/// `RemoteCharacterUpdates` array — functionally identical field set to what
/// the TS subclass instance ends up with.
#[derive(Clone, Debug, Default)]
pub struct ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous {
    pub ShooterCharacterNetGuidValue: Option<u32>,
    pub ComponentDataStream: Option<ComponentDataStream>,
    pub RemoteCharacterUpdates: Option<Vec<Option<RemoteCharacterUpdate>>>,
}
impl NetFieldModel for ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous {
    fn set_field(&mut self, key: &str, value: FieldValue) {
        match (key, value) {
            ("ShooterCharacterNetGuidValue", FieldValue::U32(v)) => {
                self.ShooterCharacterNetGuidValue = Some(v)
            }
            ("ComponentDataStream", FieldValue::PropertyValue(boxed)) => {
                if let Some(cds) = boxed.as_any().downcast_ref::<ComponentDataStream>() {
                    self.ComponentDataStream = Some(cds.clone());
                }
            }
            ("RemoteCharacterUpdates", FieldValue::Array(items)) => {
                let out = items
                    .into_iter()
                    .map(|item| match item {
                        FieldValue::Object(boxed) => boxed
                            .as_any()
                            .downcast_ref::<RemoteCharacterUpdate>()
                            .cloned(),
                        _ => None,
                    })
                    .collect();
                self.RemoteCharacterUpdates = Some(out);
            }
            _ => {}
        }
    }
    fn to_export_fields(&self) -> Vec<(&'static str, FieldValue)> {
        let mut out: Vec<(&'static str, FieldValue)> = Vec::new();
        if let Some(v) = self.ShooterCharacterNetGuidValue {
            out.push(("ShooterCharacterNetGuidValue", FieldValue::U32(v)));
        }
        if let Some(ref v) = self.ComponentDataStream {
            out.push((
                "ComponentDataStream",
                FieldValue::PropertyValue(Box::new(v.clone())),
            ));
        }
        if let Some(ref items) = self.RemoteCharacterUpdates {
            out.push((
                "RemoteCharacterUpdates",
                FieldValue::Array(
                    items
                        .iter()
                        .map(|item| match item {
                            Some(v) => FieldValue::Object(Box::new(v.clone())),
                            None => FieldValue::Null,
                        })
                        .collect(),
                ),
            ));
        }
        out
    }
    fn type_name(&self) -> &'static str {
        "ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous"
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ---------------------------------------------------------------------------
// Descriptor-construction helpers (cut down on `NetFieldDescriptor { .. }`
// literal boilerplate in `register_all` below).
// ---------------------------------------------------------------------------

fn np(name: &'static str, key: &'static str, ty: RepLayoutCmdType) -> NetFieldDescriptor {
    NetFieldDescriptor {
        name: Some(name),
        handle: None,
        key,
        ty,
        minimal_parse_mode: None,
        movement: None,
        element_factory: None,
        group_element_factory: None,
        element_type: None,
    }
}

fn hp(handle: u32, key: &'static str, ty: RepLayoutCmdType) -> NetFieldDescriptor {
    NetFieldDescriptor {
        name: None,
        handle: Some(handle),
        key,
        ty,
        minimal_parse_mode: None,
        movement: None,
        element_factory: None,
        group_element_factory: None,
        element_type: None,
    }
}

fn np_prop(
    name: &'static str,
    key: &'static str,
    ty: RepLayoutCmdType,
    factory: fn() -> Box<dyn Property>,
) -> NetFieldDescriptor {
    NetFieldDescriptor {
        name: Some(name),
        handle: None,
        key,
        ty,
        minimal_parse_mode: None,
        movement: None,
        element_factory: Some(factory),
        group_element_factory: None,
        element_type: None,
    }
}

fn np_arr_group(
    name: &'static str,
    key: &'static str,
    factory: fn() -> Box<dyn NetFieldModel>,
) -> NetFieldDescriptor {
    NetFieldDescriptor {
        name: Some(name),
        handle: None,
        key,
        ty: RepLayoutCmdType::DynamicArray,
        minimal_parse_mode: None,
        movement: None,
        element_factory: None,
        group_element_factory: Some(factory),
        element_type: None,
    }
}

fn np_arr_prim(
    name: &'static str,
    key: &'static str,
    element_type: RepLayoutCmdType,
) -> NetFieldDescriptor {
    NetFieldDescriptor {
        name: Some(name),
        handle: None,
        key,
        ty: RepLayoutCmdType::DynamicArray,
        minimal_parse_mode: None,
        movement: None,
        element_factory: None,
        group_element_factory: None,
        element_type: Some(element_type),
    }
}

/// `elementFactory: null` — array field consumed but never assigned (element
/// type is neither the group type nor its base; mirrors C# `ReadArrayField`'s
/// `isGroupType` guard). See `OwnerExclusivePlayerInfo.TrackedRewards` in
/// `models.ts`.
fn np_arr_ignored(name: &'static str, key: &'static str) -> NetFieldDescriptor {
    NetFieldDescriptor {
        name: Some(name),
        handle: None,
        key,
        ty: RepLayoutCmdType::DynamicArray,
        minimal_parse_mode: None,
        movement: None,
        element_factory: None,
        group_element_factory: None,
        element_type: None,
    }
}

const PN: ParseMode = ParseMode::Normal;
const PF: ParseMode = ParseMode::Full;

/// Registers every Valorant net-field export group / class-net-cache /
/// player-controller path into `registry`. Explicit call replacing TS's
/// "importing `models.ts` populates the registry as a side effect" — the
/// valorant reader constructor calls this once right after
/// `NetFieldRegistry::new()`.
pub fn register_all(registry: &mut NetFieldRegistry) {
    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.AresAttributeSet",
        minimal_parse_mode: PN,
        factory: || Box::new(AresAttributeSet::default()),
        uses_handles: true,
        properties: vec![],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Game/Characters/_Core/BaseReplayController.BaseReplayController_C",
        minimal_parse_mode: PN,
        factory: || Box::new(BaseReplayController::default()),
        uses_handles: true,
        properties: vec![
            hp(3, "RemoteRole", RepLayoutCmdType::Ignore),
            hp(12, "Role", RepLayoutCmdType::Ignore),
            hp(14, "PlayerState", RepLayoutCmdType::PropertyObject),
            hp(18, "SpawnLocation", RepLayoutCmdType::PropertyVector),
        ],
        sub_group_of: None,
    });
    registry.register_player_controller("BaseReplayController_C");

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Game/GameModes/Common/BaseReplayPlayerState.BaseReplayPlayerState_C",
        minimal_parse_mode: PN,
        factory: || Box::new(BaseReplayPlayerState::default()),
        uses_handles: false,
        properties: vec![
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("Owner", "Owner", RepLayoutCmdType::Ignore),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            np(
                "bOnlySpectator",
                "bOnlySpectator",
                RepLayoutCmdType::PropertyBool,
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.AbilityTrackingDelegateComponent",
        minimal_parse_mode: PN,
        factory: || Box::new(AbilityTrackingDelegateComponent::default()),
        uses_handles: false,
        properties: vec![np(
            "AbilityTrackingComponent",
            "AbilityTrackingComponent",
            RepLayoutCmdType::PropertyObject,
        )],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.AresWorldSettings",
        minimal_parse_mode: PN,
        factory: || Box::new(AresWorldSettings::default()),
        uses_handles: false,
        properties: vec![
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            np(
                "WorldGravityZ",
                "WorldGravityZ",
                RepLayoutCmdType::PropertyFloat,
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.StealthComponent",
        minimal_parse_mode: PN,
        factory: || Box::new(StealthComponent::default()),
        uses_handles: false,
        properties: vec![
            np("bReplicates", "bReplicates", RepLayoutCmdType::PropertyBool),
            np(
                "bStealthIsActive",
                "bStealthIsActive",
                RepLayoutCmdType::PropertyBool,
            ),
            np(
                "SubscribedToComponent",
                "SubscribedToComponent",
                RepLayoutCmdType::PropertyObject,
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Game/GameModes/Bomb/TimedBomb.TimedBomb_C",
        minimal_parse_mode: PN,
        factory: || Box::new(TimedBomb::default()),
        uses_handles: false,
        properties: vec![
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            np(
                "TimeRemainingToExplode",
                "TimeRemainingToExplode",
                RepLayoutCmdType::PropertyFloat,
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.EquippableStateMachineComponent",
        minimal_parse_mode: PN,
        factory: || Box::new(EquippableStateMachineComponent::default()),
        uses_handles: false,
        properties: vec![
            np("CurrentState", "CurrentState", RepLayoutCmdType::Ignore),
            np(
                "TransitionContext",
                "TransitionContext",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "AuthStartWorldTime",
                "AuthStartWorldTime",
                RepLayoutCmdType::PropertyFloat,
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.EquipmentChargeComponent",
        minimal_parse_mode: PN,
        factory: || Box::new(EquipmentChargeComponent::default()),
        uses_handles: false,
        properties: vec![np(
            "AuthResourceAmount",
            "AuthResourceAmount",
            RepLayoutCmdType::PropertyFloat,
        )],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.PurchasedItemComponent",
        minimal_parse_mode: PN,
        factory: || Box::new(PurchasedItemComponent::default()),
        uses_handles: false,
        properties: vec![
            np("Purchaseable", "Purchaseable", RepLayoutCmdType::Ignore),
            np(
                "bIsCurrentSessionPurchase",
                "bIsCurrentSessionPurchase",
                RepLayoutCmdType::PropertyBool,
            ),
            np(
                "PurchasingPlayerState",
                "PurchasingPlayerState",
                RepLayoutCmdType::PropertyObject,
            ),
            np(
                "PurchasableTransactionSource",
                "PurchasableTransactionSource",
                RepLayoutCmdType::Ignore,
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.UsableComponent",
        minimal_parse_mode: PN,
        factory: || Box::new(UsableComponent::default()),
        uses_handles: false,
        properties: vec![np("bIsActive", "bIsActive", RepLayoutCmdType::PropertyBool)],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.BombTeamComponent",
        minimal_parse_mode: PF,
        factory: || Box::new(BombTeamComponent::default()),
        uses_handles: false,
        properties: vec![np("Team", "Team", RepLayoutCmdType::Enum)],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Game/GameModes/Bomb/BombGameState.BombGameState_C",
        minimal_parse_mode: PN,
        factory: || Box::new(BombGameState::default()),
        uses_handles: false,
        properties: vec![
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            np("GameModeClass", "GameModeClass", RepLayoutCmdType::Ignore),
            np("SpectatorClass", "SpectatorClass", RepLayoutCmdType::Ignore),
            np("PlayerArray", "PlayerArray", RepLayoutCmdType::Ignore),
            np(
                "bReplicatedHasBegunPlay",
                "bReplicatedHasBegunPlay",
                RepLayoutCmdType::PropertyBool,
            ),
            np(
                "ReplicatedWorldTimeSecondsDouble",
                "ReplicatedWorldTimeSecondsDouble",
                RepLayoutCmdType::PropertyDouble,
            ),
            np("MatchState", "MatchState", RepLayoutCmdType::Ignore),
            np(
                "bBotDesiredCharactersReady",
                "bBotDesiredCharactersReady",
                RepLayoutCmdType::PropertyBool,
            ),
            np(
                "bShouldPerformanceInstabilityTrackingBeEnabled",
                "bShouldPerformanceInstabilityTrackingBeEnabled",
                RepLayoutCmdType::PropertyBool,
            ),
            np("TeamEconomy", "TeamEconomy", RepLayoutCmdType::Ignore),
            np("TeamComponents", "TeamComponents", RepLayoutCmdType::Ignore),
            np("Phase", "Phase", RepLayoutCmdType::Ignore),
            np(
                "DisplayRemainingTime",
                "DisplayRemainingTime",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "StateRemainingTime",
                "StateRemainingTime",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "GamePhaseElapsedTime",
                "GamePhaseElapsedTime",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "NetServerMaxTickRate",
                "NetServerMaxTickRate",
                RepLayoutCmdType::Ignore,
            ),
            np("MatchID", "MatchID", RepLayoutCmdType::Ignore),
            np(
                "GameStateHUDConfig",
                "GameStateHUDConfig",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "AllowedVoteTypes",
                "AllowedVoteTypes",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "ModifierManager",
                "ModifierManager",
                RepLayoutCmdType::Ignore,
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.OwnerExclusivePlayerInfo",
        minimal_parse_mode: PN,
        factory: || Box::new(OwnerExclusivePlayerInfo::default()),
        uses_handles: false,
        properties: vec![
            np(
                "SubjectUniqueId",
                "SubjectUniqueId",
                RepLayoutCmdType::PropertyNetId,
            ),
            np("bIsAfk", "bIsAfk", RepLayoutCmdType::PropertyBool),
            np(
                "ConnectionStatus",
                "ConnectionStatus",
                RepLayoutCmdType::Enum,
            ),
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("Owner", "Owner", RepLayoutCmdType::Ignore),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            np(
                "AresController",
                "AresController",
                RepLayoutCmdType::PropertyObject,
            ),
            np(
                "NumDeathStreak",
                "NumDeathStreak",
                RepLayoutCmdType::PropertyInt,
            ),
            np(
                "StartOfRoundMoneyCache",
                "StartOfRoundMoneyCache",
                RepLayoutCmdType::PropertyInt,
            ),
            np(
                "StartOfRoundLoadoutValueCache",
                "StartOfRoundLoadoutValueCache",
                RepLayoutCmdType::PropertyInt,
            ),
            np_arr_ignored("TrackedRewards", "TrackedRewards"),
            np(
                "EndOfRoundBeforeRewardsMoney",
                "EndOfRoundBeforeRewardsMoney",
                RepLayoutCmdType::PropertyInt,
            ),
            np(
                "bLoadoutFinalized",
                "bLoadoutFinalized",
                RepLayoutCmdType::PropertyBool,
            ),
            np(
                "bCanProgressAchievements",
                "bCanProgressAchievements",
                RepLayoutCmdType::PropertyBool,
            ),
            np(
                "CombatReportComponent",
                "CombatReportComponent",
                RepLayoutCmdType::PropertyObject,
            ),
            np(
                "KillStreakComponent",
                "KillStreakComponent",
                RepLayoutCmdType::PropertyObject,
            ),
            np(
                "PersonalizationComponent",
                "PersonalizationComponent",
                RepLayoutCmdType::PropertyObject,
            ),
            np(
                "SprayLoadoutComponent",
                "SprayLoadoutComponent",
                RepLayoutCmdType::PropertyObject,
            ),
            np(
                "TotemLoadoutComponent",
                "TotemLoadoutComponent",
                RepLayoutCmdType::PropertyObject,
            ),
            np(
                "PlayerPurchaseablesComponent",
                "PlayerPurchaseablesComponent",
                RepLayoutCmdType::PropertyObject,
            ),
            np(
                "ExtendedCombatReportComponent",
                "ExtendedCombatReportComponent",
                RepLayoutCmdType::PropertyObject,
            ),
            np_arr_group(
                "AllPlayersObfuscatedPlayerInformation",
                "AllPlayersObfuscatedPlayerInformation",
                || Box::new(FObfuscatedPlayerInformation::default()),
            ),
        ],
        sub_group_of: None,
    });
    registry.register_sub_group(
        "/Script/ShooterGame.OwnerExclusivePlayerInfo",
        vec![
            np("Rewards", "Rewards", RepLayoutCmdType::Ignore),
            np("RewardName", "RewardName", RepLayoutCmdType::PropertyName),
            np_prop(
                "LocalizedRewardName",
                "LocalizedRewardName",
                RepLayoutCmdType::Property,
                || Box::new(FText::default()),
            ),
            np(
                "InstancesOfReward",
                "InstancesOfReward",
                RepLayoutCmdType::PropertyInt,
            ),
            np(
                "RewardGrantStrategy",
                "RewardGrantStrategy",
                RepLayoutCmdType::Enum,
            ),
            np("Source", "Source", RepLayoutCmdType::Enum),
        ],
    );

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.AresAbilitySystemComponent",
        minimal_parse_mode: PN,
        factory: || Box::new(AresAbilitySystemComponent::default()),
        uses_handles: false,
        properties: vec![
            np("OwnerActor", "OwnerActor", RepLayoutCmdType::PropertyObject),
            np(
                "AvatarActor",
                "AvatarActor",
                RepLayoutCmdType::PropertyObject,
            ),
            np("Def", "Def", RepLayoutCmdType::Ignore),
            np(
                "ModifiedAttributes",
                "ModifiedAttributes",
                RepLayoutCmdType::Ignore,
            ),
            np("Duration", "Duration", RepLayoutCmdType::PropertyFloat),
            np("Period", "Period", RepLayoutCmdType::PropertyFloat),
            np(
                "ChanceToApplyToTarget",
                "ChanceToApplyToTarget",
                RepLayoutCmdType::PropertyFloat,
            ),
            np(
                "DynamicGrantedTags",
                "DynamicGrantedTags",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "DynamicAssetTags",
                "DynamicAssetTags",
                RepLayoutCmdType::Ignore,
            ),
            np("Modifiers", "Modifiers", RepLayoutCmdType::Ignore),
            np(
                "EvaluatedMagnitude",
                "EvaluatedMagnitude",
                RepLayoutCmdType::Ignore,
            ),
            np("StackCount", "StackCount", RepLayoutCmdType::PropertyInt),
            np(
                "GrantedAbilitySpecs",
                "GrantedAbilitySpecs",
                RepLayoutCmdType::Ignore,
            ),
            np("EffectContext", "EffectContext", RepLayoutCmdType::Ignore),
            np("Level", "Level", RepLayoutCmdType::PropertyFloat),
            np("PredictionKey", "PredictionKey", RepLayoutCmdType::Ignore),
            np(
                "GrantedAbilityHandles",
                "GrantedAbilityHandles",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "StartServerWorldTime",
                "StartServerWorldTime",
                RepLayoutCmdType::PropertyFloat,
            ),
            np(
                "SpawnedAttributes",
                "SpawnedAttributes",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "CachedAttributeSet",
                "CachedAttributeSet",
                RepLayoutCmdType::PropertyObject,
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Game/Characters/Gumshoe/S0/Ability_E/Ability_Gumshoe_E_TripWire.Ability_Gumshoe_E_TripWire_C",
        minimal_parse_mode: PN,
        factory: || Box::new(Ability_Gumshoe_E_TripWire::default()),
        uses_handles: false,
        properties: vec![
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("AttachParent", "AttachParent", RepLayoutCmdType::PropertyObject),
            np("RelativeScale3D", "RelativeScale3D", RepLayoutCmdType::PropertyVector100),
            np("AttachComponent", "AttachComponent", RepLayoutCmdType::PropertyObject),
            np("Owner", "Owner", RepLayoutCmdType::PropertyObject),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            np("Instigator", "Instigator", RepLayoutCmdType::PropertyObject),
            np("CosmeticRandomSeed", "CosmeticRandomSeed", RepLayoutCmdType::PropertyInt),
            np("CreatedByCharacter", "CreatedByCharacter", RepLayoutCmdType::PropertyObject),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Game/Characters/Gumshoe/S0/Ability_E/GameObject_Gumshoe_E_TripWire.GameObject_Gumshoe_E_TripWire_C",
        minimal_parse_mode: PN,
        factory: || Box::new(GameObject_Gumshoe_E_TripWire::default()),
        uses_handles: false,
        properties: vec![
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("Owner", "Owner", RepLayoutCmdType::PropertyObject),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            np("Instigator", "Instigator", RepLayoutCmdType::PropertyObject),
            np("Deployed", "Deployed", RepLayoutCmdType::PropertyBool),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Game/Characters/Gumshoe/S0/Ability_E/GameObject_Gumshoe_E_TripWire_SecondWire.GameObject_Gumshoe_E_TripWire_SecondWire_C",
        minimal_parse_mode: PN,
        factory: || Box::new(GameObject_Gumshoe_E_TripWire_SecondWire::default()),
        uses_handles: false,
        properties: vec![
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("Owner", "Owner", RepLayoutCmdType::PropertyObject),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            np("Instigator", "Instigator", RepLayoutCmdType::PropertyObject),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.RemoteCharacterUpdate",
        minimal_parse_mode: PN,
        factory: || Box::new(RemoteCharacterUpdate::default()),
        uses_handles: false,
        properties: vec![
            np(
                "ShooterCharacterNetGuidValue",
                "ShooterCharacterNetGuidValue",
                RepLayoutCmdType::PropertyUInt32,
            ),
            np_prop(
                "ComponentDataStream",
                "ComponentDataStream",
                RepLayoutCmdType::Property,
                || Box::new(ComponentDataStream::default()),
            ),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.ReplayPlayerController:ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous",
        minimal_parse_mode: PN,
        factory: || Box::new(ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous::default()),
        uses_handles: false,
        properties: vec![
            np("ShooterCharacterNetGuidValue", "ShooterCharacterNetGuidValue", RepLayoutCmdType::PropertyUInt32),
            np_prop("ComponentDataStream", "ComponentDataStream", RepLayoutCmdType::Property, || {
                Box::new(ComponentDataStream::default())
            }),
            np_arr_group("RemoteCharacterUpdates", "RemoteCharacterUpdates", || Box::new(RemoteCharacterUpdate::default())),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.AresPlayerController:ClientGamePhaseEnded",
        minimal_parse_mode: PN,
        factory: || Box::new(ClientGamePhaseEnded::default()),
        uses_handles: false,
        properties: vec![np("OldPhase", "OldPhase", RepLayoutCmdType::Enum)],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.ReplayPlayerController:ClientReplayReceiveInputEventProcessingCapture",
        minimal_parse_mode: PN,
        factory: || Box::new(ClientReplayReceiveInputEventProcessingCapture::default()),
        uses_handles: false,
        properties: vec![
            np("PlayerID", "PlayerID", RepLayoutCmdType::PropertyInt),
            np_arr_prim("InputEventData", "InputEventData", RepLayoutCmdType::PropertyByte),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.LocationalEffectManagerComponent:ClientCleanUpLocationalEffects",
        minimal_parse_mode: PN,
        factory: || Box::new(ClientCleanUpLocationalEffects::default()),
        uses_handles: false,
        properties: vec![],
        sub_group_of: None,
    });
    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.LocationalEffectManagerComponent:ClientPlayOneShotEffectAtLocation",
        minimal_parse_mode: PN,
        factory: || Box::new(ClientPlayOneShotEffectAtLocation::default()),
        uses_handles: false,
        properties: vec![],
        sub_group_of: None,
    });
    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.ReplayEffectComponent",
        minimal_parse_mode: PN,
        factory: || Box::new(ReplayPlayContinuousEffectAtLocation::default()),
        uses_handles: false,
        properties: vec![],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Script/ShooterGame.AresEquippable:MulticastPlayContinuousEffectFromClient",
        minimal_parse_mode: PN,
        factory: || Box::new(MulticastPlayContinuousEffectFromClient::default()),
        uses_handles: false,
        properties: vec![
            np(
                "EffectManagerComponent",
                "EffectManagerComponent",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "EffectContainer",
                "EffectContainer",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "WaitOnReplicationActor",
                "WaitOnReplicationActor",
                RepLayoutCmdType::Ignore,
            ),
            np("ObjectValues", "ObjectValues", RepLayoutCmdType::Ignore),
            np("Name", "Name", RepLayoutCmdType::Ignore),
            np("Object", "Object", RepLayoutCmdType::Ignore),
            // Both named "Translation" — last-registered wins (see
            // `find_descriptor`'s doc comment); `Rotation`/`PropertyQuat` is
            // registered first and is therefore dead/unreachable, exactly
            // like the TS source.
            np_prop(
                "Translation",
                "Rotation",
                RepLayoutCmdType::PropertyQuat,
                || Box::new(QuatProperty::default()),
            ),
            np(
                "Translation",
                "Translation",
                RepLayoutCmdType::PropertyVector,
            ),
            np("Scale3D", "Scale3D", RepLayoutCmdType::PropertyVector),
            np("EffectID", "EffectID", RepLayoutCmdType::PropertyUInt64),
            np("SourceID", "SourceID", RepLayoutCmdType::PropertyString),
            np(
                "bLocalEffect",
                "bLocalEffect",
                RepLayoutCmdType::PropertyBool,
            ),
            // Both named "StartMovementTime" — same last-wins rule; only the
            // second (PropertyFloat/StartMovementTime) is reachable.
            np(
                "StartMovementTime",
                "ClientControllerThatTriggered",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "StartMovementTime",
                "StartMovementTime",
                RepLayoutCmdType::PropertyFloat,
            ),
            np("AllianceFilter", "AllianceFilter", RepLayoutCmdType::Enum),
        ],
        sub_group_of: None,
    });

    registry.register_group(NetFieldExportGroupDescriptor {
        path: "/Game/GameModes/Bomb/BombPlayerState.BombPlayerState_C",
        minimal_parse_mode: PN,
        factory: || Box::new(BombPlayerState::default()),
        uses_handles: true,
        properties: vec![
            np("RemoteRole", "RemoteRole", RepLayoutCmdType::Ignore),
            np("Owner", "Owner", RepLayoutCmdType::Ignore),
            np("Role", "Role", RepLayoutCmdType::Ignore),
            hp(14, "PlayerId", RepLayoutCmdType::PropertyInt),
            hp(15, "Ping", RepLayoutCmdType::PropertyUInt16),
            hp(20, "UniqueId", RepLayoutCmdType::Ignore),
            hp(22, "CompetitiveTier", RepLayoutCmdType::PropertyInt),
            np("Subject", "Subject", RepLayoutCmdType::Ignore),
            np("PlayerInfo", "PlayerInfo", RepLayoutCmdType::Ignore),
            np(
                "PlayerMatchStatsComponent",
                "PlayerMatchStatsComponent",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "PlayerScoreComponent",
                "PlayerScoreComponent",
                RepLayoutCmdType::Ignore,
            ),
            np(
                "AFKDetectionComponent",
                "AFKDetectionComponent",
                RepLayoutCmdType::Ignore,
            ),
            hp(197, "ProfileName", RepLayoutCmdType::PropertyString),
        ],
        sub_group_of: None,
    });

    // ---- Class net caches (RPC function dispatch) ----

    registry.register_class_net_cache(ClassNetCacheDescriptor {
        path: "BasePistol_C_ClassNetCache",
        minimal_parse_mode: PN,
        properties: vec![ClassNetCacheProperty {
            name: "MulticastPlayContinuousEffectFromClient",
            path_name: "/Script/ShooterGame.AresEquippable:MulticastPlayContinuousEffectFromClient",
            is_function: true,
            enable_property_checksum: true,
            is_custom_struct: false,
            property_factory: None,
        }],
    });

    registry.register_class_net_cache(ClassNetCacheDescriptor {
        path: "BaseReplayController_C_ClassNetCache",
        minimal_parse_mode: PF,
        properties: vec![
            ClassNetCacheProperty {
                name: "ClientReplayReceiveInputEventProcessingCapture",
                path_name: "/Script/ShooterGame.ReplayPlayerController:ClientReplayReceiveInputEventProcessingCapture",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
            ClassNetCacheProperty {
                name: "ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous",
                path_name: "/Script/ShooterGame.ReplayPlayerController:ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
            ClassNetCacheProperty {
                name: "ClientGamePhaseBegin",
                path_name: "/Script/ShooterGame.AresPlayerController:ClientGamePhaseBegin",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
            ClassNetCacheProperty {
                name: "ClientGamePhaseEnded",
                path_name: "/Script/ShooterGame.AresPlayerController:ClientGamePhaseEnded",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
            ClassNetCacheProperty {
                name: "ClientOnWinningTeam",
                path_name: "/Script/ShooterGame.AresPlayerController:ClientOnWinningTeam",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
            ClassNetCacheProperty {
                name: "ClientFlushLevelStreaming",
                path_name: "/Script/Engine.PlayerController:ClientFlushLevelStreaming",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
            ClassNetCacheProperty {
                name: "ClientUpdateMultipleLevelsStreamingStatus",
                path_name: "/Script/Engine.PlayerController:ClientUpdateMultipleLevelsStreamingStatus",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
        ],
    });

    registry.register_class_net_cache(ClassNetCacheDescriptor {
        path: "LocationalEffectManagerComponent_ClassNetCache",
        minimal_parse_mode: PN,
        properties: vec![
            ClassNetCacheProperty {
                name: "ClientCleanUpLocationalEffects",
                path_name: "/Script/ShooterGame.LocationalEffectManagerComponent:ClientCleanUpLocationalEffects",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
            ClassNetCacheProperty {
                name: "ClientPlayOneShotEffectAtLocation",
                path_name: "/Script/ShooterGame.LocationalEffectManagerComponent:ClientPlayOneShotEffectAtLocation",
                is_function: true,
                enable_property_checksum: true,
                is_custom_struct: false,
                property_factory: None,
            },
        ],
    });

    registry.register_class_net_cache(ClassNetCacheDescriptor {
        path: "ReplayEffectComponent_ClassNetCache",
        minimal_parse_mode: PN,
        properties: vec![ClassNetCacheProperty {
            name: "ReplayPlayContinuousEffectAtLocation",
            path_name: "/Script/ShooterGame.ReplayEffectComponent",
            is_function: true,
            enable_property_checksum: true,
            is_custom_struct: false,
            property_factory: None,
        }],
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registered() -> NetFieldRegistry {
        let mut r = NetFieldRegistry::new();
        register_all(&mut r);
        r
    }

    /// Port of `models.test.ts` — checks registry *structure*, not parsed
    /// field values (models.test.ts itself never inspects field values,
    /// only `registry.groups`/`classNetCaches`/`playerControllerPaths`).
    #[test]
    fn registers_export_groups() {
        // 23+ group/sub-group classes carry [NetFieldExportGroup] in the C# source.
        assert!(registered().groups.len() >= 20);
    }

    #[test]
    fn registers_class_net_caches() {
        assert_eq!(registered().class_net_caches.len(), 4);
    }

    #[test]
    fn registers_the_player_controller() {
        assert!(registered()
            .player_controller_paths
            .contains("BaseReplayController_C"));
    }

    #[test]
    fn registers_handle_based_groups() {
        let r = registered();
        assert!(
            r.groups
                .get("/Script/ShooterGame.AresAttributeSet")
                .unwrap()
                .uses_handles
        );
        assert!(
            r.groups
                .get("/Game/Characters/_Core/BaseReplayController.BaseReplayController_C")
                .unwrap()
                .uses_handles
        );
    }

    #[test]
    fn merges_sub_group_properties_into_the_parent() {
        let r = registered();
        let parent = r
            .groups
            .get("/Script/ShooterGame.OwnerExclusivePlayerInfo")
            .unwrap();
        assert!(parent
            .properties
            .iter()
            .any(|p| p.name == Some("RewardName")));
    }
}
