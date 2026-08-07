//! NetFieldParser — reads replicated properties into registered model objects.
//! Ported from `package/ts-replay-parser/src/unreal/net-field-parser.ts`, but
//! registry-driven instead of reflection-driven (models register descriptors;
//! see `registry.rs`).
//!
//! # Deviation from the TS structure (and from the phase-brief sketch)
//!
//! TS's `NetFieldParser` stores `guidCache`/`registry` as constructor-injected
//! fields (trivial in JS, since both are GC'd reference types shared freely),
//! and precomputes `nameLookup`/`handleLookup` maps keyed by group path at
//! construction time for O(1) per-field lookup.
//!
//! In Rust, `NetFieldParser` would need to either (a) own `NetGuidCache`
//! itself (wrong — `ReplayReader` owns it and mutates it elsewhere too), or
//! (b) hold borrowed references with a lifetime tied to the registry/cache,
//! which makes it self-referential with `ReplayReader` (which needs to own
//! both the registry and the parser together). Both are awkward for a
//! straightforward port, so this version:
//! - stores only `mode: ParseMode` (no `guidCache`/`registry` fields),
//! - takes `&NetFieldRegistry` (and `&NetGuidCache` where relevant) as an
//!   explicit parameter on every method that needs it,
//! - performs the name/handle lookup + `minimalParseMode` filtering on demand
//!   inside `read_field` rather than pre-caching it in a constructor.
//!
//! This trades the TS version's O(1) precomputed lookup for a linear scan
//! over a group's (typically small) property list on each field read —
//! acceptable for a research-grade parser port, and it sidesteps all
//! self-referential-struct/lifetime issues entirely.

use crate::replay::io::farchive::{FArchive, SeekOrigin};
use crate::replay::io::enums::VectorQuantization;
use crate::replay::io::net_bit_reader::NetBitReader;

use super::enums::{FBitArchiveEndIndex, ParseMode, RepLayoutCmdType};
use super::models::{FieldValue, NetFieldExport, NetFieldExportGroup, NetFieldModel, Property};
use super::net_guid_cache::NetGuidCache;
use super::registry::{NetFieldDescriptor, NetFieldExportGroupDescriptor, NetFieldRegistry};

pub struct NetFieldParser {
    mode: ParseMode,
}

impl NetFieldParser {
    pub fn new(mode: ParseMode) -> Self {
        NetFieldParser { mode }
    }

