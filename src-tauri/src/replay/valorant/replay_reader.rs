//! ValorantReplayReader — concrete reader for VALORANT `.vrf` replays.
//! Ported from `package/ts-replay-parser/src/valorant/replay-reader.ts`.
//!
//! TS subclasses `ReplayReader<ValorantReplay>` and overrides `decompress`,
//! `receivedReplicatorBunch` (payload de-obfuscation), `readEvent` (a no-op
//! duplicate of the base reader's default — see `unreal::replay_reader::
//! ReplayReader::read_event`'s doc comment, no override needed here), and
//! `onExportRead`. In Rust, `ReplayReader<R, H>` takes those overrides as a
//! `ReplayReaderHooks<R>` impl (`ValorantHooks` below) instead of subclassing.
//!
//! `app_parser.rs`'s `AppReader` (TS: `class AppReader extends
//! ValorantReplayReader`) can't subclass `ValorantHooks` either — Rust has no
//! trait-impl inheritance — so the shared algorithmic bits (branch
//! resolution, the transform call, the Oodle decompress call, export-record
//! collection) are pulled out into free functions both hook structs call,
//! rather than duplicating the logic.

#![allow(non_snake_case)]

use crate::replay::io::binary_reader::BinaryReader;
use crate::replay::ooz::decompress_replay_data;
use crate::replay::transform::apply_transform;
use crate::replay::unreal::enums::ParseMode;
use crate::replay::unreal::models::{FieldValue, ReplayHeader, ReplayInfo};
use crate::replay::unreal::registry::NetFieldRegistry;
use crate::replay::unreal::replay_reader::{
    ExportedValue, ReplayLike, ReplayReader, ReplayReaderHooks,
};

use super::models::register_all;

/// One parsed export-group object, in the shape the base `ValorantReplayReader`
/// collects them (TS `ExportRecord`). (No `Debug`/`Clone` derive — `FieldValue`
/// holds non-`Debug`/non-`Clone` trait objects for `Object`/`PropertyValue`.)
pub struct ExportRecord {
    pub channel_index: u32,
    pub type_name: &'static str,
    pub fields: Vec<(&'static str, FieldValue)>,
}

/// TS `class ValorantReplay extends Replay { exports: ExportRecord[] = [] }`.
/// (The Rust port stores collected exports on the *hooks* struct instead —
/// see the module doc comment on why `on_export_read` can't reach back into
/// `ReplayReader::replay` — so this struct only carries `Info`/`Header`;
/// `ValorantReplayReader::read_replay`'s result type reunites both.)
#[derive(Debug, Default)]
pub struct ValorantReplay {
    pub Info: ReplayInfo,
    pub Header: ReplayHeader,
}

impl ReplayLike for ValorantReplay {
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

/// The RPC export-group type name skipped from the collected exports — its
/// movement payload is collected separately by `AppReader` in `app_parser.rs`
/// (mirrors the TS `onExportRead`'s early-return guard).
pub(super) const REMOTE_CHARACTER_UPDATES_RPC_TYPE: &str =
    "ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous";

/// TS `resolveBranch()`: explicit version override wins, else falls back to
/// the replay header's branch string (`++Ares-Core+release-12.11`), else
/// `"release-12.10"`.
pub(super) fn resolve_branch(version: &Option<String>, header_branch: &str) -> String {
    match version {
        Some(v) => format!("release-{v}"),
        None => {
            if header_branch.is_empty() {
                "release-12.10".to_string()
            } else {
                header_branch.to_string()
            }
        }
    }
}

/// TS `ValorantReplayReader.decompress`: Oodle/Kraken decompress the chunk.
/// (State field propagation onto the returned reader is handled generically
/// by the caller, `ReplayReader::read_replay_data` — see that method's doc
/// comment for why this was moved to the base layer.)
pub(super) fn do_decompress(mut archive: BinaryReader) -> BinaryReader {
    let decompressed_size = archive.read_int32();
    let compressed_size = archive.read_int32();
    let compressed = archive.read_bytes(compressed_size.max(0) as usize);
    let output = decompress_replay_data(&compressed, decompressed_size.max(0) as usize)
        .expect("replay chunk failed to decompress");
    BinaryReader::new(output)
}

/// TS `ValorantReplayReader.receivedReplicatorBunch`'s payload transform:
/// seed = payloadBits, XORed with the owning actor's netguid if present, then
/// the seeded de-obfuscation cipher keyed off the resolved branch string.
pub(super) fn do_transform(
    version: &Option<String>,
    actor_guid: Option<u32>,
    payload: Vec<u8>,
    payload_bits: u32,
    header_branch: &str,
) -> Vec<u8> {
    let mut seed = payload_bits;
    if let Some(guid) = actor_guid {
        seed ^= guid;
    }
    let branch = resolve_branch(version, header_branch);
    apply_transform(&payload, payload_bits, seed, Some(&branch))
}

/// TS `ValorantReplayReader.onExportRead`: skip `null`/non-`Model` exports and
/// the `RemoteCharacterUpdates` RPC carrier type (collected separately by
/// `AppReader`), otherwise collect `{ channelIndex, type, fields }`.
pub(super) fn push_export(
    exports: &mut Vec<ExportRecord>,
    channel_index: u32,
    export_group: Option<ExportedValue>,
) {
    let model = match export_group {
        Some(ExportedValue::Model(m)) => m,
        // `receiveCustomProperty`'s raw `IProperty` exports aren't
        // `NetFieldModel`s and have no registered valorant custom-struct
        // consumer in this phase (no `is_custom_struct: true` entries were
        // registered), so there's nothing to collect here.
        Some(ExportedValue::Property(_)) => return,
        None => return,
    };
    let type_name = model.type_name();
    if type_name == REMOTE_CHARACTER_UPDATES_RPC_TYPE {
        return;
    }
    exports.push(ExportRecord {
        channel_index,
        type_name,
        fields: model.to_export_fields(),
    });
}

/// Hooks for the plain `ValorantReplayReader` (no app-parser extras).
pub struct ValorantHooks {
    version: Option<String>,
    pub exports: Vec<ExportRecord>,
}

impl ValorantHooks {
    pub fn new(version: Option<String>) -> Self {
        ValorantHooks {
            version,
            exports: Vec::new(),
        }
    }
}

impl ReplayReaderHooks<ValorantReplay> for ValorantHooks {
    fn create_replay(&mut self) -> ValorantReplay {
        ValorantReplay::default()
    }

