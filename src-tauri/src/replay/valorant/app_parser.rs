//! App-facing convenience parser. Ported from
//! `package/ts-replay-parser/src/valorant/app-parser.ts`.
//!
//! Produces the record streams ValoUtils' replay pipeline consumes so the
//! external `ValorantReplayParser.exe` can be replaced with this in-process
//! parser:
//!  - `export_records` — one per replicated export group.
//!  - `channel_opens`  — actor-channel open events with location + resolved
//!    class path.
//!  - `movement`       — flattened character-movement samples (requires
//!    `ParseMode::Full`).
//!
//! TS: `class AppReader extends ValorantReplayReader`. Rust has no impl
//! inheritance, so `AppHooks` is its own `ReplayReaderHooks<ValorantReplay>`
//! impl that calls the same free functions `replay_reader.rs`'s `ValorantHooks`
//! uses (`push_export`, `do_decompress`, `do_transform`) instead of
//! duplicating that logic.

use crate::replay::io::binary_reader::BinaryReader;
use crate::replay::unreal::enums::ParseMode;
use crate::replay::unreal::models::Actor;
use crate::replay::unreal::registry::NetFieldRegistry;
use crate::replay::unreal::replay_reader::{ExportedValue, ReplayReader, ReplayReaderHooks};

use super::models::{register_all, RemoteCharacterUpdate};
use super::replay_reader::{do_decompress, do_transform, push_export, ExportRecord, ValorantReplay, REMOTE_CHARACTER_UPDATES_RPC_TYPE};

/// One decoded character-movement tick (the local player).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MovementSample {
    /// Character net GUID the move belongs to.
    pub guid: u32,
    /// Move timestamp (replay-relative).
    pub t: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// `RotationInput.Z` (or `0.0` if the move carries no rotation input) —
    /// added for the `extract.rs`/downstream-JSON phase, which needs the
    /// same `rotationZ` value TS's `extract.ts` `toRotationZ()` reads.
    pub rot_z: f64,
}

/// Actor-channel open event (TS `AppChannelOpen`).
#[derive(Clone, Debug, PartialEq)]
pub struct AppChannelOpen {
    pub t: f32,
    pub x: f64,
    pub y: f64,
    pub cls: String,
}

/// One exported field (TS `{ Name, Value }`). `fields` on [`AppExportRecord`]
/// carries the same `(&'static str, FieldValue)` pairs `ExportRecord` does —
/// see that struct's doc comment for why `FieldValue` isn't converted into a
/// separate JSON-like value type in this phase.
pub struct AppExportRecord {
    pub ch: u32,
    pub type_name: &'static str,
    pub fields: Vec<(&'static str, crate::replay::unreal::models::FieldValue)>,
    /// Number of `MovementSample`s collected *before* this record was read
    /// (i.e. `AppParseResult.movement[..sample_index]` is everything that
    /// preceded it in true replay-stream order). The movement RPC type
    /// itself never produces an `AppExportRecord` (see `push_export`'s
    /// early-return for it), so every record's `sample_index` reflects the
    /// running movement-sample count at that point in the single
    /// interleaved record stream — added for the downstream JSON-building
    /// phase (`extract.rs`), which needs this to reproduce TS `extract.ts`'s
    /// `sampleIdx` (`state.samples.length` at the moment each
    /// `BombGameState`/`ClientGamePhaseEnded` record was processed).
    pub sample_index: usize,
}

impl From<ExportRecord> for AppExportRecord {
    fn from(r: ExportRecord) -> Self {
        AppExportRecord {
            ch: r.channel_index,
            type_name: r.type_name,
            fields: r.fields,
            sample_index: 0,
        }
    }
}

#[derive(Default)]
pub struct AppParseResult {
    pub info: crate::replay::unreal::models::ReplayInfo,
    pub header: crate::replay::unreal::models::ReplayHeader,
    pub export_records: Vec<AppExportRecord>,
    pub channel_opens: Vec<AppChannelOpen>,
    /// Flattened character-movement positions (requires `ParseMode::Full`).
    pub movement: Vec<MovementSample>,
    /// Count of movement RPC records seen (one per
    /// `ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous`
    /// export, regardless of whether it yielded any `MovementSample`s) —
    /// TS `extract.ts`'s `state.movementLines`. Added for the downstream
    /// JSON-building phase (`extract.rs`), which reports this count
    /// separately from the total move count in `positions.json`'s `meta`.
    pub movement_record_count: u64,
}

struct AppHooks {
    version: Option<String>,
    export_records: Vec<AppExportRecord>,
    channel_opens: Vec<AppChannelOpen>,
    movement: Vec<MovementSample>,
    movement_record_count: u64,
}

impl AppHooks {
    fn new(version: Option<String>) -> Self {
        AppHooks {
            version,
            export_records: Vec::new(),
            channel_opens: Vec::new(),
            movement: Vec::new(),
            movement_record_count: 0,
        }
    }

