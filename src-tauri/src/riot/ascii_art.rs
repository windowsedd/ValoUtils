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
//! Every visual row is padded to VALORANT's 26-column chat width and joined by
//! [`ROW_SEPARATOR`]. A message holds at most [`MAX_ROWS`] rows (350 characters,
//! the chat limit). The bold face is tried first - one line, or two split at a
//! space - and the compact face takes over for longer text, up to three lines.
//!
//! The separator is an ordinary space, which hands the game a legal wrap point
//! between rows. A real newline was tried and is worse: the in-game chat draws
//! a message only up to its first line break, so just the blank border row
//! showed. An earlier space-separated build had rows stacking out of line, but
//! that used the compact face's half-blocks, which may not share the width of
//! `█` and `░` in VALORANT's fallback font. It is one constant either way, and
//! every length here counts the separator as one character.
//!
//! [`MAX_COLUMNS`] is the one number here that is a judgement call rather than
//! arithmetic. See its comment before changing anything else.

use crate::riot::error::RiotError;
use crate::riot::models::ChatChannel;

/// The widest a rendered row may be, in block characters.
///
/// Riot does not document this width. It comes from the known-good sample used
/// for runtime verification: 234 characters divide into exactly nine rows of
/// 26, and thirteen such rows reach the 350-character message limit. Changing
/// it changes the wire format, not just the visual padding.
pub const MAX_COLUMNS: usize = 26;
/// What sits between two visual rows. Exactly one character wide by
/// construction: every payload length below assumes that.
pub const ROW_SEPARATOR: char = ' ';
/// Rows in the tallest panel. Thirteen 26-column rows plus twelve separators is
/// exactly 350 characters, VALORANT's chat message limit.
pub const MAX_ROWS: usize = 13;
/// The longest payload: [`MAX_ROWS`] complete rows and the separators between.
pub const MAX_PAYLOAD_CHARACTERS: usize = MAX_COLUMNS * MAX_ROWS + (MAX_ROWS - 1);
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
    /// Five rows of four columns. Reads best, so it is always tried first.
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

    /// Panel height for `lines` lines of this face, border and gaps included.
    fn panel_rows(self, lines: usize) -> usize {
        BORDER * 2 + lines * self.rows() + lines.saturating_sub(1) * LINE_GAP
    }

    /// How many lines of this face fit in [`MAX_ROWS`]: Bold 2, Compact 3.
    pub fn max_lines(self) -> usize {
        (1..=MAX_ROWS)
            .take_while(|lines| self.panel_rows(*lines) <= MAX_ROWS)
            .last()
            .unwrap_or(0)
    }

    fn fits(self, line: &str) -> bool {
        self.width(line.chars().count()) + BORDER * 2 <= MAX_COLUMNS
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

    let words: Vec<&str> = text.split(' ').filter(|word| !word.is_empty()).collect();
    for face in [Face::Bold, Face::Compact] {
        if let Some(lines) = plan_lines(&words, face) {
            let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
            let payload = render_lines(&refs, face);
            debug_assert!(payload.chars().count() <= MAX_PAYLOAD_CHARACTERS);
            return Ok((payload, face));
        }
    }

    let limit = max_characters_on_one_line(Face::Compact);
    if words.iter().all(|word| Face::Compact.fits(word)) {
        return Err(RiotError::InvalidCommand(format!(
            "'{text}' makes artwork that is too long for one VALORANT chat message. \
             Fit it in {lines} lines of {limit} characters.",
            lines = Face::Compact.max_lines(),
        )));
    }
    Err(RiotError::InvalidCommand(format!(
        "'{text}' is too wide for one VALORANT artwork message. \
         Keep each word to {limit} characters or fewer."
    )))
}

/// Splits words into the fewest lines that fit, at most [`Face::max_lines`].
///
/// Words are never broken, and the order is kept. Among splits with the same
/// line count the most balanced one wins, so the panel stays compact.
fn plan_lines(words: &[&str], face: Face) -> Option<Vec<String>> {
    if words.is_empty() {
        return None;
    }
    for count in 1..=face.max_lines().min(words.len()) {
        let mut best: Option<(usize, Vec<String>)> = None;
        for_each_split(words.len(), count, &mut |cuts| {
            let mut lines = Vec::with_capacity(count);
            let mut start = 0;
            for &end in cuts.iter().chain(std::iter::once(&words.len())) {
                lines.push(words[start..end].join(" "));
                start = end;
            }
            if lines.iter().all(|line| face.fits(line)) {
                let widest = lines
                    .iter()
                    .map(|line| line.chars().count())
                    .max()
                    .unwrap_or(0);
                if best.as_ref().is_none_or(|(current, _)| widest < *current) {
                    best = Some((widest, lines));
                }
            }
        });
        if let Some((_, lines)) = best {
            return Some(lines);
        }
    }
    None
}