    fn decompress(&mut self, archive: BinaryReader) -> BinaryReader {
        do_decompress(archive)
    }

    fn on_export_read(&mut self, channel_index: u32, export_group: Option<ExportedValue>) {
        push_export(&mut self.exports, channel_index, export_group);
    }

    fn transform_bunch_payload(
        &mut self,
        actor_guid: Option<u32>,
        payload: Vec<u8>,
        payload_bits: u32,
        header_branch: &str,
    ) -> Vec<u8> {
        do_transform(
            &self.version,
            actor_guid,
            payload,
            payload_bits,
            header_branch,
        )
    }
}

/// Result of [`ValorantReplayReader::read_replay`] — TS's `ValorantReplay`
/// (`.Info`, `.Header`, `.exports`), reunited from the `ReplayReader`'s
/// `replay` state and the hooks' collected `exports` (see the module doc
/// comment on why those live on the hooks struct in this port).
#[derive(Default)]
pub struct ValorantReplayResult {
    pub info: ReplayInfo,
    pub header: ReplayHeader,
    pub exports: Vec<ExportRecord>,
}

/// Concrete VALORANT replay reader. Wraps the generic `unreal::ReplayReader`
/// with `ValorantHooks` and a pre-populated `NetFieldRegistry` (the explicit
/// Rust equivalent of TS's "importing `./models.js` populates the registry as
/// a side effect").
pub struct ValorantReplayReader {
    inner: ReplayReader<ValorantReplay, ValorantHooks>,
}

impl ValorantReplayReader {
    /// `version`: game version like `"12.11"`. `None` auto-detects from the
    /// replay header branch (`++Ares-Core+release-12.11`).
    pub fn new(version: Option<String>, mode: ParseMode) -> Self {
        let mut registry = NetFieldRegistry::new();
        register_all(&mut registry);
        let hooks = ValorantHooks::new(version);
        ValorantReplayReader {
            inner: ReplayReader::new(mode, hooks, registry),
        }
    }

