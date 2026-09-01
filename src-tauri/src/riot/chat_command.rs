//! Parsing of the manual translation command.
//!
//! ```text
//! .send {party|pregame|team|all} {language} {message}
//! .send {party|pregame|team|all} {message}
//! .tran [n]
//! .translate [n]
//! .tran {party|team|all} [n]
//! .dodge
//! ```
//!
//! The `.send` form is what you type in a hurry: channel, optional language,
//! then the rest of the line, kept verbatim. If the language is omitted, the
//! caller supplies the Settings target language.
//!
//! The parsed channel is carried through to the send; there is no arm anywhere
//! in this module that substitutes one channel for another.

use crate::riot::error::RiotError;
use crate::riot::models::ChatChannel;
use serde::{Deserialize, Serialize};

pub const HISTORY_TRANSLATE_MAX: usize = 10;
pub const HISTORY_TRANSLATE_DEFAULT: usize = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CustomCommandWhen {
    #[default]
    Command,
    OnPregame,
    OnMatchStart,
    OnMatchEnd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomBotCommand {
    #[serde(default)]
    pub when: CustomCommandWhen,
    pub trigger: String,
    pub action: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub count: u64,
}

pub fn normalize_custom_trigger(raw: &str) -> String {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('.') || trimmed.starts_with('$') {
        trimmed
    } else {
        format!(".{trimmed}")
    }
}

pub fn is_reserved_custom_trigger(raw: &str) -> bool {
    matches!(
        normalize_custom_trigger(raw).as_str(),
        ".send"
            | ".tran"
            | ".translate"
            | ".dodge"
            | "$online"
            | "$offline"
            | "$mobile"
            | "$enable"
            | "$disable"
            | "$status"
            | "$help"
    )
}

pub fn find_custom_command(input: &str, commands: &[CustomBotCommand]) -> Option<CustomBotCommand> {
    let first = input.trim().split_whitespace().next()?;
    let wanted = normalize_custom_trigger(first);
    if wanted.is_empty() || is_reserved_custom_trigger(&wanted) {
        return None;
    }
    commands
        .iter()
        .find(|item| {
            item.when == CustomCommandWhen::Command
                && normalize_custom_trigger(&item.trigger) == wanted
        })
        .cloned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpandedCustomCommand {
    History(String),
    Group(String),
    Direct { language: String, message: String },
}

pub fn expand_matched_custom_command(
    command: &CustomBotCommand,
    resolved_message: &str,
) -> Option<ExpandedCustomCommand> {
    match command.action.trim().to_ascii_lowercase().as_str() {
        "send" => {
            let message = resolved_message.trim();
            if message.is_empty() {
                return None;
            }
            let language = match command.language.trim() {
                "" => "none",
                value => value,
            };
            if command.channel.trim().eq_ignore_ascii_case("direct") {
                return Some(ExpandedCustomCommand::Direct {
                    language: language.to_string(),
                    message: message.to_string(),
                });
            }
            let channel = if command.channel.trim().is_empty() {
                "team"
            } else {
                command.channel.trim()
            };
            Some(ExpandedCustomCommand::Group(format!(
                ".send {channel} {language} {message}"
            )))
        }
        "tran" => {
            let count = command.count.max(1);
            let channel = command.channel.trim();
            if channel.eq_ignore_ascii_case("direct") {
                return None;
            }
            if channel.is_empty() {
                Some(ExpandedCustomCommand::History(format!(".tran {count}")))
            } else {
                Some(ExpandedCustomCommand::History(format!(
                    ".tran {channel} {count}"
                )))
            }
        }
        _ => None,
    }
}

pub fn expand_custom_command(input: &str, commands: &[CustomBotCommand]) -> Option<String> {
    let command = find_custom_command(input, commands)?;
    match expand_matched_custom_command(&command, &command.message)? {
        ExpandedCustomCommand::History(command) | ExpandedCustomCommand::Group(command) => {
            Some(command)
        }
        ExpandedCustomCommand::Direct { .. } => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryTranslateCommand {
    pub channel: Option<ChatChannel>,
    pub count: usize,
    pub language: String,
    pub language_input: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationCommand {
    /// The channel the player named. The reply goes here and nowhere else.
    pub channel: ChatChannel,
    /// Provider code the language resolved to, e.g. `de`.
    pub language: String,
    /// Exactly what the player typed for the language, kept for error text.
    pub language_input: String,
    /// The message, verbatim - inner slashes, unicode and all.
    pub message: String,
}

/// Cheap check for whether a line even looks like a command.
///
/// Used by the poller to decide if a message from the local player is worth
/// parsing. Local-player messages are otherwise ignored entirely, so this is
/// the single door through which they re-enter the pipeline.
pub fn is_translation_command(input: &str) -> bool {
    is_dot_command(input, ".send")
}

pub fn is_dodge_command(input: &str) -> bool {
    is_dot_command(input, ".dodge")
}

fn is_dot_command(input: &str, command: &str) -> bool {
    let trimmed = input.trim_start();
    let Some(head) = trimmed.get(..command.len()) else {
        return false;
    };
    head.eq_ignore_ascii_case(command)
        && trimmed
            .as_bytes()
            .get(command.len())
            .map(|byte| byte.is_ascii_whitespace())
            .unwrap_or(true)
}

pub fn is_history_translate_command(input: &str) -> bool {
    history_translate_rest(input).is_some()
}

fn history_translate_rest(input: &str) -> Option<&str> {
    let trimmed = input.trim_start();
    for prefix in [".translate", ".tran"] {
        let Some(head) = trimmed.get(..prefix.len()) else {
            continue;
        };
        if !head.eq_ignore_ascii_case(prefix) {
            continue;
        }
        let rest = &trimmed[prefix.len()..];
        if rest.is_empty() || rest.starts_with(|c: char| c.is_whitespace()) {
            return Some(rest.trim());
        }
    }
    None
}

pub fn parse_history_translate_command(
    input: &str,
    provider: &str,
    default_language: Option<&str>,
) -> Result<HistoryTranslateCommand, RiotError> {
    let Some(rest) = history_translate_rest(input) else {
        return Err(RiotError::InvalidCommand(
            "Commands must start with .tran or .translate.".into(),
        ));
    };

    let mut channel = None;
    let mut count = HISTORY_TRANSLATE_DEFAULT;
    let mut language_input = default_language.unwrap_or("en").to_string();
    let mut saw_count = false;

    for raw in rest.split_whitespace() {
        if let Some(parsed_count) = parse_history_count(raw) {
            count = parsed_count;
            saw_count = true;
            continue;
        }
        if let Some(parsed_channel) = ChatChannel::parse(raw) {
            channel = Some(parsed_channel);
            continue;
        }
        if let Some(language) = crate::translate::resolve_target_language(provider, raw) {
            language_input = language;
            continue;
        }
        return Err(RiotError::InvalidCommand(format!(
            "Unknown .tran argument '{raw}'. Use .tran [n] or .tran {{channel}} [n]."
        )));
    }

    let Some(language) = crate::translate::resolve_target_language(provider, &language_input)
    else {
        return Err(RiotError::InvalidCommand(format!(
            "Unknown language '{language_input}'."
        )));
    };
    let _ = saw_count;

    Ok(HistoryTranslateCommand {
        channel,
        count: count.clamp(1, HISTORY_TRANSLATE_MAX),
        language,
        language_input,
    })
}

pub fn is_skippable_history_line(body: &str) -> bool {
    let body = body.trim();
    body.is_empty()
        || is_translation_command(body)
        || is_history_translate_command(body)
        || is_dodge_command(body)
        || body.starts_with('$')
}

fn parse_history_count(raw: &str) -> Option<usize> {
    let digits = raw.trim().trim_matches(|c| c == '[' || c == ']');
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// What actually goes into the room: original first, translation under it.
pub fn outgoing_translation_body(original: &str, translated: &str) -> String {
    let original = original.trim();
    let translated = translated.trim();
    if original.is_empty() {
        return translated.to_string();
    }
    if translated.is_empty() || original.eq_ignore_ascii_case(translated) {
        return original.to_string();
    }
    format!("{original}\n{translated}")
}

/// Parses and fully validates a command.
///
/// Validation covers all four things the spec calls for - channel, language,
/// non-empty message, and (by the caller, which knows the live session) channel
/// availability. Availability is deliberately *not* checked here: this function
/// is pure so it can be tested without a Riot Client, and the caller re-checks
/// against live CIDs immediately afterwards.
pub fn parse_translation_command(
    input: &str,
    provider: &str,
) -> Result<TranslationCommand, RiotError> {
    parse_translation_command_with_fallback(input, provider, None)
}

pub fn parse_translation_command_with_fallback(
    input: &str,
    provider: &str,
    default_language: Option<&str>,
) -> Result<TranslationCommand, RiotError> {
    let trimmed = input.trim_start();
    if !is_dot_command(trimmed, ".send") {
        return Err(RiotError::InvalidCommand(
            "Commands must start with .send.".into(),
        ));
    }
    parse_dot_send(&trimmed[5..], provider, default_language)
}

fn parse_dot_send(
    rest: &str,
    provider: &str,
    default_language: Option<&str>,
) -> Result<TranslationCommand, RiotError> {
    let rest = rest.trim();
    let (channel_input, after_channel) = split_first_token(rest);
    let Some(channel) = ChatChannel::parse(channel_input) else {
        return Err(RiotError::InvalidCommand(format!(
            "Unknown chat channel '{channel_input}'. Use party, pregame, team or all."
        )));
    };

    let after_channel = after_channel.trim();
    if after_channel.is_empty() {
        return Err(RiotError::EmptyMessage);
    }

    let (first, remainder) = split_first_token(after_channel);
    let (language, language_input, message) = if first.eq_ignore_ascii_case("none") {
        if remainder.trim().is_empty() {
            return Err(RiotError::EmptyMessage);
        }
        ("none".to_string(), first.to_string(), remainder.to_string())
    } else if let Some(language) = crate::translate::resolve_target_language(provider, first) {
        if remainder.trim().is_empty() {
            return Err(RiotError::EmptyMessage);
        }
        (language, first.to_string(), remainder.to_string())
    } else if let Some(default) = default_language
        .and_then(|value| crate::translate::resolve_target_language(provider, value))
    {
        (default.clone(), default, after_channel.to_string())
    } else {
        return Err(RiotError::InvalidCommand(format!(
            "Unknown language '{first}'. Use .send {{channel}} {{language}} {{message}}."
        )));
    };

    Ok(TranslationCommand {
        channel,
        language,
        language_input,
        message,
    })
}

fn split_first_token(value: &str) -> (&str, &str) {
    match value.split_once(char::is_whitespace) {
        Some((head, tail)) => (head, tail),
        None => (value, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> Result<TranslationCommand, RiotError> {
        parse_translation_command(input, "google")
    }

    fn custom(
        when: CustomCommandWhen,
        trigger: &str,
        action: &str,
        channel: &str,
        message: &str,
    ) -> CustomBotCommand {
        CustomBotCommand {
            when,
            trigger: trigger.into(),
            action: action.into(),
            channel: channel.into(),
            language: "none".into(),
            message: message.into(),
            count: 1,
        }
    }

    #[test]
    fn old_json_defaults_when_to_command() {
        let command: CustomBotCommand = serde_json::from_value(serde_json::json!({
            "trigger": "eco",
            "action": "send",
            "channel": "team",
            "language": "none",
            "message": "save",
            "count": 5
        }))
        .unwrap();
        assert_eq!(command.when, CustomCommandWhen::Command);
    }

    #[test]
    fn lifecycle_entries_do_not_match_chat_triggers() {
        let commands = vec![custom(
            CustomCommandWhen::OnPregame,
            "ready",
            "send",
            "direct",
            "Agent select",
        )];
        assert!(find_custom_command("ready", &commands).is_none());
    }

    #[test]
    fn direct_send_expands_without_entering_dot_send_syntax() {
        let command = custom(
            CustomCommandWhen::Command,
            "dm",
            "send",
            "direct",
            "raw template",
        );
        assert_eq!(
            expand_matched_custom_command(&command, "Ascent"),
            Some(ExpandedCustomCommand::Direct {
                language: "none".into(),
                message: "Ascent".into(),
            })
        );
        assert_eq!(expand_custom_command("dm", &[command]), None);
    }

    #[test]
    fn group_and_history_expansion_remain_typed() {
        let group = custom(
            CustomCommandWhen::Command,
            "gg",
            "send",
            "team",
            "good game",
        );
        assert_eq!(
            expand_matched_custom_command(&group, "good game"),
            Some(ExpandedCustomCommand::Group(
                ".send team none good game".into()
            ))
        );
        let history = custom(CustomCommandWhen::Command, "last", "tran", "team", "");
        assert_eq!(
            expand_matched_custom_command(&history, ""),
            Some(ExpandedCustomCommand::History(".tran team 1".into()))
        );
    }

    #[test]
    fn parses_the_documented_examples() {
        let team = parse(".send team german hello").unwrap();
        assert_eq!(team.channel, ChatChannel::Team);
        assert_eq!(team.language, "de");
        assert_eq!(team.message, "hello");

        let all = parse(".send all french hello everyone").unwrap();
        assert_eq!(all.channel, ChatChannel::All);
        assert_eq!(all.language, "fr");
        assert_eq!(all.message, "hello everyone");

        let party = parse(".send party japanese how are you?").unwrap();
        assert_eq!(party.channel, ChatChannel::Party);
        assert_eq!(party.language, "ja");
        assert_eq!(party.message, "how are you?");
    }

    #[test]
    fn every_channel_keyword_resolves_to_its_own_variant() {
        assert_eq!(
            parse(".send party de x").unwrap().channel,
            ChatChannel::Party
        );
        assert_eq!(
            parse(".send pregame de x").unwrap().channel,
            ChatChannel::Pregame
        );
        assert_eq!(parse(".send team de x").unwrap().channel, ChatChannel::Team);
        assert_eq!(parse(".send all de x").unwrap().channel, ChatChannel::All);
    }

    #[test]
    fn parsing_all_never_yields_team() {
        // The Java original read `all` and then sent to the team CID. The
        // parser is the first place that bug could reappear, so pin it here as
        // well as at the routing layer.
        for input in [
            ".send all german push a",
            ".send ALL german push a",
            ".send All german push a",
        ] {
            assert_eq!(parse(input).unwrap().channel, ChatChannel::All);
        }
    }

    #[test]
    fn regioned_language_codes_are_consumed_not_left_in_the_message() {
        // `.send party ko-KR …` used to fall through to Settings zh-TW and
        // post "ko-KR" as part of the text. The locale must be the language.
        let command = parse_translation_command_with_fallback(
            ".send party ko-KR do u like 金正恩",
            "google",
            Some("zh-TW"),
        )
        .unwrap();
        assert_eq!(command.channel, ChatChannel::Party);
        assert_eq!(command.language, "ko");
        assert_eq!(command.language_input, "ko-KR");
        assert_eq!(command.message, "do u like 金正恩");

        let ja = parse(".send team ja-JP gl hf").unwrap();
        assert_eq!(ja.language, "ja");
        assert_eq!(ja.message, "gl hf");

        // `.send team kr …` used to miss Korean (`ko`) and either error or
        // keep "kr" in the message while translating to Settings zh-TW.
        let kr =
            parse_translation_command_with_fallback(".send team kr gl hf", "google", Some("zh-TW"))
                .unwrap();
        assert_eq!(kr.language, "ko");
        assert_eq!(kr.language_input, "kr");
        assert_eq!(kr.message, "gl hf");

        let us = parse(".send all us gl hf").unwrap();
        assert_eq!(us.language, "en");
        assert_eq!(us.message, "gl hf");
        let jp = parse(".send party jp gl hf").unwrap();
        assert_eq!(jp.language, "ja");
        assert_eq!(jp.message, "gl hf");
    }

    #[test]
    fn chinese_region_codes_resolve_with_underscore_hyphen_or_slash() {
        for input in [
            ".send party zh_tw hello",
            ".send party zh-tw hello",
            ".send party zh/tw hello",
            ".send party zhtw hello",
        ] {
            let command = parse(input).unwrap();
            assert_eq!(command.channel, ChatChannel::Party);
            assert_eq!(command.language, "zh-TW");
            assert_eq!(command.message, "hello", "{input}");
        }

        for input in [
            ".send all zh_cn hello",
            ".send all zh-cn hello",
            ".send all zh/cn hello",
            ".send all zhcn hello",
        ] {
            let command = parse(input).unwrap();
            assert_eq!(command.channel, ChatChannel::All);
            assert_eq!(command.language, "zh-CN");
            assert_eq!(command.message, "hello", "{input}");
        }
    }

    #[test]
    fn slashes_inside_the_message_survive_intact() {
        let command = parse(".send all french go a/b then rotate // fast").unwrap();
        assert_eq!(command.message, "go a/b then rotate // fast");
        assert_eq!(command.channel, ChatChannel::All);
    }

    #[test]
    fn unicode_quotes_backslashes_and_newlines_survive_intact() {
        let body = "\"quoted\" back\\slash \u{65e5}\u{672c}\u{8a9e} \u{1f3af}\nsecond line";
        let command = parse(&format!(".send team german {body}")).unwrap();
        assert_eq!(command.message, body);
    }

    #[test]
    fn a_message_that_is_only_whitespace_is_rejected() {
        assert!(matches!(
            parse(".send team german   "),
            Err(RiotError::EmptyMessage)
        ));
        assert!(matches!(
            parse(".send team   "),
            Err(RiotError::EmptyMessage)
        ));
    }

    #[test]
    fn bad_channels_and_languages_are_named_in_the_error() {
        let channel_error = parse(".send spectator german hi").unwrap_err();
        assert!(channel_error.to_string().contains("spectator"));

        let language_error = parse(".send team klingon hi").unwrap_err();
        assert!(language_error.to_string().contains("klingon"));
    }

    #[test]
    fn non_commands_are_rejected_and_not_mistaken_for_chat_commands() {
        assert!(parse("hello team").is_err());
        assert!(!is_translation_command("hello team"));
        assert!(!is_translation_command("translate this for me"));
    }

    #[test]
    fn the_retired_slash_form_is_no_longer_a_command() {
        // `TR/send/...` used to be the only spelling. It is now ordinary chat
        // text, so it must neither parse nor be recognised by the poller.
        assert!(parse("TR/send/team/german/hello").is_err());
        assert!(!is_translation_command("TR/send/team/german/hello"));
        assert!(!is_translation_command("tr/send/all/french/hi"));
        assert!(!is_skippable_history_line("TR/send/team/german/hello"));
    }

    #[test]
    fn parses_the_spaced_dot_send_form() {
        let command = parse(".send party zh_tw hello everyone").unwrap();
        assert_eq!(command.channel, ChatChannel::Party);
        assert_eq!(command.language, "zh-TW");
        assert_eq!(command.message, "hello everyone");

        let team = parse(".SEND team french gl hf").unwrap();
        assert_eq!(team.channel, ChatChannel::Team);
        assert_eq!(team.language, "fr");
        assert_eq!(team.message, "gl hf");
    }

    #[test]
    fn dot_send_can_omit_language_when_a_default_is_supplied() {
        let command = parse_translation_command_with_fallback(
            ".send party hello everyone",
            "google",
            Some("zh-TW"),
        )
        .unwrap();
        assert_eq!(command.language, "zh-TW");
        assert_eq!(command.message, "hello everyone");
        assert!(parse(".send party hello everyone").is_err());
    }

    #[test]
    fn dot_send_none_is_an_explicit_no_translation_mode() {
        let command = parse_translation_command_with_fallback(
            ".send team none keep this exact text",
            "google",
            Some("ko"),
        )
        .unwrap();

        assert_eq!(command.channel, ChatChannel::Team);
        assert_eq!(command.language, "none");
        assert_eq!(command.language_input, "none");
        assert_eq!(command.message, "keep this exact text");
    }

    #[test]
    fn blank_custom_language_is_none_and_preserves_a_message_starting_with_none() {
        let command = CustomBotCommand {
            when: CustomCommandWhen::Command,
            trigger: "pass".into(),
            action: "send".into(),
            channel: "team".into(),
            language: String::new(),
            message: "none shall pass".into(),
            count: 0,
        };
        let expanded = expand_custom_command(".pass", &[command]).unwrap();
        let parsed =
            parse_translation_command_with_fallback(&expanded, "google", Some("ko")).unwrap();

        assert_eq!(parsed.language, "none");
        assert_eq!(parsed.message, "none shall pass");
    }

    #[test]
    fn outgoing_body_keeps_the_original_and_the_translation() {
        assert_eq!(
            outgoing_translation_body("hello everyone", "bonjour tout le monde"),
            "hello everyone\nbonjour tout le monde"
        );
        assert_eq!(outgoing_translation_body("hello", "hello"), "hello");
    }

    #[test]
    fn expands_custom_send_and_tran_shortcuts() {
        let commands = vec![
            CustomBotCommand {
                when: CustomCommandWhen::Command,
                trigger: "gg".into(),
                action: "send".into(),
                channel: "team".into(),
                language: "zh_tw".into(),
                message: "gl hf".into(),
                count: 0,
            },
            CustomBotCommand {
                when: CustomCommandWhen::Command,
                trigger: ".last".into(),
                action: "tran".into(),
                channel: "party".into(),
                language: String::new(),
                message: String::new(),
                count: 3,
            },
        ];
        assert_eq!(
            expand_custom_command(".gg", &commands).as_deref(),
            Some(".send team zh_tw gl hf")
        );
        assert_eq!(
            expand_custom_command("GG", &commands).as_deref(),
            Some(".send team zh_tw gl hf")
        );
        assert_eq!(
            expand_custom_command(".last", &commands).as_deref(),
            Some(".tran party 3")
        );
        assert!(expand_custom_command(".send", &commands).is_none());
        assert!(is_reserved_custom_trigger("tran"));
    }

    #[test]
    fn finds_a_saved_command_without_losing_its_template() {
        let command = CustomBotCommand {
            when: CustomCommandWhen::Command,
            trigger: "scout".into(),
            action: "send".into(),
            channel: "team".into(),
            language: "none".into(),
            message: "Enemy KDA: {{enemy_team_kda}}".into(),
            count: 0,
        };

        assert_eq!(
            find_custom_command(".scout", &[command.clone()]),
            Some(command)
        );
        assert!(find_custom_command(".send", &[]).is_none());
    }

    #[test]
    fn parses_history_translate_count_and_optional_channel() {
        let defaulted = parse_history_translate_command(".tran", "google", Some("zh-TW")).unwrap();
        assert_eq!(defaulted.count, 1);
        assert_eq!(defaulted.channel, None);
        assert_eq!(defaulted.language, "zh-TW");

        let bracket = parse_history_translate_command(".tran [5]", "google", Some("en")).unwrap();
        assert_eq!(bracket.count, 5);

        let numbered =
            parse_history_translate_command(".translate 3", "google", Some("en")).unwrap();
        assert_eq!(numbered.count, 3);

        let team = parse_history_translate_command(".tran team 5", "google", Some("en")).unwrap();
        assert_eq!(team.channel, Some(ChatChannel::Team));
        assert_eq!(team.count, 5);

        assert!(is_history_translate_command(".tran [5]"));
        assert!(is_history_translate_command("  .TRANSLATE 2"));
        assert!(!is_history_translate_command(".send party zh_tw hi"));
        assert!(!is_history_translate_command(".transit"));
        assert!(is_skippable_history_line(".tran [5]"));
        assert!(is_skippable_history_line(".send party zh_tw hi"));
        assert!(is_skippable_history_line(".dodge"));
        assert!(!is_skippable_history_line("Haha, stultusne es?"));
        assert_eq!(
            parse_history_translate_command(".tran 99", "google", Some("en"))
                .unwrap()
                .count,
            HISTORY_TRANSLATE_MAX
        );
    }

    #[test]
    fn the_prefix_check_is_case_insensitive_and_ignores_leading_space() {
        assert!(is_translation_command(".send party zh_tw hi"));
        assert!(is_translation_command("  .SEND team french hi"));
        assert!(!is_translation_command(".sendfriend hi"));
        assert_eq!(
            parse("  .SEND all french hi").unwrap().channel,
            ChatChannel::All
        );
    }

    #[test]
    fn dodge_is_a_reserved_bare_command() {
        assert!(is_dodge_command(".dodge"));
        assert!(is_dodge_command("  .DODGE"));
        assert!(is_dodge_command(".dodge now"));
        assert!(!is_dodge_command(".dodger"));
        assert!(!is_dodge_command("dodge"));
        assert!(is_reserved_custom_trigger("dodge"));
        assert!(is_reserved_custom_trigger(".dodge"));
    }
}
