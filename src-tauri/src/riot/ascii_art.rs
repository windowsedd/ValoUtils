//! The `.ascii` chat command: short phrases rendered as block text.
//!
//! ```text
//! .ascii <text>
//! .ascii {team|all|party} <text>
//! ```
//!
//! Everything here is pure so the parser, the fonts and the layout can be
//! tested without a Riot Client. The one thing this module deliberately does
//! not do is pick a channel when none was typed - that needs the live session,
//! so [`AsciiCommand::channel`] stays `None` and the caller supplies the room
//! the command was entered in.
//!
//! # Layout
//!
//! Letters are solid [`INK`] blocks on a [`BACKGROUND`] field, which VALORANT
//! draws as a hatched panel with the word standing out of it.
//!
//! The payload contains no newline characters. Instead, every visual row is
//! padded to VALORANT's 26-column chat width and concatenated; the game wraps
//! the single message back into the intended panel. The compact face is used
//! so a six-character phrase such as `HK GAY` fits on one visual line.
//!
//! [`MAX_COLUMNS`] is the one number here that is a judgement call rather than
//! arithmetic. See its comment before changing anything else.

use crate::riot::error::RiotError;
use crate::riot::models::ChatChannel;

/// The widest a rendered row may be, in block characters.
///
/// Riot does not document this width. It comes from the known-good sample used
/// for runtime verification: 234 characters divide into exactly nine rows of
/// 26. Changing it changes the wire format, not just the visual padding.
pub const MAX_COLUMNS: usize = 26;
/// Nine complete wrapped rows (234 characters) stay below the game's message
/// length limit while preserving the 26-column alignment.
pub const MAX_PAYLOAD_CHARACTERS: usize = MAX_COLUMNS * 9;
/// Background columns between adjacent glyphs.
pub const GLYPH_GAP: usize = 1;
/// Background rows between stacked words.
pub const LINE_GAP: usize = 1;
/// Background rows and columns framing the panel.
pub const BORDER: usize = 1;
/// The lit character.
pub const INK: char = '█';
/// The unlit character. VALORANT renders it as hatching, so it is the panel's
/// texture rather than dead space.
pub const BACKGROUND: char = '░';

const USAGE: &str = "Usage: .ascii {team|all|party} <text> or .ascii <text>.";

/// A parsed `.ascii` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsciiCommand {
    /// The channel named as the first argument, if any. `None` means "the
    /// channel this was typed in", which only the caller can resolve.
    pub channel: Option<ChatChannel>,
    /// The normalized artwork text: trimmed, uppercased, single-spaced.
    pub text: String,
    /// The rendered message, ready to post as-is.
    pub payload: String,
}

/// Which of the two faces drew a payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Face {
    /// Five rows of four columns. Reads best; runs out of width first.
    Bold,
    /// Three rows of three columns, using half-blocks for the extra vertical
    /// detail. Fits roughly half again as many characters on a line.
    Compact,
}

impl Face {
    fn rows(self) -> usize {
        match self {
            Face::Bold => 5,
            Face::Compact => 3,
        }
    }

    fn columns(self) -> usize {
        match self {
            Face::Bold => 4,
            Face::Compact => 3,
        }
    }

    /// Columns a run of `characters` glyphs occupies, gaps included.
    fn width(self, characters: usize) -> usize {
        characters * self.columns() + characters.saturating_sub(1) * GLYPH_GAP
    }

    fn supports(self, character: char) -> bool {
        match self {
            Face::Bold => bold_glyph(character).is_some(),
            Face::Compact => compact_glyph(character).is_some(),
        }
    }

    /// One glyph as [`Self::rows`] strings of [`Self::columns`] characters.
    fn glyph(self, character: char) -> Vec<String> {
        match self {
            Face::Bold => bold_glyph(character)
                .expect("normalized text has a glyph for every character")
                .iter()
                .map(|row| row.chars().map(paint).collect())
                .collect(),
            Face::Compact => {
                let bitmap = compact_glyph(character)
                    .expect("normalized text has a glyph for every character");
                (0..self.rows())
                    .map(|row| compress_row(bitmap, row))
                    .collect()
            }
        }
    }
}

fn paint(cell: char) -> char {
    if cell == '#' {
        INK
    } else {
        BACKGROUND
    }
}

