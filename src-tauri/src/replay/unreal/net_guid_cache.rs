//! NetGuidCache — tracks all NetGuids during a replay.
//! Ported from `package/ts-replay-parser/src/unreal/net-guid-cache.ts`
//! (itself ported from Unreal.Core/Models/NetGuidCache.cs).
//!
//! # Fuzzy path matching tie-break rule (flagged risk area)
//!
//! `getNetFieldExportGroupByGuid` resolves an actor/archetype netguid to its
//! export group via **substring matching in Map insertion order**, not
//! longest-prefix-wins:
//!
//! 1. Exact caches (`archTypeToExportGroup`, `NetFieldExportGroupMapPathFixed`)
//!    are checked first — cheap memoized fast paths, not part of the matching
//!    algorithm itself.
//! 2. Pass 1: iterate `NetFieldExportGroupMap` in **insertion order** (JS
//!    `Map` preserves insertion order; ported here as `IndexMap`-equivalent —
//!    see below). For each registered group, compute
//!    `groupPathFixed = removeAllPathPrefixes(groupPath)` (memoized by
//!    `PathNameIndex`). The **first** group for which
//!    `path.includes(groupPathFixed)` (i.e. `groupPathFixed` is a substring of
//!    the netguid's resolved `path`) is returned — this is a first-match-wins,
//!    NOT best/longest-match-wins, tie-break.
//! 3. Pass 2 (only if pass 1 found nothing): `cleanedPath = cleanPathSuffix(path)`
//!    (strip trailing digits/underscores from the netguid's path), then
//!    iterate the map again in insertion order, this time checking
//!    `groupPathFixed.includes(cleanedPath)` (reversed argument order from
//!    pass 1!) — again first match wins.
//! 4. If neither pass matches, the netguid's path is memoized into
//!    `failedPaths` so future lookups short-circuit to `null` immediately.
//!
//! Since plain `std::collections::HashMap` does **not** preserve insertion
//! order (and Rust has no built-in insertion-ordered map without a crate
//! dependency), and this crate avoids adding new dependencies for this port,
//! `NetFieldExportGroupMap` is implemented here as a `Vec<(String, NetFieldExportGroup)>`
//! (append-only, linear-scan) alongside a `HashMap<String, usize>` index for
//! O(1) exact-path lookups (`getNetFieldExportGroupByPath`) — this preserves
//! insertion order for the fuzzy-match scan while keeping direct lookups fast.

use std::collections::{HashMap, HashSet};

use super::models::{ExternalData, NetFieldExportGroup};
use super::string_utils::{clean_path_suffix, remove_all_path_prefixes};

pub struct NetGuidCache {
    /// Insertion-ordered `path -> group` map (see module docs for why this
    /// isn't a plain `HashMap`).
    group_order: Vec<String>,
    group_map: HashMap<String, NetFieldExportGroup>,

    pub net_field_export_group_index_to_group: HashMap<u32, String>,
    pub net_guid_to_path_name: HashMap<u32, String>,
    net_field_export_group_map_path_fixed: HashMap<u32, String>,
    pub external_data: HashMap<u32, ExternalData>,

    arch_type_to_export_group: HashMap<u32, String>,
    cleaned_paths: HashMap<u32, String>,
    cleaned_class_net_cache: HashMap<String, String>,
    failed_paths: HashSet<String>,
    network_gameplay_tag_node_index: Option<String>,
}

impl Default for NetGuidCache {
    fn default() -> Self {
        NetGuidCache::new()
    }
}

impl NetGuidCache {
    pub fn new() -> Self {
        NetGuidCache {
            group_order: Vec::new(),
            group_map: HashMap::new(),
            net_field_export_group_index_to_group: HashMap::new(),
            net_guid_to_path_name: HashMap::new(),
            net_field_export_group_map_path_fixed: HashMap::new(),
            external_data: HashMap::new(),
            arch_type_to_export_group: HashMap::new(),
            cleaned_paths: HashMap::new(),
            cleaned_class_net_cache: HashMap::new(),
            failed_paths: HashSet::new(),
            network_gameplay_tag_node_index: None,
        }
    }

    /// Direct map accessor mirroring `this.netGuidCache.NetFieldExportGroupMap.get(pathName)`
    /// call sites in `replay_reader.rs`.
    pub fn get_group_map_entry(&self, path: &str) -> Option<&NetFieldExportGroup> {
        self.group_map.get(path)
    }
    pub fn get_group_map_entry_mut(&mut self, path: &str) -> Option<&mut NetFieldExportGroup> {
        self.group_map.get_mut(path)
    }

