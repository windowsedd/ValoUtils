//! Downstream JSON-building logic ported from `sidecar/replay/extract.ts`.
//!
//! Only the in-process `extractRecords` path is ported (the `extractStream`
//! variant reads an external `decode-full.txt` file produced by a standalone
//! `.exe` parser that this crate's callers never invoke — see that file's
//! module doc comment in the TS source).
//!
//! [`extract_records`] folds a slice of [`crate::replay::AppExportRecord`] into an
//! accumulator, then writes `positions.json`, `events.json`, and `meta.json`
//! into the given output directory — byte-for-byte-equivalent (modulo the
//! wall-clock `generatedAt` field and floating point text formatting) to
//! what the TS sidecar produces.
//!
//! # Judgment calls vs. the TS source
//!
//! - TS's `processRecord` looks for a `MapUrl`/`MapURL`/`MapAssetPath`/
//!   `MapName` field on *every* record type via a generic, case-insensitive
//!   `getField` helper (this only matters for the `extractStream` decode-log
//!   path, where records come from a loosely-typed external process). None
//!   of the registered Valorant models in this Rust port
//!   (`BombPlayerState`, `BombTeamComponent`, `ClientGamePhaseEnded`,
//!   `BombGameState`, or the movement RPC type) ever carry such a field, so
//!   this is dead code in both the TS in-process path and here — it's kept
//!   only for structural parity in case a future model adds one.
//! - **Movement comes from `AppParseResult.movement`, not `export_records`.**
//!   `push_export` (see `valorant/replay_reader.rs`) deliberately never
//!   emits an `AppExportRecord` for the movement RPC type
//!   (`ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous`) —
//!   that data is instead pre-flattened into `AppParseResult.movement:
//!   Vec<MovementSample>` by `AppHooks::collect_movement`. So unlike TS
//!   `extractRecords` (which pattern-matches record `type` strings out of a
//!   single homogeneous stream to find movement), this port takes
//!   `movement` as its own parameter and builds `samples` from it directly.
//!   Two knock-on changes to `app_parser.rs` were needed to keep this
//!   faithful:
//!   - `MovementSample` gained a `rot_z: f64` field (`RotationInput.Z`,
//!     TS `toRotationZ`) — the previous flattening only kept
//!     `Position.{X,Y,Z}`, discarding the rotation TS's `extract.ts` needs.
//!   - `AppExportRecord` gained a `sample_index: usize` field — the running
//!     `movement.len()` at the moment each record was read. TS's
//!     `state.phaseEvents`/`state.bombStates` entries store
//!     `sampleIdx: state.samples.length` *at the time that record was
//!     processed*, which depended on movement and non-movement records
//!     sharing one interleaved stream. Once movement was split into its own
//!     vector, reconstructing that same chronological relationship
//!     requires this stamp (recorded live during parsing, since it can't be
//!     recovered after the fact from two already-separated lists).
//!   - `AppParseResult` gained `movement_record_count: u64` — TS
//!     `state.movementLines` counts one per movement RPC record seen,
//!     *not* one per sample (a record's `RemoteCharacterUpdates` can hold
//!     zero, one, or many position-bearing moves) — again only obtainable
//!     live, from inside `on_export_read`.
//!   - Neither change is exercised by any other code/tests in this crate,
//!     so both are purely additive.
//!   - One residual, deliberately-accepted gap: TS marks a guid "seen"
//!     whenever its update's `Moves` array is non-empty, even if *none* of
//!     those moves carry a `Position` (only actually-positioned moves
//!     become samples). `AppParseResult.movement` only ever contains
//!     position-bearing samples, so a guid whose every move lacks a
//!     position would be absent from `uniqueGuids` here but present in TS.
//!     Confirmed to not occur in either golden fixture (both have
//!     `movesWithPosition == totalMoves` per
//!     `ts-replay-parser/src/valorant/__movement_refs__.json`).
//! - JS `Number.prototype.toFixed` rounds (for all practical replay
//!   coordinate/timestamp magnitudes) half-away-from-zero, which is exactly
//!   what Rust's `f64::round` does — so `round_to` below is a direct,
//!   faithful substitute, not an approximation.
//! - JS `JSON.stringify` renders `Infinity`/`-Infinity`/`NaN` as `null`;
//!   [`finite_or_null`] replicates that for the position bounds (relevant
//!   only if `extract_records` is ever called with zero samples, in which
//!   case the function also errors out before `events.json`/`meta.json` are
//!   written, matching the TS `throw`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::replay::unreal::FieldValue;
use crate::replay::{AppExportRecord, MovementSample};

