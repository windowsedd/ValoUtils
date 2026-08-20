use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

pub const PUUID: &str = "41c322a1-b328-495b-a004-5ccd3e45eae8";
pub const GAME_NAME: &str = "ValoUtils Bot";
pub const TAG_LINE: &str = "BOT";
const MAX_MESSAGES: usize = 200;

pub fn help_text() -> &'static str {
    // Valorant whispers collapse newlines, so this has to stay one line.
    "$online · $offline · $mobile · $enable · $disable · $status · $help · .send {party|pregame|team|all} {language|code} {message} · .tran [n] · .dodge"
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FakePlayerCommand {
    Online,
    Offline,
    Mobile,
    Enable,
    Disable,
    Status,
    Help,
}

pub fn parse_command(body: &str) -> FakePlayerCommand {
    let command = body.trim().strip_prefix('$').unwrap_or(body.trim());
    match command.trim().to_ascii_lowercase().as_str() {
        "online" => FakePlayerCommand::Online,
        "offline" => FakePlayerCommand::Offline,
        "mobile" => FakePlayerCommand::Mobile,
        "enable" => FakePlayerCommand::Enable,
        "disable" => FakePlayerCommand::Disable,
        "status" => FakePlayerCommand::Status,
        "help" => FakePlayerCommand::Help,
        _ => FakePlayerCommand::Help,
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FakePlayerMessage {
    pub id: String,
    pub body: String,
    pub is_self: bool,
    pub timestamp: String,
}

fn messages() -> &'static Mutex<VecDeque<FakePlayerMessage>> {
    static MESSAGES: OnceLock<Mutex<VecDeque<FakePlayerMessage>>> = OnceLock::new();
    MESSAGES.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub fn record_message(body: impl Into<String>, is_self: bool) {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let mut transcript = messages().lock().unwrap();
    transcript.push_back(FakePlayerMessage {
        id: format!("fake-player-{sequence}"),
        body: body.into(),
        is_self,
        timestamp: now_iso_millis(),
    });
    while transcript.len() > MAX_MESSAGES {
        transcript.pop_front();
    }
}

pub fn transcript() -> Vec<FakePlayerMessage> {
    messages().lock().unwrap().iter().cloned().collect()
}

#[cfg(test)]
fn clear_transcript() {
    messages().lock().unwrap().clear();
}

fn now_iso_millis() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let (year, month, day, hour, minute, second) =
        crate::util_time::civil_from_unix_secs(now.as_secs() as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        now.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_text_lists_presence_commands_and_the_translate_command() {
        let help = help_text();
        assert!(help.contains("$online"));
        assert!(help.contains("$help"));
        assert!(help.contains(".send {party|pregame|team|all} {language|code} {message}"));
        assert!(help.contains(".tran [n]"));
        assert!(help.contains(".dodge"));
        assert!(
            !help.contains('\n'),
            "Valorant whispers strip newlines, so help must stay one line"
        );
    }

    #[test]
    fn parses_commands_with_an_optional_prefix_and_uses_help_as_fallback() {
        assert_eq!(parse_command("online"), FakePlayerCommand::Online);
        assert_eq!(parse_command(" $OFFLINE "), FakePlayerCommand::Offline);
        assert_eq!(parse_command("$mobile"), FakePlayerCommand::Mobile);
        assert_eq!(parse_command("enable"), FakePlayerCommand::Enable);
        assert_eq!(parse_command("$disable"), FakePlayerCommand::Disable);
        assert_eq!(parse_command("status"), FakePlayerCommand::Status);
        assert_eq!(parse_command("anything else"), FakePlayerCommand::Help);
    }

    #[test]
    fn bounds_the_real_relay_transcript() {
        clear_transcript();
        for index in 0..205 {
            record_message(format!("message {index}"), index % 2 == 0);
        }
        let messages = transcript();
        assert_eq!(messages.len(), 200);
        assert_eq!(messages.first().unwrap().body, "message 5");
        assert_eq!(messages.last().unwrap().body, "message 204");
    }
}