/// Cheap check for whether a line is the `.ascii` command.
///
/// Matches the word exactly, so `.asciify` is not a `.ascii` with a weird
/// argument - it is somebody else's command, or nothing at all.
pub fn is_ascii_command(input: &str) -> bool {
    ascii_rest(input).is_some()
}

fn ascii_rest(input: &str) -> Option<&str> {
    const PREFIX: &str = ".ascii";
    let trimmed = input.trim_start();
    let head = trimmed.get(..PREFIX.len())?;
    if !head.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let rest = &trimmed[PREFIX.len()..];
    if rest.is_empty() || rest.starts_with(char::is_whitespace) {
        Some(rest.trim())
    } else {
        None
    }
}

/// Whether a token is a reserved destination rather than artwork text.
///
/// `.ascii team` means "send to Team with no message", not "draw the word
/// TEAM". Reserving the three names unconditionally keeps the first argument
/// unambiguous instead of guessing from what follows it.
fn parse_destination(token: &str) -> Option<ChatChannel> {
    match token.to_ascii_lowercase().as_str() {
        "team" => Some(ChatChannel::Team),
        "all" => Some(ChatChannel::All),
        "party" => Some(ChatChannel::Party),
        _ => None,
    }
}

/// Parses and fully validates a `.ascii` line.
///
/// Channel *availability* is not checked here - that needs the live session,
/// and the caller resolves the room immediately afterwards.
pub fn parse_ascii_command(input: &str) -> Result<AsciiCommand, RiotError> {
    let Some(rest) = ascii_rest(input) else {
        return Err(RiotError::InvalidCommand(
            "Commands must start with .ascii.".into(),
        ));
    };

    let (first, remainder) = match rest.split_once(char::is_whitespace) {
        Some((head, tail)) => (head, tail),
        None => (rest, ""),
    };

    let (channel, text) = match parse_destination(first) {
        Some(channel) => (Some(channel), remainder),
        None => (None, rest),
    };

    let text = normalize_ascii_text(text)?;
    let payload = render_ascii_art(&text)?;
    Ok(AsciiCommand {
        channel,
        text,
        payload,
    })
}

/// Trims, uppercases and collapses whitespace, rejecting anything unsupported.
///
/// An unsupported character is an error rather than a silent drop: quietly
/// removing it would send artwork the player did not ask for.
pub fn normalize_ascii_text(input: &str) -> Result<String, RiotError> {
    let mut text = String::new();
    for word in input.split_whitespace() {
        if !text.is_empty() {
            text.push(' ');
        }
        for character in word.chars() {
            let upper = character.to_ascii_uppercase();
            // Both faces cover the same set; Bold is the authority.
            if !Face::Bold.supports(upper) {
                return Err(RiotError::InvalidCommand(format!(
                    "'{character}' cannot be drawn. Use letters A-Z, digits 0-9, spaces, and ! ? -."
                )));
            }
            text.push(upper);
        }
    }
    if text.is_empty() {
        return Err(RiotError::InvalidCommand(USAGE.into()));
    }
    Ok(text)
}

/// Renders already-normalized text, choosing the largest layout that fits.
pub fn render_ascii_art(text: &str) -> Result<String, RiotError> {
    Ok(render_with_face(text)?.0)
}

/// The rendered payload plus the face that drew it, for tests and callers that
/// want to report which layout was used.
pub fn render_with_face(text: &str) -> Result<(String, Face), RiotError> {
    let characters = text.chars().count();
    if characters == 0 {
        return Err(RiotError::InvalidCommand(USAGE.into()));
    }

    // The compact face matches the three-row block alphabet used by VALORANT
    // chat art and keeps a six-character phrase inside one 26-column row.
    let face = Face::Compact;
    if face.width(characters) + BORDER * 2 <= MAX_COLUMNS {
        return Ok((render_lines(&[text], face), face));
    }

    // Still too wide, so choose one existing word boundary that makes two
    // balanced visual lines. The fixed 9-row budget allows exactly two glyph
    // lines: top border + 3 rows + gap + 3 rows + bottom border.
    let words: Vec<&str> = text.split(' ').filter(|word| !word.is_empty()).collect();
    if words.len() > 1 {
        let split = (1..words.len())
            .filter_map(|index| {
                let left = words[..index].join(" ");
                let right = words[index..].join(" ");
                let left_width = face.width(left.chars().count());
                let right_width = face.width(right.chars().count());
                (left_width + BORDER * 2 <= MAX_COLUMNS && right_width + BORDER * 2 <= MAX_COLUMNS)
                    .then_some((index, left_width.max(right_width)))
            })
            .min_by_key(|(_, widest)| *widest)
            .map(|(index, _)| index);

        if let Some(index) = split {
            let left = words[..index].join(" ");
            let right = words[index..].join(" ");
            let payload = render_lines(&[&left, &right], face);
            debug_assert_eq!(payload.chars().count(), MAX_PAYLOAD_CHARACTERS);
            return Ok((payload, face));
        }

        if words
            .iter()
            .all(|word| face.width(word.chars().count()) + BORDER * 2 <= MAX_COLUMNS)
        {
            return Err(RiotError::InvalidCommand(format!(
                "'{text}' makes artwork that is too long for one VALORANT chat message."
            )));
        }
    }

    let longest = words
        .iter()
        .map(|word| word.chars().count())
        .max()
        .unwrap_or(characters);
    let limit = max_characters_on_one_line(Face::Compact);
    Err(RiotError::InvalidCommand(format!(
        "'{text}' is too wide for one VALORANT artwork message. Use at most {limit} characters, \
         or split it into words of {longest_hint} or fewer.",
        longest_hint = max_characters_on_one_line(Face::Compact).min(longest.saturating_sub(1)),
    )))
}

