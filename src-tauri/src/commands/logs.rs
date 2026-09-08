use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// The log file's stem, shared with the logger registration in `lib.rs` so the
/// viewer reads the file the app actually writes. It matches the product name
/// the plugin defaulted to, so an existing install keeps its log rather than
/// stranding it beside a new one.
pub const LOG_FILE_NAME: &str = "ValoUtils";

/// How much of the tail to parse. The file rotates at 2MB, and the entries
/// worth reading are always the recent ones; a session that filled the whole
/// file does not need every line of it in a WebView.
const TAIL_BYTES: u64 = 512 * 1024;
/// Cap on entries handed to the frontend, newest kept.
const MAX_ENTRIES: usize = 2000;
const LEVELS: [&str; 5] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    Some(dir.join(format!("{LOG_FILE_NAME}.log")))
}

/// Read the last `TAIL_BYTES` of the file as text.
///
/// Seeking into the middle can land inside a UTF-8 sequence, so the read is
/// lossy and the first (probably partial) line is dropped by the caller.
fn read_tail(path: &Path) -> Result<(String, u64, bool), String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    let truncated = size > TAIL_BYTES;
    if truncated {
        file.seek(SeekFrom::Start(size - TAIL_BYTES))
            .map_err(|error| error.to_string())?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok((String::from_utf8_lossy(&bytes).into_owned(), size, truncated))
}

/// Split one formatted line into timestamp, target, level and message.
///
/// The logger writes `[date][time][target][LEVEL] message`. Anything that does
/// not open with those four fields is a continuation — a panic backtrace, or a
/// message carrying newlines — and belongs to the entry above it. The level is
/// checked against the real set so a message full of brackets cannot pose as a
/// header.
fn parse_line(line: &str) -> Option<(String, String, String, String)> {
    let mut rest = line;
    let mut fields: Vec<&str> = Vec::with_capacity(4);
    for _ in 0..4 {
        rest = rest.strip_prefix('[')?;
        let end = rest.find(']')?;
        fields.push(&rest[..end]);
        rest = &rest[end + 1..];
    }
    let level = fields[3].to_ascii_uppercase();
    LEVELS.contains(&level.as_str()).then(|| {
        (
            format!("{} {}", fields[0], fields[1]),
            fields[2].to_string(),
            level,
            rest.trim().to_string(),
        )
    })
}

fn parse_entries(text: &str, skip_first: bool) -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if skip_first && index == 0 {
            continue;
        }
        match parse_line(line) {
            Some((timestamp, target, level, message)) => entries.push(json!({
                "timestamp": timestamp,
                "target": target,
                "level": level,
                "message": message,
            })),
            None if line.trim().is_empty() => {}
            // A line the format does not cover still belongs in the log, so it
            // joins the entry above rather than being dropped.
            None => match entries.last_mut() {
                Some(previous) => {
                    let message = previous["message"].as_str().unwrap_or_default();
                    previous["message"] = json!(format!("{message}\n{line}"));
                }
                None => entries.push(json!({
                    "timestamp": Value::Null,
                    "target": Value::Null,
                    "level": "INFO",
                    "message": line,
                })),
            },
        }
    }
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    entries
}

#[tauri::command]
pub fn logs_read(app: AppHandle) -> String {
    let Some(path) = log_path(&app) else {
        return json!({ "success": false, "error": "The log directory is unavailable." }).to_string();
    };
    let display_path = path.to_string_lossy().to_string();
    if !path.exists() {
        // Nothing has been logged yet. That is an empty log, not a failure.
        return json!({
            "success": true,
            "path": display_path,
            "entries": [],
            "bytes": 0,
            "truncated": false,
        })
        .to_string();
    }

    match read_tail(&path) {
        Ok((text, size, truncated)) => json!({
            "success": true,
            "path": display_path,
            "entries": parse_entries(&text, truncated),
            "bytes": size,
            "truncated": truncated,
        })
        .to_string(),
        Err(error) => json!({ "success": false, "path": display_path, "error": error }).to_string(),
    }
}

#[tauri::command]
pub fn logs_open(app: AppHandle) -> String {
    let Some(path) = log_path(&app) else {
        return json!({ "success": false, "error": "The log directory is unavailable." }).to_string();
    };
    // Reveal the file where it exists, and its folder where it does not —
    // pointing the file manager at something missing is an error for no reason.
    let target = match path.exists() {
        true => path.clone(),
        false => path.parent().map_or_else(|| path.clone(), PathBuf::from),
    };
    match app.opener().reveal_item_in_dir(&target) {
        Ok(()) => json!({ "success": true, "path": target.to_string_lossy() }).to_string(),
        Err(error) => json!({ "success": false, "error": error.to_string() }).to_string(),
    }
}

#[tauri::command]
pub fn logs_clear(app: AppHandle) -> String {
    let Some(path) = log_path(&app) else {
        return json!({ "success": false, "error": "The log directory is unavailable." }).to_string();
    };
    if !path.exists() {
        return json!({ "success": true }).to_string();
    }
    // Truncated rather than removed: the logger holds the file open, and
    // deleting it out from under that handle sends later writes nowhere.
    match std::fs::write(&path, b"") {
        Ok(()) => json!({ "success": true }).to_string(),
        Err(error) => json!({ "success": false, "error": error.to_string() }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = "[2026-09-08][12:34:56][valoutils::commands::live_party][WARN] Riot throttled /mmr/v1/players/<id>";

    #[test]
    fn a_formatted_line_splits_into_its_parts() {
        let (timestamp, target, level, message) = parse_line(LINE).expect("line must parse");

        assert_eq!(timestamp, "2026-09-08 12:34:56");
        assert_eq!(target, "valoutils::commands::live_party");
        assert_eq!(level, "WARN");
        assert_eq!(message, "Riot throttled /mmr/v1/players/<id>");
    }

    #[test]
    fn a_line_that_is_not_an_entry_is_not_mistaken_for_one() {
        assert!(parse_line("   at valoutils::commands::live::fetch").is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("[2026-09-08][12:34:56] missing fields").is_none());
        // Four bracketed fields, but the fourth is not a level.
        assert!(parse_line("[a][b][c][d] message").is_none());
    }

    #[test]
    fn a_continuation_line_joins_the_entry_above_it() {
        let text = format!("{LINE}\n    caused by: connection reset\n");
        let entries = parse_entries(&text, false);

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0]["message"],
            "Riot throttled /mmr/v1/players/<id>\n    caused by: connection reset"
        );
    }

    #[test]
    fn a_partial_first_line_is_dropped_when_the_read_started_mid_file() {
        let text = format!("ttled /mmr/v1/players/<id>\n{LINE}\n");

        assert_eq!(parse_entries(&text, true).len(), 1);
        // Without the truncation flag the same fragment is kept: it is then a
        // real line the format simply does not cover.
        let whole = parse_entries(&text, false);
        assert_eq!(whole.len(), 2);
        assert_eq!(whole[0]["message"], "ttled /mmr/v1/players/<id>");
    }

    #[test]
    fn only_the_most_recent_entries_survive_the_cap() {
        let text = (0..MAX_ENTRIES + 50)
            .map(|index| format!("[2026-09-08][12:34:56][valoutils][INFO] entry {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let entries = parse_entries(&text, false);

        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0]["message"], "entry 50");
        assert_eq!(
            entries[MAX_ENTRIES - 1]["message"],
            format!("entry {}", MAX_ENTRIES + 49)
        );
    }
}