    pub fn network_gameplay_tag_node_index(&mut self) -> Option<&NetFieldExportGroup> {
        if self.network_gameplay_tag_node_index.is_none() {
            if self.group_map.contains_key("NetworkGameplayTagNodeIndex") {
                self.network_gameplay_tag_node_index =
                    Some("NetworkGameplayTagNodeIndex".to_string());
            } else if self
                .group_map
                .contains_key("NetworkGameplayTagDynamicIndex")
            {
                self.network_gameplay_tag_node_index =
                    Some("NetworkGameplayTagDynamicIndex".to_string());
            }
        }
        self.network_gameplay_tag_node_index
            .as_ref()
            .and_then(|k| self.group_map.get(k))
    }

    pub fn add_to_export_group_map(&mut self, group: &str, mut export_group: NetFieldExportGroup) {
        if group.ends_with("ClassNetCache") {
            export_group.PathName = remove_all_path_prefixes(&export_group.PathName);
        }
        self.net_field_export_group_index_to_group
            .insert(export_group.PathNameIndex, group.to_string());
        if !self.group_map.contains_key(group) {
            self.group_order.push(group.to_string());
        }
        self.group_map.insert(group.to_string(), export_group);
    }

    pub fn get_net_field_export_group_from_index(
        &self,
        index: Option<u32>,
    ) -> Option<&NetFieldExportGroup> {
        let index = index?;
        let group = self.net_field_export_group_index_to_group.get(&index)?;
        self.group_map.get(group)
    }

    /// Returns the `group_map` **key** that `index` resolves to (via
    /// `net_field_export_group_index_to_group`), not the resolved group's own
    /// `.PathName` field. Callers that need to write back into the same
    /// group after resolving it by index (e.g. `read_net_field_exports`)
    /// must reuse this key rather than re-deriving one from `.PathName` —
    /// `add_to_export_group_map` normalizes `.PathName` for `ClassNetCache`
    /// groups (`remove_all_path_prefixes`), so it can differ from the actual
    /// `group_map` key, and re-looking-up by `.PathName` can silently miss.
    pub fn get_net_field_export_group_key_from_index(&self, index: Option<u32>) -> Option<&String> {
        let index = index?;
        self.net_field_export_group_index_to_group.get(&index)
    }

    pub fn get_net_field_export_group_by_path(&self, path: &str) -> Option<&NetFieldExportGroup> {
        if path.is_empty() {
            return None;
        }
        self.group_map.get(path)
    }

    /// Resolve an actor/archetype netguid to its export group (fuzzy path
    /// matching — see module docs for the exact tie-break rule).
    pub fn get_net_field_export_group_by_guid(
        &mut self,
        netguid: Option<u32>,
    ) -> Option<&NetFieldExportGroup> {
        let netguid = netguid?;

        if let Some(path) = self.arch_type_to_export_group.get(&netguid) {
            let path = path.clone();
            return self.group_map.get(&path);
        }

        let path = self.net_guid_to_path_name.get(&netguid)?.clone();
        if self.failed_paths.contains(&path) {
            return None;
        }

        if let Some(fixed) = self.net_field_export_group_map_path_fixed.get(&netguid) {
            let fixed = fixed.clone();
            self.arch_type_to_export_group
                .insert(netguid, fixed.clone());
            return self.group_map.get(&fixed);
        }

        // Pass 1: `path.includes(groupPathFixed)`, first match in insertion order wins.
        for group_path in self.group_order.clone() {
            let group = match self.group_map.get(&group_path) {
                Some(g) => g,
                None => continue,
            };
            let path_name_index = group.PathNameIndex;
            let group_path_fixed = match self.cleaned_paths.get(&path_name_index) {
                Some(p) => p.clone(),
                None => {
                    let fixed = remove_all_path_prefixes(&group_path);
                    self.cleaned_paths.insert(path_name_index, fixed.clone());
                    fixed
                }
            };
            if path.contains(&group_path_fixed) {
                self.net_field_export_group_map_path_fixed
                    .insert(netguid, group_path.clone());
                self.arch_type_to_export_group
                    .insert(netguid, group_path.clone());
                return self.group_map.get(&group_path);
            }
        }

        // Pass 2: `groupPathFixed.includes(cleanedPath)`, first match in insertion order wins.
        let cleaned_path = clean_path_suffix(&path);
        for group_path in self.group_order.clone() {
            let group = match self.group_map.get(&group_path) {
                Some(g) => g,
                None => continue,
            };
            if let Some(group_path_fixed) = self.cleaned_paths.get(&group.PathNameIndex) {
                if group_path_fixed.contains(&cleaned_path) {
                    self.net_field_export_group_map_path_fixed
                        .insert(netguid, group_path.clone());
                    self.arch_type_to_export_group
                        .insert(netguid, group_path.clone());
                    return self.group_map.get(&group_path);
                }
            }
        }

        self.failed_paths.insert(path);
        None
    }

