//! Readable Markdown for MCP tool results. Agents show tool output to players,
//! so lists of players, matches or friends become tables and other values
//! become labelled lines, instead of raw JSON. The JSON still goes out as
//! `structuredContent` for clients that read it.

use serde_json::Value;

/// Keys shown in upper case.
const ACRONYMS: [&str; 12] = ["rr", "xp", "puuid", "id", "acs", "adr", "kd", "dpr", "vp", "url", "ads", "uuid"];

/// Fields that identify a row or answer the question, shown first. Everything
/// else follows alphabetically (serde_json keeps object keys sorted here).
const LEADING: [&str; 14] = [
    "player", "riotId", "name", "tier", "agent", "map", "mode", "result", "score",
    "rank", "currentRank", "currentRr", "code", "online",
];

fn order(key: &str) -> (usize, String) {
    let position = LEADING.iter().position(|lead| *lead == key).unwrap_or(LEADING.len());
    (position, key.to_string())
}

/// Rows rendered per table before the rest is summarized.
const MAX_ROWS: usize = 50;
/// Columns rendered per table; the rest is left out to keep tables readable.
const MAX_COLUMNS: usize = 9;

/// `xpTowardNextTier` → "XP toward next tier"; `riotId` → "Riot ID".
pub fn humanize(key: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    for c in key.chars() {
        if (c.is_uppercase() || c == '_') && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        if c != '_' {
            current.push(c);
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let lower = word.to_lowercase();
            if ACRONYMS.contains(&lower.as_str()) {
                lower.to_uppercase()
            } else if index == 0 {
                let mut chars = lower.chars();
                chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
            } else {
                lower
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        let whole = value as i64;
        // Thousands separators for big numbers (XP, VP), not for years or IDs.
        if whole.abs() >= 10_000 {
            let digits = whole.abs().to_string();
            let mut grouped = String::new();
            for (index, digit) in digits.chars().enumerate() {
                if index > 0 && (digits.len() - index).is_multiple_of(3) {
                    grouped.push(',');
                }
                grouped.push(digit);
            }
            return if whole < 0 { format!("-{grouped}") } else { grouped };
        }
        return whole.to_string();
    }
    let text = format!("{value:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// A one-line rendering, or `None` when the value needs more room.
fn inline(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("—".into()),
        Value::Bool(flag) => Some(if *flag { "yes" } else { "no" }.into()),
        Value::Number(n) => Some(n.as_f64().map(number).unwrap_or_else(|| n.to_string())),
        Value::String(text) => Some(if text.is_empty() { "—".into() } else { text.clone() }),
        Value::Array(items) if items.is_empty() => Some("none".into()),
        Value::Array(items) if items.iter().all(|item| !item.is_object() && !item.is_array()) => {
            Some(items.iter().filter_map(inline).collect::<Vec<_>>().join(", "))
        }
        // A live score reads "7–5 (12 rounds played)", yours first.
        Value::Object(map) if map.contains_key("yourTeam") && map.contains_key("enemyTeam") => {
            let side = |key: &str| map.get(key).and_then(inline).unwrap_or_default();
            let rounds = map
                .get("roundsPlayed")
                .and_then(inline)
                .map(|rounds| format!(" ({rounds} rounds played)"))
                .unwrap_or_default();
            Some(format!("{}–{}{rounds}", side("yourTeam"), side("enemyTeam")))
        }
        // Small labelled objects (a rank `{ tier, name }`) read as their name.
        Value::Object(map) if map.contains_key("name") && map.len() <= 3 => inline(&map["name"]),
        Value::Object(map) if map.len() <= 3 && map.values().all(|v| !v.is_object() && !v.is_array()) => Some(
            map.iter()
                .map(|(key, value)| format!("{} {}", humanize(key).to_lowercase(), inline(value).unwrap_or_default()))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        _ => None,
    }
}

fn cell(value: &Value) -> String {
    inline(value)
        .unwrap_or_else(|| value.to_string())
        .replace('|', "\\|")
        .replace(['\n', '\r'], " ")
}

fn table(rows: &[Value], out: &mut String) {
    let mut columns: Vec<String> = Vec::new();
    for row in rows {
        if let Some(map) = row.as_object() {
            for key in map.keys() {
                if !columns.contains(key) {
                    columns.push(key.clone());
                }
            }
        }
    }
    columns.sort_by_key(|column| order(column));
    // Columns that are empty in every row add nothing.
    columns.retain(|column| rows.iter().any(|row| row.get(column).is_some_and(|v| !v.is_null())));
    columns.truncate(MAX_COLUMNS);
    out.push_str(&format!("| {} |\n", columns.iter().map(|c| humanize(c)).collect::<Vec<_>>().join(" | ")));
    out.push_str(&format!("|{}\n", " --- |".repeat(columns.len())));
    for row in rows.iter().take(MAX_ROWS) {
        let cells: Vec<String> = columns.iter().map(|column| row.get(column).map(cell).unwrap_or_else(|| "—".into())).collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    if rows.len() > MAX_ROWS {
        out.push_str(&format!("\n…and {} more.\n", rows.len() - MAX_ROWS));
    }
    out.push('\n');
}

fn section(title: &str, depth: usize, out: &mut String) {
    let hashes = "#".repeat((depth + 2).min(6));
    out.push_str(&format!("{hashes} {}\n\n", humanize(title)));
}

fn render(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Object(map) => {
            // Short values first as a list, then the bigger parts as sections.
            let mut lines = String::new();
            let mut sections: Vec<(&String, &Value)> = Vec::new();
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by_key(|(key, _)| order(key));
            for (key, entry) in entries {
                match inline(entry) {
                    Some(text) => lines.push_str(&format!("- **{}:** {}\n", humanize(key), text)),
                    None => sections.push((key, entry)),
                }
            }
            if !lines.is_empty() {
                out.push_str(&lines);
                out.push('\n');
            }
            for (key, entry) in sections {
                section(key, depth, out);
                render(entry, depth + 1, out);
            }
        }
        Value::Array(items) if items.iter().all(Value::is_object) => table(items, out),
        Value::Array(items) => {
            for item in items {
                match inline(item) {
                    Some(text) => out.push_str(&format!("- {text}\n")),
                    None => render(item, depth + 1, out),
                }
            }
            out.push('\n');
        }
        other => {
            out.push_str(&inline(other).unwrap_or_default());
            out.push('\n');
        }
    }
}

/// Markdown for a tool's result value.
pub fn to_markdown(value: &Value) -> String {
    let mut out = String::new();
    render(value, 0, &mut out);
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_read_as_labels() {
        assert_eq!(humanize("xpTowardNextTier"), "XP toward next tier");
        assert_eq!(humanize("riotId"), "Riot ID");
        assert_eq!(humanize("currentRr"), "Current RR");
        assert_eq!(humanize("puuid"), "PUUID");
    }

    #[test]
    fn overview_becomes_labelled_lines_and_a_table() {
        let markdown = to_markdown(&json!({
            "riotId": "Me#NA1",
            "currentRank": { "tier": 21, "name": "Ascendant 1" },
            "currentRr": 40,
            "inQueue": false,
            "recentCompetitive": [
                { "map": "Ascent", "rrEarned": 21, "rankAfter": { "tier": 21, "name": "Ascendant 1" } },
                { "map": "Bind", "rrEarned": -15, "rankAfter": null },
            ],
        }));
        assert!(markdown.contains("- **Riot ID:** Me#NA1"));
        assert!(markdown.contains("- **Current rank:** Ascendant 1"));
        assert!(markdown.contains("- **In queue:** no"));
        assert!(markdown.contains("## Recent competitive"));
        assert!(markdown.contains("| Map | Rank after | RR earned |"));
        assert!(markdown.contains("| Bind | — | -15 |"));
        // The answer-like fields lead.
        assert!(markdown.find("Riot ID").unwrap() < markdown.find("In queue").unwrap());
    }

    #[test]
    fn live_score_reads_yours_first() {
        let markdown = to_markdown(&json!({ "score": { "yourTeam": 7, "enemyTeam": 5, "roundsPlayed": 12 } }));
        assert_eq!(markdown, "- **Score:** 7–5 (12 rounds played)");
    }

    #[test]
    fn numbers_are_tidy_and_cells_are_escaped() {
        assert_eq!(number(150000.0), "150,000");
        assert_eq!(number(2026.0), "2026");
        assert_eq!(number(25.554), "25.55");
        assert_eq!(cell(&json!("a|b\nc")), "a\\|b c");
    }

    #[test]
    fn long_tables_are_cut_with_a_count() {
        let rows: Vec<Value> = (0..60).map(|i| json!({ "n": i })).collect();
        let markdown = to_markdown(&json!({ "friends": rows }));
        assert!(markdown.contains("…and 10 more."));
    }
}