/// Calls `visit` with every way to cut `len` words into `parts` non-empty runs,
/// as the ascending word indexes where each later run starts.
fn for_each_split(len: usize, parts: usize, visit: &mut impl FnMut(&[usize])) {
    fn walk(
        next: usize,
        len: usize,
        remaining: usize,
        cuts: &mut Vec<usize>,
        visit: &mut impl FnMut(&[usize]),
    ) {
        if remaining == 0 {
            visit(cuts);
            return;
        }
        for cut in next..=len - remaining {
            cuts.push(cut);
            walk(cut + 1, len, remaining - 1, cuts, visit);
            cuts.pop();
        }
    }
    if parts == 0 || parts > len {
        return;
    }
    walk(1, len, parts - 1, &mut Vec::new(), visit);
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
    rows.join(&ROW_SEPARATOR.to_string())
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
        payload.split(ROW_SEPARATOR).map(str::to_string).collect()
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
    fn the_message_limit_is_thirteen_rows_of_350_characters() {
        assert_eq!(MAX_PAYLOAD_CHARACTERS, 350);
        assert_eq!(Face::Bold.max_lines(), 2);
        assert_eq!(Face::Compact.max_lines(), 3);
        assert_eq!(max_characters_on_one_line(Face::Bold), 5);
        assert_eq!(max_characters_on_one_line(Face::Compact), 6);
    }

    #[test]
    fn a_short_phrase_stays_on_one_bold_line() {
        assert_eq!(face_of("nice"), Face::Bold);
        let payload = parse_ascii_command(".ascii nice").unwrap().payload;
        let lines = rows(&payload);
        assert_eq!(lines.len(), Face::Bold.rows() + BORDER * 2);
    }

    #[test]
    fn spaces_stay_on_the_line_rather_than_breaking_it() {
        // "GG EZ" is five characters with the space: exactly one bold line.
        assert_eq!(face_of("gg ez"), Face::Bold);
        let payload = parse_ascii_command(".ascii gg ez").unwrap().payload;
        assert_eq!(rows(&payload).len(), Face::Bold.rows() + BORDER * 2);
    }

    #[test]
    fn two_words_stack_into_two_bold_lines_at_the_limit() {
        let parsed = parse_ascii_command(".ascii hk gay").unwrap();

        assert_eq!(face_of("hk gay"), Face::Bold);
        assert!(!parsed.payload.contains('\r'));
        assert_eq!(parsed.payload.chars().count(), MAX_PAYLOAD_CHARACTERS);
        assert!(rows(&parsed.payload)
            .iter()
            .all(|row| row.chars().count() == 26));
    }

    #[test]
    fn longer_text_falls_back_to_three_compact_lines() {
        let payload = render_ascii_art("NICE TRY BOT").unwrap();
        assert_eq!(face_of("nice try bot"), Face::Compact);
        assert_eq!(rows(&payload).len(), MAX_ROWS);
        assert_eq!(payload.chars().count(), MAX_PAYLOAD_CHARACTERS);
    }

    #[test]
    fn visual_rows_are_separated_by_one_space() {
        let payload = parse_ascii_command(".ascii gg").unwrap().payload;
        let rows: Vec<&str> = payload.split(ROW_SEPARATOR).collect();

        assert_eq!(rows.len(), 7);
        assert!(rows.iter().all(|row| row.chars().count() == MAX_COLUMNS));
        assert_eq!(payload.chars().count(), MAX_COLUMNS * 7 + 6);
        // No line breaks at all: the in-game chat stops drawing a message
        // at its first one.
        assert!(!payload.contains(['\r', '\n']));
    }

    #[test]
    fn artwork_never_exceeds_thirteen_complete_chat_rows() {
        let three_lines = render_ascii_art("AAAAAA AAAAAA AAAAAA").unwrap();
        assert_eq!(three_lines.chars().count(), MAX_PAYLOAD_CHARACTERS);

        let error = render_ascii_art("AAAAAA AAAAAA AAAAAA AAAAAA")
            .unwrap_err()
            .to_string();
        assert!(error.contains("too long"), "{error}");
    }

    #[test]
    fn several_short_words_pack_around_one_boundary() {
        let payload = render_ascii_art("A B C D").unwrap();

        assert_eq!(face_of("a b c d"), Face::Bold);
        assert_eq!(payload.chars().count(), MAX_PAYLOAD_CHARACTERS);
        assert_eq!(rows(&payload).len(), MAX_ROWS);
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
        assert_eq!(face_of(&text), Face::Compact);
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
                "░░░░░░░░░███░░███░░░░░░░░░",
                "░░░░░░░░█░░░░█░░░░░░░░░░░░",
                "░░░░░░░░█░██░█░██░░░░░░░░░",
                "░░░░░░░░█░░█░█░░█░░░░░░░░░",
                "░░░░░░░░░███░░███░░░░░░░░░",
                "░░░░░░░░░░░░░░░░░░░░░░░░░░",
            ]
            .join(&ROW_SEPARATOR.to_string())
        );
    }

    #[test]
    fn probe_is_rendered_like_any_other_word() {
        for input in [".ascii probe", ".ascii PROBE", ".ascii party probe"] {
            let parsed = parse_ascii_command(input).unwrap();
            assert_eq!(parsed.text, "PROBE", "{input}");
            assert!(!parsed.payload.contains('\r'), "{input}");
            assert_eq!(
                parsed.payload.chars().count(),
                MAX_COLUMNS * 7 + 6,
                "{input}"
            );
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
        let payload = render_ascii_art(&format!("{word} {word} {word}")).unwrap();
        assert_eq!(payload.chars().count(), MAX_PAYLOAD_CHARACTERS);
    }
}
