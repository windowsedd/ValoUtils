pub mod abilities;
pub mod extract;
pub mod io;
pub mod ooz;
#[cfg(test)]
mod test_support;
pub mod transform;
pub mod unreal;
pub mod valorant;

pub use abilities::build_abilities;
pub use extract::extract_records;
pub use transform::apply_transform;
pub use unreal::ParseMode;
pub use valorant::{parse_replay_for_app, AppChannelOpen, AppExportRecord, MovementSample};

use std::path::Path;

/// Runs the full in-process pipeline that used to be `sidecar/replay-parser.ts`:
/// parse the `.vrf` bytes, extract positions/events/meta, and (if any actor
/// channels were observed) build the abilities timeline. Writes
/// `channels.jsonl`/`positions.json`/`events.json`/`meta.json`/`abilities.json`
/// into `out_dir`, matching the exact shapes the existing frontend/`replays.rs`
/// already expect from the old sidecar's output.
pub fn process_replay_file(
    vrf_bytes: &[u8],
    out_dir: &Path,
    source_label: &str,
    on_progress: impl Fn(&str, &str),
) -> Result<(), String> {
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let channels_path = out_dir.join("channels.jsonl");
    let positions_path = out_dir.join("positions.json");
    let abilities_path = out_dir.join("abilities.json");

    on_progress("parsing", "Parsing replay...");
    let result = parse_replay_for_app(vrf_bytes, None, Some(ParseMode::Full));

    let map_url = result
        .header
        .LevelNamesAndTimes
        .iter()
        .find(|(level, _)| level.starts_with("/Game/Maps/"))
        .map(|(level, _)| level.clone())
        .unwrap_or_default();
    let map_name = map_url
        .split('/')
        .filter(|s| !s.is_empty())
        .last()
        .unwrap_or_default()
        .to_string();

    write_channels_jsonl(&channels_path, &result.channel_opens)?;

    on_progress("extracting", "Extracting positions...");
    extract_records(
        &result.export_records,
        &result.movement,
        result.movement_record_count,
        out_dir,
        source_label,
        &map_name,
        &map_url,
    )?;

    if !result.channel_opens.is_empty() {
        on_progress("abilities", "Building abilities...");
        build_abilities(&channels_path, &positions_path, &abilities_path)?;
    } else {
        std::fs::write(&abilities_path, "[]").map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Mirrors the TS sidecar's `channelOpens.map(o => JSON.stringify(o)).join("\n")`
/// — each line is `{"ev":"open","t":...,"x":...,"y":...,"cls":"..."}`, the shape
/// `abilities::build_abilities` parses back out. Key order matters here: TS
/// object property order (and `abilities.rs`'s `starts_with("{\"ev\":\"open\"")`
/// filter) requires `ev` to be first — built as a plain string rather than via
/// `serde_json::json!`/`serde_json::Value`, since that `Map` type does not
/// preserve insertion order without the `preserve_order` feature (it would
/// otherwise emit keys alphabetically and silently break the prefix filter).
fn write_channels_jsonl(path: &Path, channel_opens: &[AppChannelOpen]) -> Result<(), String> {
    let lines: Vec<String> = channel_opens
        .iter()
        .map(|o| {
            format!(
                "{{\"ev\":\"open\",\"t\":{},\"x\":{},\"y\":{},\"cls\":{}}}",
                serde_json::to_string(&o.t).unwrap(),
                serde_json::to_string(&o.x).unwrap(),
                serde_json::to_string(&o.y).unwrap(),
                serde_json::to_string(&o.cls).unwrap(),
            )
        })
        .collect();
    std::fs::write(path, lines.join("\n")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod process_replay_file_tests {
    use super::process_replay_file;
    use crate::replay::test_support::{assert_json_eq, fixture_bytes, golden_dir, read_json};

    fn check(vrf_name: &str, uuid: &str) {
        let bytes = fixture_bytes(vrf_name);
        let out_dir = std::env::temp_dir().join(format!("replay-rust-e2e-{uuid}"));
        let _ = std::fs::remove_dir_all(&out_dir);
        process_replay_file(&bytes, &out_dir, vrf_name, |_, _| {})
            .expect("pipeline should succeed");

        let golden = golden_dir(uuid);
        for file in [
            "positions.json",
            "events.json",
            "meta.json",
            "abilities.json",
        ] {
            let actual = read_json(&out_dir.join(file));
            let expected = read_json(&golden.join(file));
            assert_json_eq(&actual, &expected, file);
        }
    }

    #[test]
    fn end_to_end_matches_golden_5c673443() {
        check(
            "5c673443-5bdc-4576-b416-aab3f62471a5.vrf",
            "5c673443-5bdc-4576-b416-aab3f62471a5",
        );
    }

    #[test]
    fn end_to_end_matches_golden_9f8b32c5() {
        check(
            "9f8b32c5-c243-41ec-bbbb-832582edf652.vrf",
            "9f8b32c5-c243-41ec-bbbb-832582edf652",
        );
    }
}