/// Round `x` to `dp` decimal places — matches JS `Number(x.toFixed(dp))`.
///
/// Two simpler approaches were tried against the golden fixtures and both
/// produced mismatches, for two different reasons:
///
/// - `(x * 10^dp).round() / 10^dp` (round `f64::round`, which ties away
///   from zero): multiplying by `10^dp` in floating point introduces its
///   own binary rounding error, which can *manufacture* a tie (or push a
///   non-tie value across the rounding boundary) that the original value
///   never actually had — e.g. `2372.9499999999998` (whose true nearest
///   1-decimal value is unambiguously `2372.9`) became `2373.0` because
///   `2372.9499999999998 * 10` rounds to `23729.5` in `f64`.
/// - `format!("{:.dp}", x)`: Rust's float formatting performs
///   correctly-rounded binary-to-decimal conversion directly against `x`'s
///   exact value (no multiplication error), which fixed the above — but at
///   a handful of positions in the fixtures the true value genuinely *is*
///   an exact tie (e.g. a decoded position of exactly `1601.25`, confirmed
///   by dumping it with 20 digits of precision: binary fractions like this
///   terminate exactly in decimal, so this isn't a formatting artifact).
///   Rust's formatter ties to even there (`1601.25` -> `1601.2`), but the
///   golden fixture (produced by V8's `toFixed`) rounds `1601.25` ->
///   `1601.3` — away from zero, not to even.
///
/// So: get the *exact* decimal expansion of `x` (always finite and exact
/// for an `f64`, since binary fractions terminate in decimal — using 40
/// digits after the point is comfortably more than any value in this
/// crate's domain needs), then round that decimal string to `dp` places by
/// hand with half-away-from-zero tie-breaking. This has zero binary
/// floating-point error at any step and matches JS's tie behavior exactly.
fn round_to(x: f64, dp: i32) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let dp = dp.max(0) as usize;
    let negative = x.is_sign_negative() && x != 0.0;
    let exact = format!("{:.40}", x.abs());
    let (int_part, frac_part) = exact.split_once('.').unwrap();
    let mut digits: Vec<u8> = int_part.bytes().chain(frac_part.bytes()).map(|b| b - b'0').collect();
    let int_len = int_part.len();
    let round_pos = int_len + dp;
    let round_up = digits.get(round_pos).copied().unwrap_or(0) >= 5;
    digits.truncate(round_pos);
    if round_up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let new_int_len = digits.len() - dp;
    let int_str: String = digits[..new_int_len].iter().map(|d| (d + b'0') as char).collect();
    let s = if dp > 0 {
        let frac_str: String = digits[new_int_len..].iter().map(|d| (d + b'0') as char).collect();
        format!("{int_str}.{frac_str}")
    } else {
        int_str
    };
    let v: f64 = s.parse().unwrap();
    if negative {
        -v
    } else {
        v
    }
}

/// JS `Math.round`: ties round toward +Infinity (unlike Rust's `f64::round`,
/// which ties away from zero). Only used for the single `events.json`
/// `Math.round(...)` call in the TS source.
fn js_math_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// JS `JSON.stringify` serializes non-finite floats as `null`.
fn finite_or_null(x: f64) -> Value {
    if x.is_finite() {
        json!(x)
    } else {
        Value::Null
    }
}

fn field_to_json(v: &FieldValue) -> Value {
    match v {
        FieldValue::Bool(b) => json!(*b),
        FieldValue::U8(x) => json!(*x),
        FieldValue::I16(x) => json!(*x),
        FieldValue::U16(x) => json!(*x),
        FieldValue::I32(x) => json!(*x),
        FieldValue::U32(x) => json!(*x),
        FieldValue::U64(x) => json!(*x),
        FieldValue::F32(x) => json!(*x as f64),
        FieldValue::F64(x) => json!(*x),
        FieldValue::Str(s) => json!(s),
        _ => Value::Null,
    }
}