/// The most characters a face fits on one line inside the border.
pub fn max_characters_on_one_line(face: Face) -> usize {
    let usable = MAX_COLUMNS.saturating_sub(BORDER * 2);
    // width(n) = n * cols + (n - 1) * gap, so n = (usable + gap) / (cols + gap).
    (usable + GLYPH_GAP) / (face.columns() + GLYPH_GAP)
}

/// Draws each line centred in a rectangular panel.
///
/// Every line is padded to the widest so the panel keeps square edges; a ragged
/// right edge breaks the hatched-panel look the art depends on.
fn render_lines(lines: &[&str], face: Face) -> String {
    let inner = MAX_COLUMNS - BORDER * 2;
    let blank = background_row(MAX_COLUMNS);

    let mut rows: Vec<String> = vec![blank.clone(); BORDER];
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            for _ in 0..LINE_GAP {
                rows.push(blank.clone());
            }
        }
        rows.extend(render_line(line, face, inner));
    }
    rows.extend(std::iter::repeat_n(blank, BORDER));
    rows.concat()
}

fn background_row(width: usize) -> String {
    std::iter::repeat_n(BACKGROUND, width).collect()
}

fn render_line(line: &str, face: Face, inner: usize) -> Vec<String> {
    let width = face.width(line.chars().count());
    let left = BORDER + (inner - width) / 2;
    let right = BORDER * 2 + inner - width - left;

    let glyphs: Vec<Vec<String>> = line
        .chars()
        .map(|character| face.glyph(character))
        .collect();
    (0..face.rows())
        .map(|row| {
            let mut out = background_row(left);
            for (index, glyph) in glyphs.iter().enumerate() {
                if index > 0 {
                    out.push_str(&background_row(GLYPH_GAP));
                }
                out.push_str(&glyph[row]);
            }
            out.push_str(&background_row(right));
            out
        })
        .collect()
}

/// Folds two compact bitmap rows into one line of half-block characters.
///
/// The compact face is authored at six rows so the letters keep their shape;
/// it renders into three, so each output row carries two input rows in the top
/// and bottom halves of one character.
fn compress_row(cells: &CompactBitmap, row: usize) -> String {
    let top = cells[row * 2];
    let bottom = cells[row * 2 + 1];
    (0..Face::Compact.columns())
        .map(|column| {
            let lit = |line: &str| line.as_bytes().get(column) == Some(&b'#');
            match (lit(top), lit(bottom)) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => BACKGROUND,
            }
        })
        .collect()
}

type BoldBitmap = [&'static str; 5];
type CompactBitmap = [&'static str; 6];

fn bold_glyph(character: char) -> Option<&'static BoldBitmap> {
    BOLD_FONT
        .iter()
        .find(|(key, _)| *key == character)
        .map(|(_, bitmap)| bitmap)
}

fn compact_glyph(character: char) -> Option<&'static CompactBitmap> {
    COMPACT_FONT
        .iter()
        .find(|(key, _)| *key == character)
        .map(|(_, bitmap)| bitmap)
}