    pub fn player_controller_groups<'r>(&self, registry: &'r NetFieldRegistry) -> &'r std::collections::HashSet<&'static str> {
        &registry.player_controller_paths
    }

    pub fn will_read_type(&self, registry: &NetFieldRegistry, group: &str) -> bool {
        match registry.groups.get(group) {
            Some(desc) => desc.minimal_parse_mode <= self.mode,
            None => false,
        }
    }

    pub fn will_read_class_net_cache(&self, registry: &NetFieldRegistry, group: &str) -> bool {
        match registry.class_net_caches.get(group) {
            Some(desc) => desc.minimal_parse_mode <= self.mode,
            None => false,
        }
    }

    pub fn try_get_class_net_cache_property<'r>(
        &self,
        registry: &'r NetFieldRegistry,
        property: &str,
        group: &str,
    ) -> Option<&'r super::registry::ClassNetCacheProperty> {
        let group_info = registry.class_net_caches.get(group)?;
        group_info.properties.iter().find(|p| p.name == property)
    }

    pub fn create_type(&self, registry: &NetFieldRegistry, group: &str) -> Option<Box<dyn NetFieldModel>> {
        let desc = registry.groups.get(group)?;
        Some((desc.factory)())
    }

    pub fn create_property_type(&self, registry: &NetFieldRegistry, group: &str, property_name: &str) -> Option<Box<dyn Property>> {
        let group_info = registry.class_net_caches.get(group)?;
        let prop = group_info.properties.iter().find(|p| p.name == property_name)?;
        prop.property_factory.map(|f| f())
    }

    /// Find the descriptor for `handle` (handle-mode groups) or `export_field.Name`
    /// (name-mode groups), honoring `minimalParseMode` gating exactly like the
    /// TS constructor's precomputation did (`p.minimalParseMode !== undefined && p.minimalParseMode > mode` => skip).
    ///
    /// **Last-match-wins** (bisected bug fix, not in the phase brief's
    /// sketch): TS precomputes `nameLookup`/`handleLookup` as `Map`s built by
    /// iterating `group.properties` in order and calling `.set(key, p)` for
    /// each — a later property with the same `name`/`handle` silently
    /// overwrites an earlier one in the map. `models.ts` actually relies on
    /// this for a couple of groups (`MulticastPlayContinuousEffectFromClient`
    /// registers two properties both named `"Translation"` — one keyed
    /// `Rotation`/`PropertyQuat`, one keyed `Translation`/`PropertyVector` —
    /// and two both named `"StartMovementTime"`); only the *last* one is ever
    /// reachable at runtime. A plain `.find()` (first match) would resolve
    /// the wrong descriptor and desync the bit stream for every field read
    /// after it, so this scans in reverse to reproduce "last registered
    /// wins".
    fn find_descriptor<'r>(
        &self,
        group_desc: &'r NetFieldExportGroupDescriptor,
        uses_handles: bool,
        handle: u32,
        export_field_name: &str,
    ) -> Option<&'r NetFieldDescriptor> {
        group_desc.properties.iter().rev().find(|p| {
            if let Some(min_mode) = p.minimal_parse_mode {
                if min_mode > self.mode {
                    return false;
                }
            }
            if uses_handles {
                p.handle == Some(handle)
            } else {
                p.name == Some(export_field_name)
            }
        })
    }

    /// Read one field into the export object. Returns `false` if unparseable.
    ///
    /// `obj` is generic over anything implementing both [`NetFieldModel`] (for
    /// `set_field`) and, optionally, [`super::models::HandleNetFieldExportGroup`]
    /// for the `readFieldHandle` short-circuit — TS checks this via a runtime
    /// `typeof obj.readFieldHandle === "function"` duck-type probe, which has
    /// no direct static-typing equivalent, so we expose a separate
    /// `read_field_with_handle_hook` entry point that callers (`replay_reader.rs`)
    /// use when the concrete type is known to implement the handle hook, and
    /// this plain `read_field` otherwise. `replay_reader.rs` in this phase has
    /// no concrete `NetFieldModel` implementers yet (that's the valorant
    /// phase), so it always goes through the "no handle hook" path — see that
    /// file's `receive_properties`/`read_array_field`-equivalent call sites.
    pub fn read_field(
        &self,
        registry: &NetFieldRegistry,
        obj: &mut dyn NetFieldModel,
        export_field: &NetFieldExport,
        handle: u32,
        export_group: &NetFieldExportGroup,
        reader: &mut NetBitReader,
        guid_cache: &NetGuidCache,
    ) -> bool {
        let group_desc = match registry.groups.get(export_group.PathName.as_str()) {
            Some(d) => d,
            None => return false,
        };
        self.read_field_into(obj, export_field, handle, export_group, group_desc, reader, guid_cache)
    }

    /// Shared body of [`Self::read_field`], factored out so
    /// [`Self::read_array_field`] can recurse onto a group-type array
    /// element using the *same* group descriptor as the parent (mirrors TS
    /// `readArrayField`'s `this.readField(data, exportField, handle,
    /// exportGroup, reader)` — it passes the outer `exportGroup`/descriptor
    /// unchanged for nested handle/name lookups, it does not look up a
    /// separate registry entry for the element's own type).
    fn read_field_into(
        &self,
        obj: &mut dyn NetFieldModel,
        export_field: &NetFieldExport,
        handle: u32,
        export_group: &NetFieldExportGroup,
        group_desc: &NetFieldExportGroupDescriptor,
        reader: &mut NetBitReader,
        guid_cache: &NetGuidCache,
    ) -> bool {
        // IHandleNetFieldExportGroup: let the object consume the field
        // directly (tried unconditionally, before the normal lookup —
        // matches TS `readField`'s ordering).
        if obj.read_field_handle(handle, reader) {
            return true;
        }

        let field_desc = match self.find_descriptor(group_desc, group_desc.uses_handles, handle, &export_field.Name) {
            Some(d) => d,
            None => return false,
        };

        self.set_type(obj, field_desc, guid_cache, export_group, group_desc, reader);
        true
    }

    fn set_type(
        &self,
        obj: &mut dyn NetFieldModel,
        field_info: &NetFieldDescriptor,
        guid_cache: &NetGuidCache,
        export_group: &NetFieldExportGroup,
        group_desc: &NetFieldExportGroupDescriptor,
        reader: &mut NetBitReader,
    ) {
        let data: Option<FieldValue> = if field_info.ty == RepLayoutCmdType::DynamicArray {
            self.read_array_field(export_group, field_info, group_desc, reader, guid_cache)
        } else if field_info.ty == RepLayoutCmdType::RepMovement {
            let rm = if let Some(spec) = field_info.movement {
                reader.serialize_rep_movement(spec.location, spec.rotation, spec.velocity)
            } else {
                reader.serialize_rep_movement(
                    VectorQuantization::default(),
                    Default::default(),
                    VectorQuantization::default(),
                )
            };
            Some(FieldValue::RepMovement(rm))
        } else {
            self.read_data_type(field_info.ty, reader, field_info.element_factory, guid_cache)
        };

        if let Some(value) = data {
            if !reader.archive_state().IsError {
                obj.set_field(field_info.key, value);
            }
        }
    }

    fn read_data_type(
        &self,
        replayout: RepLayoutCmdType,
        reader: &mut NetBitReader,
        element_factory: Option<fn() -> Box<dyn Property>>,
        guid_cache: &NetGuidCache,
    ) -> Option<FieldValue> {
        match replayout {
            RepLayoutCmdType::Property => {
                let mut data = element_factory.map(|f| f())?;
                data.serialize(reader);
                data.resolve(guid_cache);
                Some(FieldValue::PropertyValue(data))
            }
            RepLayoutCmdType::PropertyBool => Some(FieldValue::Bool(reader.serialize_property_bool())),
            RepLayoutCmdType::PropertyName => Some(FieldValue::Str(reader.serialize_property_name())),
            RepLayoutCmdType::PropertyFloat => Some(FieldValue::F32(reader.serialize_property_float())),
            RepLayoutCmdType::PropertyDouble => Some(FieldValue::F64(reader.serialize_property_double())),
            RepLayoutCmdType::PropertyNativeBool => Some(FieldValue::Bool(reader.serialize_property_native_bool())),
            RepLayoutCmdType::PropertyNetId => Some(FieldValue::Str(reader.serialize_property_net_id())),
            RepLayoutCmdType::PropertyObject => Some(FieldValue::U32(reader.serialize_property_object())),
            RepLayoutCmdType::PropertyRotator => Some(FieldValue::Rotator(reader.serialize_property_rotator())),
            RepLayoutCmdType::PropertyString => Some(FieldValue::Str(reader.serialize_property_string())),
            RepLayoutCmdType::PropertyVector10 => Some(FieldValue::Vector(reader.serialize_property_vector10())),
            RepLayoutCmdType::PropertyVector100 => Some(FieldValue::Vector(reader.serialize_property_vector100())),
            RepLayoutCmdType::PropertyVectorNormal => Some(FieldValue::Vector(reader.serialize_property_vector_normal())),
            RepLayoutCmdType::PropertyVectorQ => {
                Some(FieldValue::Vector(reader.serialize_property_quantized_vector(VectorQuantization::RoundWholeNumber)))
            }
            RepLayoutCmdType::RepMovement => Some(FieldValue::RepMovement(reader.serialize_rep_movement(
                VectorQuantization::default(),
                Default::default(),
                VectorQuantization::default(),
            ))),
            RepLayoutCmdType::Enum => Some(FieldValue::U8(reader.serialize_property_enum())),
            RepLayoutCmdType::PropertyByte => Some(FieldValue::U8(reader.read_byte())),
            RepLayoutCmdType::PropertyInt => Some(FieldValue::I32(reader.read_int32())),
            RepLayoutCmdType::PropertyInt16 => Some(FieldValue::I16(reader.read_int16())),
            RepLayoutCmdType::PropertyUInt64 => Some(FieldValue::U64(reader.read_uint64())),
            RepLayoutCmdType::PropertyUInt16 => Some(FieldValue::U16(reader.read_uint16())),
            RepLayoutCmdType::PropertyUInt32 => Some(FieldValue::U32(reader.read_uint32())),
            RepLayoutCmdType::PropertyVector => Some(FieldValue::Vector(reader.serialize_property_vector())),
            RepLayoutCmdType::PropertyVector2D => Some(FieldValue::Vector2D(reader.serialize_property_vector2d())),
            RepLayoutCmdType::PropertyQuat => {
                let mut data = element_factory.map(|f| f())?;
                data.serialize(reader);
                Some(FieldValue::PropertyValue(data))
            }
            _ => {
                let bits_left = reader.get_bits_left();
                reader.seek(bits_left, SeekOrigin::Current);
                None
            }
        }
    }

    fn read_array_field(
        &self,
        export_group: &NetFieldExportGroup,
        field_info: &NetFieldDescriptor,
        group_desc: &NetFieldExportGroupDescriptor,
        reader: &mut NetBitReader,
        _guid_cache: &NetGuidCache,
    ) -> Option<FieldValue> {
        let array_length = reader.read_int_packed();
        let is_group_type = field_info.group_element_factory.is_some();
        let replayout = field_info.element_type.unwrap_or(RepLayoutCmdType::Ignore);

        if !is_group_type && replayout == RepLayoutCmdType::Ignore {
            return None;
        }

        let mut arr: Vec<FieldValue> = (0..array_length).map(|_| FieldValue::Null).collect();

        loop {
            let mut index = reader.read_int_packed();
            if index == 0 {
                if reader.get_bits_left() == 8 {
                    let terminator = reader.read_int_packed();
                    if terminator != 0 {
                        return Some(FieldValue::Array(arr));
                    }
                }
                return Some(FieldValue::Array(arr));
            }
            index -= 1;
            if index >= array_length {
                return Some(FieldValue::Array(arr));
            }

            // TS builds the group-type element object once per array index
            // and threads it through repeated `readField` calls (one per
            // handle) so nested handles accumulate onto the same object; see
            // `read_field_into` below for the recursive dispatch (now wired
            // up using the same `group_desc` as the parent, matching TS).
            let mut data: Option<Box<dyn NetFieldModel>> = if is_group_type {
                field_info.group_element_factory.map(|f| f())
            } else {
                None
            };
            let mut primitive: Option<FieldValue> = None;

            loop {
                let mut handle = reader.read_int_packed();
                if handle == 0 {
                    break;
                }
                handle -= 1;
                if export_group.NetFieldExportsLength < handle {
                    return Some(FieldValue::Array(arr));
                }

                let export_field = export_group.NetFieldExports.get(handle as usize).and_then(|e| e.as_ref());
                let num_bits = reader.read_int_packed();
                if num_bits == 0 {
                    continue;
                }
                let export_field = match export_field {
                    Some(f) => f,
                    None => {
                        reader.skip_bits(num_bits as i64);
                        continue;
                    }
                };

                reader.set_temp_end(num_bits as usize, FBitArchiveEndIndex::ReadArrayField as u32);
                if is_group_type {
                    if let Some(obj) = data.as_deref_mut() {
                        self.read_field_into(obj, export_field, handle, export_group, group_desc, reader, _guid_cache);
                    }
                } else {
                    primitive = self.read_data_type(replayout, reader, None, _guid_cache);
                }
                reader.restore_temp_end(FBitArchiveEndIndex::ReadArrayField as u32);
            }

            arr[index as usize] = if is_group_type {
                match data {
                    Some(d) => FieldValue::Object(d),
                    None => FieldValue::Null,
                }
            } else {
                primitive.unwrap_or(FieldValue::Null)
            };
        }
    }
}