    /// TS `AppReader.collectMovement`: flattens one `RemoteCharacterUpdate`'s
    /// `ComponentDataStream.Moves` (if any) into `MovementSample`s.
    fn collect_movement(&mut self, update: &RemoteCharacterUpdate) {
        let guid = match update.ShooterCharacterNetGuidValue {
            Some(g) => g,
            None => return,
        };
        let stream = match &update.ComponentDataStream {
            Some(s) => s,
            None => return,
        };
        for m in &stream.Moves {
            if let Some(pos) = &m.Position {
                self.movement.push(MovementSample {
                    guid,
                    t: m.Timestamp,
                    x: pos.X,
                    y: pos.Y,
                    z: pos.Z,
                    rot_z: m.RotationInput.as_ref().map(|r| r.Z).unwrap_or(0.0),
                });
            }
        }
    }
}

impl ReplayReaderHooks<ValorantReplay> for AppHooks {
    fn create_replay(&mut self) -> ValorantReplay {
        ValorantReplay::default()
    }

    fn decompress(&mut self, archive: BinaryReader) -> BinaryReader {
        do_decompress(archive)
    }

    fn on_export_read(&mut self, channel_index: u32, export_group: Option<ExportedValue>) {
        // TS: `super.onExportRead(...)` (push into `exports`, skipping the
        // RemoteCharacterUpdates RPC type) THEN look at the raw
        // `exportGroup` directly (even for the skipped RPC type) to collect
        // movement — `push_export` already does the "collect regular
        // exports, skip the RPC carrier" half; the movement half needs the
        // model reference before it's consumed, so it's inspected first.
        if let Some(ExportedValue::Model(model)) = &export_group {
            if model.type_name() == REMOTE_CHARACTER_UPDATES_RPC_TYPE {
                self.movement_record_count += 1;
                if let Some(rpc) = model.as_any().downcast_ref::<super::models::ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous>() {
                    if let Some(updates) = &rpc.RemoteCharacterUpdates {
                        for u in updates.iter().flatten() {
                            self.collect_movement(u);
                        }
                    }
                }
            }
        }

        let mut exports = Vec::new();
        push_export(&mut exports, channel_index, export_group);
        let sample_index = self.movement.len();
        self.export_records.extend(exports.into_iter().map(|r| {
            let mut record = AppExportRecord::from(r);
            record.sample_index = sample_index;
            record
        }));
    }

    fn on_channel_opened(&mut self, _channel_index: u32, actor: Option<&Actor>, archetype_path: Option<&str>, frame_time_seconds: f32) {
        let actor = match actor {
            Some(a) => a,
            None => return,
        };
        let path = archetype_path.unwrap_or("");
        let location = actor.Location.unwrap_or_default();
        self.channel_opens.push(AppChannelOpen {
            t: frame_time_seconds,
            x: location.X,
            y: location.Y,
            cls: path.to_string(),
        });
    }

    fn transform_bunch_payload(&mut self, actor_guid: Option<u32>, payload: Vec<u8>, payload_bits: u32, header_branch: &str) -> Vec<u8> {
        do_transform(&self.version, actor_guid, payload, payload_bits, header_branch)
    }
}

/// Parse a `.vrf` replay into the app's record streams. TS: `parseReplayForApp`.
pub fn parse_replay_for_app(bytes: &[u8], version: Option<String>, mode: Option<ParseMode>) -> AppParseResult {
    let mut registry = NetFieldRegistry::new();
    register_all(&mut registry);
    let hooks = AppHooks::new(version);
    let mut reader: ReplayReader<ValorantReplay, AppHooks> = ReplayReader::new(mode.unwrap_or(ParseMode::Full), hooks, registry);

    let mut archive = BinaryReader::new(bytes.to_vec());
    let replay = reader.read_replay_from_archive(&mut archive);
    let info = replay.Info.clone();
    let header = replay.Header.clone();
    // `replay`'s borrow of `reader` ends at its last use above.

    AppParseResult {
        info,
        header,
        export_records: std::mem::take(&mut reader.hooks.export_records),
        channel_opens: std::mem::take(&mut reader.hooks.channel_opens),
        movement: std::mem::take(&mut reader.hooks.movement),
        movement_record_count: reader.hooks.movement_record_count,
    }
}