    /// Parse a replay from raw `.vrf` bytes.
    pub fn read_replay(&mut self, bytes: &[u8]) -> ValorantReplayResult {
        let mut archive = BinaryReader::new(bytes.to_vec());
        let replay = self.inner.read_replay_from_archive(&mut archive);
        let info = replay.Info.clone();
        let header = replay.Header.clone();
        // `replay`'s borrow of `self.inner` ends at its last use above, so
        // this is a fresh, non-conflicting borrow of a different field.
        let exports = std::mem::take(&mut self.inner.hooks.exports);
        ValorantReplayResult {
            info,
            header,
            exports,
        }
    }
}

#[cfg(test)]
mod tests {
    //! Port of `replay-reader.test.ts` (end-to-end parity) and
    //! `movement.test.ts` (`ComponentDataStream` bit-decoder parity), run
    //! against the two real `.vrf` fixtures shared with the TS package.

    use super::*;
    use crate::replay::unreal::replay_reader::ExportedValue;
    use crate::replay::valorant::models::{
        ComponentDataStream, RemoteCharacterUpdate,
        ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous,
    };
    use serde::Deserialize;
    use std::collections::HashMap;

    fn fixture(name: &str) -> Vec<u8> {
        let path = format!(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../package/ts-replay-parser/src/valorant/__fixtures__/{}"
            ),
            name
        );
        std::fs::read(&path).unwrap_or_else(|e| panic!("failed to read fixture {path}: {e}"))
    }