/// Five rows of four columns, `#` lit and `.` unlit.
///
/// Checked in rather than generated or fetched so a rendered phrase is
/// byte-identical on every machine and every run, which is what makes the
/// snapshot tests below meaningful.
#[rustfmt::skip]
const BOLD_FONT: &[(char, BoldBitmap)] = &[
    (' ', ["....", "....", "....", "....", "...."]),
    ('A', [".##.", "#..#", "####", "#..#", "#..#"]),
    ('B', ["###.", "#..#", "###.", "#..#", "###."]),
    ('C', [".###", "#...", "#...", "#...", ".###"]),
    ('D', ["###.", "#..#", "#..#", "#..#", "###."]),
    ('E', ["####", "#...", "###.", "#...", "####"]),
    ('F', ["####", "#...", "###.", "#...", "#..."]),
    ('G', [".###", "#...", "#.##", "#..#", ".###"]),
    ('H', ["#..#", "#..#", "####", "#..#", "#..#"]),
    ('I', ["####", ".##.", ".##.", ".##.", "####"]),
    ('J', ["...#", "...#", "...#", "#..#", ".##."]),
    ('K', ["#..#", "#.#.", "##..", "#.#.", "#..#"]),
    ('L', ["#...", "#...", "#...", "#...", "####"]),
    ('M', ["#..#", "####", "####", "#..#", "#..#"]),
    ('N', ["#..#", "##.#", "#.##", "#..#", "#..#"]),
    ('O', [".##.", "#..#", "#..#", "#..#", ".##."]),
    ('P', ["###.", "#..#", "###.", "#...", "#..."]),
    ('Q', [".##.", "#..#", "#..#", "#.#.", ".#.#"]),
    ('R', ["###.", "#..#", "###.", "#.#.", "#..#"]),
    ('S', [".###", "#...", ".##.", "...#", "###."]),
    ('T', ["####", ".##.", ".##.", ".##.", ".##."]),
    ('U', ["#..#", "#..#", "#..#", "#..#", ".##."]),
    ('V', ["#..#", "#..#", "#..#", ".##.", ".##."]),
    ('W', ["#..#", "#..#", "####", "####", "#..#"]),
    ('X', ["#..#", ".##.", ".##.", ".##.", "#..#"]),
    ('Y', ["#..#", "#..#", ".##.", ".##.", ".##."]),
    ('Z', ["####", "...#", ".##.", "#...", "####"]),
    ('0', ["####", "#..#", "#..#", "#..#", "####"]),
    ('1', [".#..", "##..", ".#..", ".#..", "###."]),
    ('2', ["###.", "...#", ".##.", "#...", "####"]),
    ('3', ["###.", "...#", ".##.", "...#", "###."]),
    ('4', ["#..#", "#..#", "####", "...#", "...#"]),
    ('5', ["####", "#...", "###.", "...#", "###."]),
    ('6', [".###", "#...", "###.", "#..#", ".##."]),
    ('7', ["####", "...#", "..#.", ".#..", ".#.."]),
    ('8', [".##.", "#..#", ".##.", "#..#", ".##."]),
    ('9', [".##.", "#..#", ".###", "...#", "###."]),
    ('!', [".##.", ".##.", ".##.", "....", ".##."]),
    ('?', ["###.", "...#", ".##.", "....", ".##."]),
    ('-', ["....", "....", "####", "....", "...."]),
];

