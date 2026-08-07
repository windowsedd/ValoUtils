//! Net field registry — the Rust replacement for C#'s reflection-based
//! `NetFieldParser` discovery (and for TS's module-load self-registration).
//! Ported from `package/ts-replay-parser/src/unreal/registry.ts`.
//!
//! **Design decision (per the porting plan, not to be redesigned here):**
//! manual registration into a `HashMap`, built once, no proc-macros, no
//! `inventory` crate. TS models self-register at module import time
//! (`registry.registerGroup({...})` side effects); Rust has no equivalent
//! implicit side-effecting import, so the *next* (valorant) phase will call
//! `NetFieldRegistry::new()` then explicitly push ~36 descriptors via a
//! `valorant::register_all(&mut registry)` function. This phase only defines
//! the registry shape and leaves it empty.

use super::enums::{ParseMode, RepLayoutCmdType};
use super::models::{NetFieldModel, Property};
use crate::replay::io::enums::{RotatorQuantization, VectorQuantization};

/// Movement quantization spec for `RepLayoutCmdType::RepMovement` fields that
/// specify non-default quantization levels (mirrors TS `RepMovementSpec`).
#[derive(Clone, Copy, Debug)]
pub struct RepMovementSpec {
    pub location: VectorQuantization,
    pub rotation: RotatorQuantization,
    pub velocity: VectorQuantization,
}

/// One replicated property of a net field export group.
///
/// Deviation from the sketch in the phase brief: TS's single `elementFactory`
/// field is overloaded across two unrelated purposes depending on `type`:
/// (a) for `RepLayoutCmdType::Property`/`PropertyQuat` it builds a single
/// `IProperty` (our [`Property`]) instance to serialize in place, and (b) for
/// `RepLayoutCmdType::DynamicArray` with a "group type" element it builds a
/// full [`NetFieldModel`] instance that gets nested fields assigned via
/// `NetFieldParser::read_field`. Rust can't express "returns `Box<dyn Property>`
/// OR `Box<dyn NetFieldModel>` depending on a runtime-checked enum tag" through
/// one `fn` pointer type without an extra indirection enum, so this splits
/// into two factory fields (`element_factory` for case (a),
/// `group_element_factory` for case (b)); exactly one is ever populated for a
/// given descriptor, matching which `type` it's used with.
pub struct NetFieldDescriptor {
    /// Property name (export-name mode) — matches the replicated FName.
    pub name: Option<&'static str>,
    /// Handle number (handle mode) — matches the replicated handle.
    pub handle: Option<u32>,
    /// Key on the target object to assign the parsed value to.
    pub key: &'static str,
    pub ty: RepLayoutCmdType,
    pub minimal_parse_mode: Option<ParseMode>,
    pub movement: Option<RepMovementSpec>,
    /// For `Property`/`PropertyQuat`: builds the single `IProperty`-like value.
    pub element_factory: Option<fn() -> Box<dyn Property>>,
    /// For `DynamicArray` of a group/model type: builds one array element.
    pub group_element_factory: Option<fn() -> Box<dyn NetFieldModel>>,
    /// For `DynamicArray` of primitives: the element's `RepLayoutCmdType`.
    pub element_type: Option<RepLayoutCmdType>,
}

pub struct NetFieldExportGroupDescriptor {
    pub path: &'static str,
    pub minimal_parse_mode: ParseMode,
    /// Construct a fresh instance of the group's backing object.
    pub factory: fn() -> Box<dyn NetFieldModel>,
    /// Export-name/handle-keyed properties.
    pub properties: Vec<NetFieldDescriptor>,
    /// Whether this group uses handle-based field lookup.
    pub uses_handles: bool,
    /// If set, registers this path as a sub-group of the named parent path.
    pub sub_group_of: Option<&'static str>,
}

pub struct ClassNetCacheProperty {
    pub name: &'static str,
    pub path_name: &'static str,
    pub is_function: bool,
    pub enable_property_checksum: bool,
    pub is_custom_struct: bool,
    /// For custom structs: build the `IProperty` to deserialize directly.
    pub property_factory: Option<fn() -> Box<dyn Property>>,
}

pub struct ClassNetCacheDescriptor {
    pub path: &'static str,
    pub minimal_parse_mode: ParseMode,
    pub properties: Vec<ClassNetCacheProperty>,
}

/// Global registry of all model descriptors. Populated once at startup by the
/// (future) valorant phase; empty in this phase.
pub struct NetFieldRegistry {
    pub groups: std::collections::HashMap<&'static str, NetFieldExportGroupDescriptor>,
    pub class_net_caches: std::collections::HashMap<&'static str, ClassNetCacheDescriptor>,
    pub player_controller_paths: std::collections::HashSet<&'static str>,
}

impl Default for NetFieldRegistry {
    fn default() -> Self {
        NetFieldRegistry::new()
    }
}

impl NetFieldRegistry {
    pub fn new() -> Self {
        let mut r = NetFieldRegistry {
            groups: std::collections::HashMap::new(),
            class_net_caches: std::collections::HashMap::new(),
            player_controller_paths: std::collections::HashSet::new(),
        };
        // TODO(valorant phase): valorant::models::register_all(&mut r);
        let _ = &mut r;
        r
    }

    pub fn register_group(&mut self, desc: NetFieldExportGroupDescriptor) {
        self.groups.insert(desc.path, desc);
    }

    pub fn register_sub_group(&mut self, parent_path: &str, properties: Vec<NetFieldDescriptor>) {
        if let Some(parent) = self.groups.get_mut(parent_path) {
            parent.properties.extend(properties);
        }
    }

    pub fn register_class_net_cache(&mut self, desc: ClassNetCacheDescriptor) {
        self.class_net_caches.insert(desc.path, desc);
    }

    pub fn register_player_controller(&mut self, path: &'static str) {
        self.player_controller_paths.insert(path);
    }
}
