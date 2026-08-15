//! Developer Test Lab probes for the local Riot Client chat API.
//!
//! These commands exist so Settings can hit the documented localhost routes
//! without going through the Chat page. Send still uses the same channel
//! resolver as the rest of the app: All never falls through to Team.

use crate::riot::chat::RiotChatClient;
use crate::riot::client::{self as riot_client, RiotState};
use crate::riot::models::ChatChannel;
use serde_json::{json, Value};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabInfoKind {
    Party,
    Pregame,
    Current,
    All,
}

pub fn parse_lab_info_kind(raw: &str) -> Result<LabInfoKind, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "party" => Ok(LabInfoKind::Party),
        "pregame" | "pre-game" => Ok(LabInfoKind::Pregame),
        "current" | "coregame" | "current-game" => Ok(LabInfoKind::Current),
        "all" => Ok(LabInfoKind::All),
        _ => Err(format!(
            "Unknown chat lab probe '{raw}'. Use party, pregame, current or all."
        )),
    }
}

pub fn parse_lab_send_channel(raw: &str) -> Result<ChatChannel, String> {
    ChatChannel::parse(raw)
        .ok_or_else(|| format!("Unknown chat channel '{raw}'. Use party, pregame, team or all."))
}

fn arg(args: &[Value], index: usize) -> String {
    args.get(index)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

#[tauri::command]
pub async fn chat_lab_info(args: Vec<Value>, riot: State<'_, RiotState>) -> Result<String, ()> {
    let kind_input = arg(&args, 0);
    let kind = match parse_lab_info_kind(&kind_input) {
        Ok(kind) => kind,
        Err(error) => {
            return Ok(json!({ "success": false, "error": error }).to_string());
        }
    };
    let result = match kind {
        LabInfoKind::Party => riot_client::get_party_chat_info(&riot).await,
        LabInfoKind::Pregame => riot_client::get_pre_game_chat_info(&riot).await,
        LabInfoKind::Current => riot_client::get_current_game_chat_info(&riot).await,
        LabInfoKind::All => riot_client::get_chat_conversations(&riot).await,
    };
    Ok(match result {
        Ok(data) => json!({ "success": true, "kind": kind_input, "data": data }).to_string(),
        Err(error) => json!({ "success": false, "kind": kind_input, "error": error }).to_string(),
    })
}

#[tauri::command]
pub async fn chat_lab_send(args: Vec<Value>) -> Result<String, ()> {
    let channel_input = arg(&args, 0);
    let message = arg(&args, 1);
    if message.is_empty() {
        return Ok(json!({ "success": false, "error": "Message is empty." }).to_string());
    }
    let channel = match parse_lab_send_channel(&channel_input) {
        Ok(channel) => channel,
        Err(error) => return Ok(json!({ "success": false, "error": error }).to_string()),
    };
    let client = match RiotChatClient::connect() {
        Ok(client) => client,
        Err(error) => {
            return Ok(json!({ "success": false, "error": error.to_string() }).to_string())
        }
    };
    Ok(match client.send_message(channel, &message).await {
        Ok(()) => json!({
            "success": true,
            "channel": channel.as_str(),
            "message": message,
        })
        .to_string(),
        Err(error) => json!({ "success": false, "error": error.to_string() }).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_four_lab_probes() {
        assert_eq!(parse_lab_info_kind("party").unwrap(), LabInfoKind::Party);
        assert_eq!(
            parse_lab_info_kind("pre-game").unwrap(),
            LabInfoKind::Pregame
        );
        assert_eq!(
            parse_lab_info_kind("current-game").unwrap(),
            LabInfoKind::Current
        );
        assert_eq!(parse_lab_info_kind("all").unwrap(), LabInfoKind::All);
        assert!(parse_lab_info_kind("team").is_err());
    }

    #[test]
    fn send_channels_stay_distinct() {
        assert_eq!(parse_lab_send_channel("party").unwrap(), ChatChannel::Party);
        assert_eq!(
            parse_lab_send_channel("pregame").unwrap(),
            ChatChannel::Pregame
        );
        assert_eq!(parse_lab_send_channel("team").unwrap(), ChatChannel::Team);
        assert_eq!(parse_lab_send_channel("all").unwrap(), ChatChannel::All);
        assert!(parse_lab_send_channel("current").is_err());
    }
}