/// Six rows of three columns, folded into three rendered rows.
#[rustfmt::skip]
const COMPACT_FONT: &[(char, CompactBitmap)] = &[
    (' ', ["...", "...", "...", "...", "...", "..."]),
    ('A', [".#.", "#.#", "#.#", "###", "#.#", "#.#"]),
    ('B', ["##.", "#.#", "##.", "##.", "#.#", "##."]),
    ('C', [".##", "#..", "#..", "#..", "#..", ".##"]),
    ('D', ["##.", "#.#", "#.#", "#.#", "#.#", "##."]),
    ('E', ["###", "#..", "##.", "##.", "#..", "###"]),
    ('F', ["###", "#..", "##.", "##.", "#..", "#.."]),
    ('G', [".##", "#..", "#..", "#.#", "#.#", ".##"]),
    ('H', ["#.#", "#.#", "###", "###", "#.#", "#.#"]),
    ('I', ["###", ".#.", ".#.", ".#.", ".#.", "###"]),
    ('J', ["..#", "..#", "..#", "..#", "#.#", ".#."]),
    ('K', ["#.#", "#.#", "##.", "##.", "#.#", "#.#"]),
    ('L', ["#..", "#..", "#..", "#..", "#..", "###"]),
    ('M', ["#.#", "###", "###", "#.#", "#.#", "#.#"]),
    ('N', ["#.#", "##.", "###", "###", ".##", "#.#"]),
    ('O', [".#.", "#.#", "#.#", "#.#", "#.#", ".#."]),
    ('P', ["##.", "#.#", "#.#", "##.", "#..", "#.."]),
    ('Q', [".#.", "#.#", "#.#", "#.#", "##.", ".##"]),
    ('R', ["##.", "#.#", "#.#", "##.", "#.#", "#.#"]),
    ('S', [".##", "#..", ".#.", ".#.", "..#", "##."]),
    ('T', ["###", ".#.", ".#.", ".#.", ".#.", ".#."]),
    ('U', ["#.#", "#.#", "#.#", "#.#", "#.#", ".#."]),
    ('V', ["#.#", "#.#", "#.#", "#.#", ".#.", ".#."]),
    ('W', ["#.#", "#.#", "#.#", "###", "###", "#.#"]),
    ('X', ["#.#", "#.#", ".#.", ".#.", "#.#", "#.#"]),
    ('Y', ["#.#", "#.#", ".#.", ".#.", ".#.", ".#."]),
    ('Z', ["###", "..#", ".#.", ".#.", "#..", "###"]),
    ('0', ["###", "#.#", "#.#", "#.#", "#.#", "###"]),
    ('1', [".#.", "##.", ".#.", ".#.", ".#.", "###"]),
    ('2', ["##.", "..#", "..#", ".#.", "#..", "###"]),
    ('3', ["##.", "..#", ".#.", ".#.", "..#", "##."]),
    ('4', ["#.#", "#.#", "#.#", "###", "..#", "..#"]),
    ('5', ["###", "#..", "##.", "..#", "..#", "##."]),
    ('6', [".##", "#..", "##.", "#.#", "#.#", ".#."]),
    ('7', ["###", "..#", "..#", ".#.", ".#.", ".#."]),
    ('8', [".#.", "#.#", ".#.", ".#.", "#.#", ".#."]),
    ('9', [".#.", "#.#", "#.#", ".##", "..#", "##."]),
    ('!', [".#.", ".#.", ".#.", ".#.", "...", ".#."]),
    ('?', ["##.", "..#", "..#", ".#.", "...", ".#."]),
    ('-', ["...", "...", "###", "...", "...", "..."]),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(payload: &str) -> Vec<String> {
        let characters: Vec<char> = payload.chars().collect();
        characters
            .chunks(MAX_COLUMNS)
            .map(|row| row.iter().collect())
            .collect()
    }

    fn face_of(input: &str) -> Face {
        let text = normalize_ascii_text(input).unwrap();
        render_with_face(&text).unwrap().1
    }

    #[test]
    fn recognizes_the_command_exactly() {
        assert!(is_ascii_command(".ascii gg"));
        assert!(is_ascii_command("  .ASCII gg"));
        assert!(is_ascii_command(".ascii"));
        assert!(!is_ascii_command(".asciify gg"));
        assert!(!is_ascii_command(".ascii2"));
        assert!(!is_ascii_command("ascii gg"));
        assert!(!is_ascii_command(".send team gg"));
    }

    #[test]
    fn parses_each_explicit_destination() {
        for (input, expected) in [
            (".ascii team nice", ChatChannel::Team),
            (".ascii all gg", ChatChannel::All),
            (".ascii party hello", ChatChannel::Party),
            (".ascii TEAM nice", ChatChannel::Team),
        ] {
            let parsed = parse_ascii_command(input).unwrap();
            assert_eq!(parsed.channel, Some(expected), "{input}");
        }
    }

    #[test]
    fn destination_free_parsing_keeps_the_whole_phrase() {
        let parsed = parse_ascii_command(".ascii hk gay").unwrap();
        assert_eq!(parsed.channel, None);
        assert_eq!(parsed.text, "HK GAY");
    }

    #[test]
    fn destination_is_stripped_from_the_artwork_text() {
        let parsed = parse_ascii_command(".ascii all gg").unwrap();
        assert_eq!(parsed.text, "GG");
    }

    #[test]
    fn channel_names_are_reserved_as_the_first_argument() {
        // ".ascii team" is "send to Team with nothing to draw", not "draw TEAM".
        for input in [".ascii team", ".ascii all", ".ascii party", ".ascii"] {
            let error = parse_ascii_command(input).unwrap_err().to_string();
            assert!(error.contains("Usage: .ascii"), "{input}: {error}");
        }
    }

    #[test]
    fn a_reserved_word_later_in_the_line_is_still_artwork() {
        let parsed = parse_ascii_command(".ascii all team").unwrap();
        assert_eq!(parsed.channel, Some(ChatChannel::All));
        assert_eq!(parsed.text, "TEAM");
    }

    #[test]
    fn normalizes_whitespace_and_case() {
        let parsed = parse_ascii_command(".ascii   hi   yo  ").unwrap();
        assert_eq!(parsed.text, "HI YO");
    }

    #[test]
    fn rejects_empty_and_unsupported_input() {
        let empty = parse_ascii_command(".ascii   ").unwrap_err().to_string();
        assert!(empty.contains("Usage: .ascii"), "{empty}");

        let unsupported = parse_ascii_command(".ascii gg@").unwrap_err().to_string();
        assert!(unsupported.contains("'@' cannot be drawn"), "{unsupported}");

        assert!(parse_ascii_command(".ascii 한글").is_err());
    }

    #[test]
    fn both_faces_cover_the_same_characters() {
        let expected = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?-";
        assert_eq!(BOLD_FONT.len(), expected.chars().count());
        assert_eq!(COMPACT_FONT.len(), expected.chars().count());
        for character in expected.chars() {
            assert!(Face::Bold.supports(character), "bold missing {character}");
            assert!(
                Face::Compact.supports(character),
                "compact missing {character}"
            );
        }
    }

    #[test]
    fn every_glyph_is_a_full_rectangle_in_both_faces() {
        for face in [Face::Bold, Face::Compact] {
            for (character, _) in BOLD_FONT {
                let glyph = face.glyph(*character);
                assert_eq!(glyph.len(), face.rows(), "{face:?} {character}");
                for row in glyph {
                    assert_eq!(row.chars().count(), face.columns(), "{face:?} {character}");
                }
            }
        }
    }

    #[test]
    fn a_short_phrase_stays_on_one_compact_line() {
        assert_eq!(face_of("nice"), Face::Compact);
        let payload = parse_ascii_command(".ascii nice").unwrap().payload;
        let lines = rows(&payload);
        assert_eq!(lines.len(), Face::Compact.rows() + BORDER * 2);
    }

    #[test]
    fn spaces_stay_on_the_line_rather_than_breaking_it() {
        // The Discord reference keeps a phrase on one line; so do we, while it
        // fits. "HK GAY" is 6 characters plus the space.
        assert_eq!(face_of("hk gay"), Face::Compact);
        let payload = parse_ascii_command(".ascii hk gay").unwrap().payload;
        assert_eq!(rows(&payload).len(), Face::Compact.rows() + BORDER * 2);
    }

    #[test]
    fn hk_gay_is_a_paste_ready_fixed_width_payload() {
        let parsed = parse_ascii_command(".ascii hk gay").unwrap();

        assert_eq!(face_of("hk gay"), Face::Compact);
        assert!(!parsed.payload.contains(['\r', '\n']));
        assert_eq!(parsed.payload.chars().count(), MAX_COLUMNS * 5);
        assert!(rows(&parsed.payload)
            .iter()
            .all(|row| row.chars().count() == 26));
    }

    #[test]
    fn artwork_never_exceeds_nine_complete_chat_rows() {
        let two_lines = render_ascii_art("AAAAAA AAAAAA").unwrap();
        assert_eq!(two_lines.chars().count(), MAX_COLUMNS * 9);

        let error = render_ascii_art("AAAAAA AAAAAA AAAAAA")
            .unwrap_err()
            .to_string();
        assert!(error.contains("too long"), "{error}");
    }

    #[test]
    fn several_short_words_pack_around_one_boundary() {
        let payload = render_ascii_art("A B C D").unwrap();

        assert_eq!(payload.chars().count(), MAX_COLUMNS * 9);
        assert_eq!(rows(&payload).len(), 9);
    }

    #[test]
    fn six_characters_fit_on_one_compact_line() {
        let text = "A".repeat(max_characters_on_one_line(Face::Compact));
        assert_eq!(face_of(&text), Face::Compact);
        let payload = render_ascii_art(&text).unwrap();
        assert_eq!(rows(&payload).len(), Face::Compact.rows() + BORDER * 2);
    }

    #[test]
    fn words_are_stacked_only_when_no_face_fits_on_one_line() {
        // Two six-character words fit individually but not together.
        let word = "A".repeat(max_characters_on_one_line(Face::Compact));
        let text = format!("{word} {word}");
        assert!(text.chars().count() > max_characters_on_one_line(Face::Compact));

        let payload = render_ascii_art(&text).unwrap();
        let lines = rows(&payload);
        assert_eq!(
            lines.len(),
            Face::Compact.rows() * 2 + LINE_GAP + BORDER * 2
        );
    }

    #[test]
    fn nothing_exceeds_the_column_limit() {
        for text in [
            "A",
            "GG",
            "NICE",
            "HK GAY",
            "DELETE VALO",
            &"A".repeat(max_characters_on_one_line(Face::Compact)),
        ] {
            let normalized = normalize_ascii_text(text).unwrap();
            let payload = render_ascii_art(&normalized).unwrap();
            for row in rows(&payload) {
                assert!(
                    row.chars().count() == MAX_COLUMNS,
                    "{text}: {} columns",
                    row.chars().count()
                );
            }
        }
    }

    #[test]
    fn a_single_word_too_wide_for_the_compact_face_is_refused() {
        let text = "A".repeat(max_characters_on_one_line(Face::Compact) + 1);
        let error = render_ascii_art(&text).unwrap_err().to_string();
        assert!(error.contains("too wide"), "{error}");
    }

    #[test]
    fn the_panel_is_framed_by_background_rows_and_columns() {
        let payload = parse_ascii_command(".ascii gg").unwrap().payload;
        let lines = rows(&payload);
        let blank = background_row(lines[0].chars().count());
        assert_eq!(lines[0], blank);
        assert_eq!(lines[lines.len() - 1], blank);
        for line in &lines {
            assert!(line.starts_with(BACKGROUND), "{line}");
            assert!(line.ends_with(BACKGROUND), "{line}");
        }
    }

    #[test]
    fn every_row_of_a_panel_is_the_same_width() {
        for text in ["A", "GG", "HK GAY", "DELETE VALO"] {
            let normalized = normalize_ascii_text(text).unwrap();
            let payload = render_ascii_art(&normalized).unwrap();
            let lines = rows(&payload);
            let width = lines[0].chars().count();
            for line in &lines {
                assert_eq!(line.chars().count(), width, "{text}: {line}");
            }
        }
    }

    #[test]
    fn renders_a_representative_phrase() {
        let payload = parse_ascii_command(".ascii gg").unwrap().payload;
        assert_eq!(
            payload,
            [
                "░░░░░░░░░░░░░░░░░░░░░░░░░░",
                "░░░░░░░░░▄▀▀░▄▀▀░░░░░░░░░░",
                "░░░░░░░░░█░▄░█░▄░░░░░░░░░░",
                "░░░░░░░░░▀▄█░▀▄█░░░░░░░░░░",
                "░░░░░░░░░░░░░░░░░░░░░░░░░░",
            ]
            .concat()
        );
    }

    #[test]
    fn probe_is_rendered_like_any_other_word() {
        for input in [".ascii probe", ".ascii PROBE", ".ascii party probe"] {
            let parsed = parse_ascii_command(input).unwrap();
            assert_eq!(parsed.text, "PROBE", "{input}");
            assert!(!parsed.payload.contains(['\r', '\n']), "{input}");
            assert_eq!(parsed.payload.chars().count(), MAX_COLUMNS * 5, "{input}");
        }
        assert_eq!(
            parse_ascii_command(".ascii party probe").unwrap().channel,
            Some(ChatChannel::Party)
        );
        assert_eq!(parse_ascii_command(".ascii probes").unwrap().text, "PROBES");
    }

    #[test]
    fn the_payload_never_starts_with_a_dot() {
        // The echo of a sent artwork must not classify as another command.
        let payload = parse_ascii_command(".ascii gg").unwrap().payload;
        assert!(!payload.trim_start().starts_with('.'));
    }

    #[test]
    fn the_largest_payload_stays_a_reasonable_chat_message() {
        let word = "A".repeat(max_characters_on_one_line(Face::Compact));
        let payload = render_ascii_art(&format!("{word} {word}")).unwrap();
        assert_eq!(payload.chars().count(), MAX_PAYLOAD_CHARACTERS);
    }
}