/// Days-since-epoch -> (year, month, day), Howard Hinnant's `civil_from_days`
/// algorithm. Used only to format `generatedAt`, which every test in this
/// crate excludes from golden-file comparison, so exactness isn't
/// safety-critical here — but a real ISO-8601 string is produced for
/// consumers outside the test suite.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = dur.as_millis() as i64;
    let secs = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (y, mo, d) = civil_from_days(days);
    let hh = sod / 3600;
    let mm = (sod % 3600) / 60;
    let ss = sod % 60;
    format!("{y:04}-{mo:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{ms:03}Z")
}

/// Mutable accumulator shared across all records — TS `ExtractState`.
struct ExtractState {
    samples: Vec<(i32, String, f64, f64, f64)>,
    player_state_by_ch: HashMap<u32, Map<String, Value>>,
    team_by_ch: HashMap<u32, u8>,
    map_url: String,
    phase_events: Vec<(u8, usize)>,
    bomb_states: Vec<(f64, usize)>,
    /// Membership set mirroring `guid_order`, kept alongside it purely so
    /// "have we seen this guid" is O(1) instead of an O(n) scan of
    /// `guid_order` — insertion order (matching JS `Set` iteration order,
    /// which is insertion order) is what actually ends up in
    /// `positions.json`'s `uniqueGuids`, so that's tracked separately here
    /// rather than relying on (unordered) `HashSet` iteration.
    guids_seen: HashSet<String>,
    guid_order: Vec<String>,
    movement_lines: u64,
    movement_moves: u64,
}

impl ExtractState {
    fn new(initial_map_url: &str) -> Self {
        ExtractState {
            samples: Vec::new(),
            player_state_by_ch: HashMap::new(),
            team_by_ch: HashMap::new(),
            map_url: initial_map_url.to_string(),
            phase_events: Vec::new(),
            bomb_states: Vec::new(),
            guids_seen: HashSet::new(),
            guid_order: Vec::new(),
            movement_lines: 0,
            movement_moves: 0,
        }
    }

    fn record_guid(&mut self, guid: &str) {
        if self.guids_seen.insert(guid.to_string()) {
            self.guid_order.push(guid.to_string());
        }
    }

    /// Populate `samples`/`guids_seen`/`guid_order`/`movement_moves` from
    /// the flattened movement stream (see module doc comment for why this
    /// isn't folded out of `AppExportRecord`s the way TS does it). Must run
    /// before any `BombGameState`/`ClientGamePhaseEnded` record is folded in
    /// via `process_record`, since those look up their `sampleIdx` directly
    /// off each `AppExportRecord::sample_index` rather than
    /// `state.samples.len()` — but `finalize`'s bounds/bounds-count logic
    /// still reads the fully-populated `samples` either way.
    fn seed_movement(&mut self, movement: &[MovementSample], movement_lines: u64) {
        self.movement_lines = movement_lines;
        self.movement_moves = movement.len() as u64;
        for m in movement {
            let guid = m.guid.to_string();
            self.record_guid(&guid);
            self.samples.push((
                m.t as i32,
                guid,
                round_to(m.x, 1),
                round_to(m.y, 1),
                round_to(m.rot_z, 2),
            ));
        }
    }
}

/// Field names TS's generic `getField(fields, "MapUrl", "MapURL", "MapAssetPath", "MapName")`
/// probes for, case-insensitively. See module doc comment: dead code for
/// every model this crate registers, kept for structural parity.
const MAP_URL_FIELD_NAMES: [&str; 4] = ["MapUrl", "MapURL", "MapAssetPath", "MapName"];

/// Fold a single non-movement export record into the accumulator. TS
/// `processRecord`'s `BombPlayerState`/`BombTeamComponent`/
/// `ClientGamePhaseEnded`/`BombGameState` branches (the movement branch is
/// handled by `ExtractState::seed_movement` instead — see module doc
/// comment).
fn process_record(state: &mut ExtractState, record: &AppExportRecord) {
    if state.map_url.is_empty() {
        for (name, value) in &record.fields {
            if MAP_URL_FIELD_NAMES.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                if let FieldValue::Str(s) = value {
                    state.map_url = s.clone();
                    break;
                }
            }
        }
    }

    match record.type_name {
        "BombPlayerState" => {
            let obj = state.player_state_by_ch.entry(record.ch).or_default();
            for (name, value) in &record.fields {
                obj.insert((*name).to_string(), field_to_json(value));
            }
        }
        "BombTeamComponent" => {
            if let Some((_, FieldValue::U8(v))) = record.fields.iter().find(|(name, _)| *name == "Team") {
                state.team_by_ch.insert(record.ch, *v);
            }
        }
        "ClientGamePhaseEnded" => {
            if let Some((_, FieldValue::U8(v))) = record.fields.iter().find(|(name, _)| *name == "OldPhase") {
                state.phase_events.push((*v, record.sample_index));
            }
        }
        "BombGameState" => {
            if let Some((_, FieldValue::F64(v))) = record
                .fields
                .iter()
                .find(|(name, _)| *name == "ReplicatedWorldTimeSecondsDouble")
            {
                state.bomb_states.push((round_to(*v, 3), record.sample_index));
            }
        }
        _ => {}
    }
}