    pub fn try_get_class_net_cache(
        &mut self,
        group: Option<&str>,
        use_full_name: bool,
    ) -> Option<&NetFieldExportGroup> {
        let group = group?;
        if group.is_empty() {
            return None;
        }
        let class_net_cache_path = match self.cleaned_class_net_cache.get(group) {
            Some(p) => p.clone(),
            None => {
                let computed = if use_full_name {
                    format!("{group}_ClassNetCache")
                } else {
                    format!("{}_ClassNetCache", remove_all_path_prefixes(group))
                };
                self.cleaned_class_net_cache
                    .insert(group.to_string(), computed.clone());
                computed
            }
        };
        self.group_map.get(&class_net_cache_path)
    }

    pub fn try_get_path_name(&self, netguid: u32) -> Option<&String> {
        self.net_guid_to_path_name.get(&netguid)
    }

    pub fn try_get_external_data(&mut self, netguid: Option<u32>) -> Option<ExternalData> {
        let netguid = netguid?;
        self.external_data.remove(&netguid)
    }

    pub fn cleanup(&mut self) {
        self.net_field_export_group_index_to_group.clear();
        self.group_map.clear();
        self.group_order.clear();
        self.net_guid_to_path_name.clear();
        self.net_field_export_group_map_path_fixed.clear();
        self.external_data.clear();
        self.network_gameplay_tag_node_index = None;
        self.arch_type_to_export_group.clear();
        self.cleaned_paths.clear();
        self.cleaned_class_net_cache.clear();
        self.failed_paths.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(path: &str, index: u32) -> NetFieldExportGroup {
        NetFieldExportGroup {
            PathName: path.to_string(),
            PathNameIndex: index,
            NetFieldExportsLength: 0,
            NetFieldExports: Vec::new(),
            GroupId: -1,
        }
    }

    /// Hand-traced example: `removeAllPathPrefixes` on
    /// `"/Game/Weapon.Weapon_C"` strips everything up to (and including) the
    /// last `.`, giving cleaned path `"Weapon_C"`; on
    /// `"/Game/Weapon.Weapon_C_Big"` it gives `"Weapon_C_Big"`. A netguid path
    /// of `"PersistentLevel.Weapon_C_Big_1"` contains BOTH cleaned substrings
    /// (`"Weapon_C_Big"` trivially contains `"Weapon_C"` as a prefix) — a
    /// naive "longest/most-specific match wins" reading would pick the
    /// second, more specific group. The real TS algorithm just scans
    /// registration order and returns the FIRST substring match, so
    /// registering the generic group first makes it win even though the
    /// more specific group also matches.
    #[test]
    fn fuzzy_match_is_first_registered_substring_wins_not_longest() {
        let mut cache = NetGuidCache::new();
        cache.add_to_export_group_map("/Game/Weapon.Weapon_C", group("/Game/Weapon.Weapon_C", 1));
        cache.add_to_export_group_map(
            "/Game/Weapon.Weapon_C_Big",
            group("/Game/Weapon.Weapon_C_Big", 2),
        );

        let netguid = 42u32;
        cache
            .net_guid_to_path_name
            .insert(netguid, "PersistentLevel.Weapon_C_Big_1".to_string());

        let found = cache.get_net_field_export_group_by_guid(Some(netguid));
        assert_eq!(found.unwrap().PathName, "/Game/Weapon.Weapon_C");
    }

    /// Same scenario with registration order reversed: now the more specific
    /// group is registered first, so IT wins — confirming the tie-break is
    /// purely insertion-order, not string length/specificity.
    #[test]
    fn fuzzy_match_order_reversed_flips_the_winner() {
        let mut cache = NetGuidCache::new();
        cache.add_to_export_group_map(
            "/Game/Weapon.Weapon_C_Big",
            group("/Game/Weapon.Weapon_C_Big", 1),
        );
        cache.add_to_export_group_map("/Game/Weapon.Weapon_C", group("/Game/Weapon.Weapon_C", 2));

        let netguid = 43u32;
        cache
            .net_guid_to_path_name
            .insert(netguid, "PersistentLevel.Weapon_C_Big_1".to_string());

        let found = cache.get_net_field_export_group_by_guid(Some(netguid));
        assert_eq!(found.unwrap().PathName, "/Game/Weapon.Weapon_C_Big");
    }

    #[test]
    fn no_match_records_failed_path_and_returns_none() {
        let mut cache = NetGuidCache::new();
        cache.add_to_export_group_map("/Game/Foo.Foo_C", group("/Game/Foo.Foo_C", 1));
        let netguid = 99u32;
        cache
            .net_guid_to_path_name
            .insert(netguid, "PersistentLevel.Unrelated_1".to_string());
        assert!(cache
            .get_net_field_export_group_by_guid(Some(netguid))
            .is_none());
    }
}