    fn load_json<T: for<'de> Deserialize<'de>>(name: &str) -> T {
        let path = format!(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../package/ts-replay-parser/src/valorant/{}"
            ),
            name
        );
        let raw =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));
        let raw = raw.trim_start_matches('\u{feff}');
        serde_json::from_str(raw).unwrap_or_else(|e| panic!("failed to parse {path}: {e}"))
    }

    #[derive(Deserialize)]
    struct ReplayRef {
        file: String,
        version: String,
        #[serde(rename = "lengthInMs")]
        length_in_ms: u32,
        #[serde(rename = "friendlyName")]
        friendly_name: String,
        branch: String,
        #[serde(rename = "engineNetworkVersion")]
        engine_network_version: u32,
        #[serde(rename = "networkVersion")]
        network_version: u32,
        #[serde(rename = "totalExports")]
        total_exports: u32,
        #[serde(rename = "typeCounts")]
        type_counts: HashMap<String, u32>,
    }

    #[derive(Deserialize)]
    struct MovementRef {
        file: String,
        version: String,
        #[serde(rename = "totalMoves")]
        total_moves: usize,
        #[serde(rename = "movesWithPosition")]
        moves_with_position: usize,
        #[serde(rename = "hasSection")]
        has_section: usize,
        #[serde(rename = "validMagic")]
        valid_magic: usize,
        #[serde(rename = "firstPositions")]
        first_positions: Vec<FirstPosition>,
    }

    #[derive(Deserialize)]
    struct FirstPosition {
        x: f64,
        y: f64,
        ts: u32,
    }

    /// Test-only hooks that collect every `ComponentDataStream` encountered —
    /// via the RPC carrier's own top-level field *and* every element of its
    /// `RemoteCharacterUpdates` array — mirroring `movement.test.ts`'s
    /// generic `MovementCollector.walk`. `ComponentDataStream` only ever
    /// appears in exactly those two field slots across all registered
    /// models (see `models.ts`), so this narrow collection is equivalent to
    /// a fully generic export-tree walk for this crate's registered models.
    struct MovementCollectorHooks {
        version: Option<String>,
        streams: Vec<ComponentDataStream>,
    }

    impl MovementCollectorHooks {
        fn new(version: Option<String>) -> Self {
            MovementCollectorHooks {
                version,
                streams: Vec::new(),
            }
        }

        fn collect(&mut self, update: &RemoteCharacterUpdate) {
            if let Some(cds) = &update.ComponentDataStream {
                self.streams.push(cds.clone());
            }
        }
    }

    impl ReplayReaderHooks<ValorantReplay> for MovementCollectorHooks {
        fn create_replay(&mut self) -> ValorantReplay {
            ValorantReplay::default()
        }
        fn decompress(&mut self, archive: BinaryReader) -> BinaryReader {
            do_decompress(archive)
        }
        fn on_export_read(&mut self, _channel_index: u32, export_group: Option<ExportedValue>) {
            if let Some(ExportedValue::Model(model)) = &export_group {
                if let Some(rpc) = model
                    .as_any()
                    .downcast_ref::<ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous>()
                {
                    if let Some(cds) = &rpc.ComponentDataStream {
                        self.streams.push(cds.clone());
                    }
                    if let Some(updates) = &rpc.RemoteCharacterUpdates {
                        for u in updates.iter().flatten() {
                            self.collect(u);
                        }
                    }
                }
            }
        }
        fn transform_bunch_payload(
            &mut self,
            actor_guid: Option<u32>,
            payload: Vec<u8>,
            payload_bits: u32,
            header_branch: &str,
        ) -> Vec<u8> {
            do_transform(
                &self.version,
                actor_guid,
                payload,
                payload_bits,
                header_branch,
            )
        }
    }

    #[test]
    fn movement_matches_csharp_reference() {
        let refs: Vec<MovementRef> = load_json("__movement_refs__.json");
        assert!(!refs.is_empty());
        for r in refs {
            let bytes = fixture(&r.file);
            let mut registry = NetFieldRegistry::new();
            register_all(&mut registry);
            let hooks = MovementCollectorHooks::new(Some(r.version.clone()));
            let mut reader: ReplayReader<ValorantReplay, MovementCollectorHooks> =
                ReplayReader::new(ParseMode::Full, hooks, registry);
            let mut archive = BinaryReader::new(bytes);
            reader.read_replay_from_archive(&mut archive);

            let mut has_section = 0usize;
            let mut valid_magic = 0usize;
            let mut moves: Vec<&crate::replay::valorant::models::MovementMove> = Vec::new();
            for s in &reader.hooks.streams {
                if s.HasMovementSection {
                    has_section += 1;
                }
                if s.HasValidMovementMagic {
                    valid_magic += 1;
                }
                for m in &s.Moves {
                    moves.push(m);
                }
            }
            let with_pos = moves.iter().filter(|m| m.Position.is_some()).count();

            assert_eq!(
                has_section, r.has_section,
                "hasSection mismatch for {}",
                r.file
            );
            assert_eq!(
                valid_magic, r.valid_magic,
                "validMagic mismatch for {}",
                r.file
            );
            assert_eq!(
                moves.len(),
                r.total_moves,
                "totalMoves mismatch for {}",
                r.file
            );
            assert_eq!(
                with_pos, r.moves_with_position,
                "movesWithPosition mismatch for {}",
                r.file
            );

            let first_with_pos: Vec<_> = moves
                .iter()
                .filter(|m| m.Position.is_some())
                .take(r.first_positions.len())
                .collect();
            assert_eq!(
                first_with_pos.len(),
                r.first_positions.len(),
                "not enough positioned moves for {}",
                r.file
            );
            for (got, want) in first_with_pos.iter().zip(r.first_positions.iter()) {
                let pos = got.Position.unwrap();
                let gx = (pos.X * 10.0).round() / 10.0;
                let gy = (pos.Y * 10.0).round() / 10.0;
                assert_eq!(gx, want.x, "x mismatch for {}", r.file);
                assert_eq!(gy, want.y, "y mismatch for {}", r.file);
                assert_eq!(got.Timestamp, want.ts, "ts mismatch for {}", r.file);
            }
        }
    }

    #[test]
    fn end_to_end_matches_csharp_reference() {
        let refs: Vec<ReplayRef> = load_json("__replay_refs__.json");
        assert!(!refs.is_empty());
        for r in refs {
            let bytes = fixture(&r.file);
            let mut reader = ValorantReplayReader::new(Some(r.version.clone()), ParseMode::Normal);
            let result = reader.read_replay(&bytes);

            assert_eq!(
                result.info.LengthInMs, r.length_in_ms,
                "lengthInMs mismatch for {}",
                r.file
            );
            assert_eq!(
                result.info.FriendlyName, r.friendly_name,
                "friendlyName mismatch for {}",
                r.file
            );
            assert_eq!(
                result.header.Branch, r.branch,
                "branch mismatch for {}",
                r.file
            );
            assert_eq!(
                result.header.EngineNetworkVersion as u32, r.engine_network_version,
                "engineNetworkVersion mismatch for {}",
                r.file
            );
            assert_eq!(
                result.header.NetworkVersion as u32, r.network_version,
                "networkVersion mismatch for {}",
                r.file
            );

            let mut counts: HashMap<String, u32> = HashMap::new();
            for e in &result.exports {
                *counts.entry(e.type_name.to_string()).or_insert(0) += 1;
            }
            assert_eq!(counts, r.type_counts, "typeCounts mismatch for {}", r.file);
            assert_eq!(
                result.exports.len() as u32,
                r.total_exports,
                "totalExports mismatch for {}",
                r.file
            );
        }
    }
}