/// Build and write `positions.json` / `events.json` / `meta.json` from the
/// accumulator. TS `finalize`. Returns `Err` (after `positions.json` is
/// already written, matching the TS `throw` placement) if no movement
/// samples were extracted.
fn finalize(state: &ExtractState, out_dir: &Path, source_label: &str, map_hint: &str) -> Result<(), String> {
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for s in &state.samples {
        if s.2 < min_x {
            min_x = s.2;
        }
        if s.2 > max_x {
            max_x = s.2;
        }
        if s.3 < min_y {
            min_y = s.3;
        }
        if s.3 > max_y {
            max_y = s.3;
        }
    }

    let mut players = Map::new();
    for (ch, fields) in &state.player_state_by_ch {
        let mut obj = fields.clone();
        if let Some(team) = state.team_by_ch.get(ch) {
            obj.insert("team".to_string(), json!(*team));
        }
        players.insert(ch.to_string(), Value::Object(obj));
    }

    let unique_guids: Vec<&str> = state.guid_order.iter().map(|s| s.as_str()).collect();
    let meta = json!({
        "source": source_label,
        "generatedAt": now_iso(),
        "movementLines": state.movement_lines,
        "movementMoves": state.movement_moves,
        "uniqueGuids": unique_guids,
        "bounds": {
            "minX": finite_or_null(min_x),
            "maxX": finite_or_null(max_x),
            "minY": finite_or_null(min_y),
            "maxY": finite_or_null(max_y),
        },
        "sampleCount": state.samples.len(),
        "phaseEventCount": state.phase_events.len(),
        "bombStateCount": state.bomb_states.len(),
    });

    let samples_json: Vec<Value> = state
        .samples
        .iter()
        .map(|s| json!([s.0, s.1, s.2, s.3, s.4]))
        .collect();
    let phase_events_json: Vec<Value> = state
        .phase_events
        .iter()
        .map(|(phase, idx)| json!({"phase": phase, "sampleIdx": idx}))
        .collect();
    let bomb_states_json: Vec<Value> = state
        .bomb_states
        .iter()
        .map(|(t, idx)| json!({"t": t, "sampleIdx": idx}))
        .collect();

    let positions = json!({
        "meta": meta,
        "players": players,
        "phaseEvents": phase_events_json,
        "bombStates": bomb_states_json,
        "samples": samples_json,
    });
    fs::write(
        out_dir.join("positions.json"),
        serde_json::to_string(&positions).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    if state.samples.is_empty() {
        return Err(format!(
            "No replay movement samples were extracted from {source_label}. Found {} movement lines and {} moves.",
            state.movement_lines, state.movement_moves
        ));
    }

    let mut events: Vec<Value> = Vec::new();
    if !state.bomb_states.is_empty() {
        let sample_to_wall_ms = |s_idx: usize| -> f64 {
            let mut lo = 0usize;
            let mut hi = state.bomb_states.len() - 1;
            while lo < hi {
                let mid = (lo + hi) / 2;
                if state.bomb_states[mid].1 < s_idx {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            let next = state.bomb_states[lo];
            if lo == 0 {
                return next.0 * 1000.0;
            }
            let prev = state.bomb_states[lo - 1];
            let span = next.1 as i64 - prev.1 as i64;
            let a = if span > 0 {
                (s_idx as i64 - prev.1 as i64) as f64 / span as f64
            } else {
                0.0
            };
            (prev.0 + (next.0 - prev.0) * a) * 1000.0
        };
        let wall_zero = sample_to_wall_ms(0);
        let mut seen_starts = HashSet::new();
        for (phase, idx) in &state.phase_events {
            if *phase != 2 {
                continue;
            }
            if !seen_starts.insert(*idx) {
                continue;
            }
            events.push(json!({
                "g": "roundStarted",
                "t": js_math_round(sample_to_wall_ms(*idx) - wall_zero),
            }));
        }
        if events.is_empty() {
            events.push(json!({"g": "roundStarted", "t": 0}));
        }
    }
    fs::write(
        out_dir.join("events.json"),
        serde_json::to_string(&events).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let meta_json = json!({
        "mapUrl": state.map_url,
        "mapName": map_hint,
        "generatedAt": now_iso(),
    });
    fs::write(
        out_dir.join("meta.json"),
        serde_json::to_string(&meta_json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// In-process port of TS `extractRecords`: fold `records` (everything
/// `push_export` collected — `BombPlayerState`/`BombTeamComponent`/
/// `ClientGamePhaseEnded`/`BombGameState`, etc.) and `movement` (the
/// flattened character-movement stream — see module doc comment for why
/// this is a separate parameter from `AppParseResult` rather than being
/// re-derived from `records`), then write
/// `positions.json`/`events.json`/`meta.json` into `out_dir`.
///
/// `movement_record_count` is `AppParseResult::movement_record_count` (TS
/// `state.movementLines`).
pub fn extract_records(
    records: &[AppExportRecord],
    movement: &[MovementSample],
    movement_record_count: u64,
    out_dir: &Path,
    source_label: &str,
    map_hint: &str,
    initial_map_url: &str,
) -> Result<(), String> {
    let mut state = ExtractState::new(initial_map_url);
    state.seed_movement(movement, movement_record_count);
    for r in records {
        process_record(&mut state, r);
    }
    finalize(&state, out_dir, source_label, map_hint)
}

#[cfg(test)]
mod tests {
    //! Golden-file parity tests: parse a real `.vrf` fixture with
    //! `parse_replay_for_app`, run it through `extract_records`, and assert
    //! the output matches what the TS sidecar actually produced for the
    //! same fixture (`test-fixtures/golden/<uuid>/`), field-by-field,
    //! ignoring the wall-clock `generatedAt` timestamp.

    use super::*;
    use crate::replay::test_support::{assert_json_eq, fixture_bytes, golden_dir, read_json};
    use crate::replay::ParseMode;

    /// Mirrors `replay-parser.ts`'s `runParser`: pick the first
    /// `/Game/Maps/` level name as `mapUrl`, and its last path segment as
    /// `mapName`.
    fn map_url_and_name(header: &crate::replay::unreal::models::ReplayHeader) -> (String, String) {
        let map_url = header
            .LevelNamesAndTimes
            .iter()
            .find(|(level, _)| level.starts_with("/Game/Maps/"))
            .map(|(level, _)| level.clone())
            .unwrap_or_default();
        let map_name = map_url.rsplit('/').find(|s| !s.is_empty()).unwrap_or("").to_string();
        (map_url, map_name)
    }

    fn run_and_check(uuid: &str, version: &str) {
        let bytes = fixture_bytes(&format!("{uuid}.vrf"));
        let result = crate::replay::parse_replay_for_app(&bytes, Some(version.to_string()), Some(ParseMode::Full));
        let (map_url, map_name) = map_url_and_name(&result.header);

        let out_dir = std::env::temp_dir().join(format!("replay-rust-extract-test-{uuid}"));
        std::fs::create_dir_all(&out_dir).unwrap();

        extract_records(
            &result.export_records,
            &result.movement,
            result.movement_record_count,
            &out_dir,
            &format!("{uuid}.vrf"),
            &map_name,
            &map_url,
        )
        .unwrap_or_else(|e| panic!("extract_records failed for {uuid}: {e}"));

        let golden = golden_dir(uuid);
        for file in ["positions.json", "events.json", "meta.json"] {
            let actual = read_json(&out_dir.join(file));
            let expected = read_json(&golden.join(file));
            assert_json_eq(&actual, &expected, file);
        }
    }

    #[test]
    fn matches_golden_9f8b32c5() {
        run_and_check("9f8b32c5-c243-41ec-bbbb-832582edf652", "12.10");
    }

    #[test]
    fn matches_golden_5c673443() {
        run_and_check("5c673443-5bdc-4576-b416-aab3f62471a5", "12.11");
    }
}
