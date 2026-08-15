//! Locating, reading and parsing the Riot Client lockfile.
//!
//! The file lives at
//! `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile` and holds a single
//! colon-separated line:
//!
//! ```text
//! name:pid:port:password:protocol
//! ```
//!
//! It only exists while the Riot Client is running, so a missing file is the
//! normal "client is closed" signal rather than an exceptional condition.

use crate::riot::error::RiotError;
use std::path::PathBuf;

/// A parsed lockfile.
///
/// `password` is deliberately private and `Debug` is hand-written to redact it:
/// deriving `Debug` here would be enough to leak the credential into any
/// `log::debug!`, `dbg!` or `{:?}` formatting of a struct that embeds a
/// `Lockfile`.
#[derive(Clone, PartialEq, Eq)]
pub struct Lockfile {
    pub name: String,
    pub pid: i64,
    pub port: u16,
    password: String,
    pub protocol: String,
}

impl std::fmt::Debug for Lockfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lockfile")
            .field("name", &self.name)
            .field("pid", &self.pid)
            .field("port", &self.port)
            .field("password", &"<redacted>")
            .field("protocol", &self.protocol)
            .finish()
    }
}

impl Lockfile {
    /// The HTTP Basic password. Callers must pass this to
    /// `RequestBuilder::basic_auth` and nowhere else.
    pub fn password(&self) -> &str {
        &self.password
    }

    /// Always loopback — the lockfile only ever describes a local listener, and
    /// hard-coding the host here means no caller can accidentally point the
    /// credential-bearing client at a remote address.
    pub fn base_url(&self) -> String {
        format!("{}://127.0.0.1:{}", self.protocol, self.port)
    }
}

/// Parses the single line of a lockfile.
///
/// The field count is exact: Riot writes five fields and nothing else, and a
/// line with more colons means we are looking at a file we do not understand
/// rather than one we should guess at.
pub fn parse(contents: &str) -> Result<Lockfile, RiotError> {
    let parts: Vec<&str> = contents.trim().split(':').collect();
    if parts.len() != 5 {
        return Err(RiotError::MalformedLockfile);
    }

    let pid = parts[1]
        .parse::<i64>()
        .map_err(|_| RiotError::MalformedLockfile)?;
    let port = parts[2]
        .parse::<u16>()
        .map_err(|_| RiotError::MalformedLockfile)?;
    if parts[3].is_empty() {
        return Err(RiotError::MalformedLockfile);
    }
    let protocol = match parts[4] {
        "https" | "http" => parts[4].to_string(),
        _ => return Err(RiotError::MalformedLockfile),
    };

    Ok(Lockfile {
        name: parts[0].to_string(),
        pid,
        port,
        password: parts[3].to_string(),
        protocol,
    })
}

pub fn path() -> Result<PathBuf, RiotError> {
    let local_app_data =
        std::env::var("LOCALAPPDATA").map_err(|_| RiotError::RiotClientNotRunning)?;
    Ok(PathBuf::from(local_app_data)
        .join("Riot Games")
        .join("Riot Client")
        .join("Config")
        .join("lockfile"))
}

/// Reads and parses the live lockfile.
///
/// Any I/O failure collapses to `RiotClientNotRunning`: a missing file, a
/// permission error and a half-written file are all indistinguishable to the
/// player, and the remedy ("start the Riot Client") is the same. The
/// underlying `io::Error` is intentionally not forwarded — its `Display`
/// includes the full path, which is a user profile directory.
pub fn read() -> Result<Lockfile, RiotError> {
    let contents = std::fs::read_to_string(path()?).map_err(|_| RiotError::RiotClientNotRunning)?;
    parse(&contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Riot Client:22824:54321:kPu2E1p6ZzKQ7SmVc9NNbA:https";

    #[test]
    fn parses_every_field_of_a_real_lockfile_line() {
        let lockfile = parse(SAMPLE).unwrap();

        assert_eq!(lockfile.name, "Riot Client");
        assert_eq!(lockfile.pid, 22824);
        assert_eq!(lockfile.port, 54321);
        assert_eq!(lockfile.password(), "kPu2E1p6ZzKQ7SmVc9NNbA");
        assert_eq!(lockfile.protocol, "https");
        assert_eq!(lockfile.base_url(), "https://127.0.0.1:54321");
    }

    #[test]
    fn tolerates_the_trailing_newline_riot_writes() {
        assert_eq!(parse(&format!("{SAMPLE}\n")).unwrap().port, 54321);
        assert_eq!(parse(&format!("{SAMPLE}\r\n")).unwrap().port, 54321);
    }

    #[test]
    fn rejects_malformed_lines_instead_of_guessing() {
        for bad in [
            "",
            "Riot Client:22824:54321:secret", // too few fields
            "Riot Client:22824:54321:secret:https:extra", // too many fields
            "Riot Client:notapid:54321:secret:https", // pid not a number
            "Riot Client:22824:notaport:secret:https", // port not a number
            "Riot Client:22824:99999999:secret:https", // port out of u16 range
            "Riot Client:22824:54321::https", // empty password
            "Riot Client:22824:54321:secret:ftp", // unknown protocol
        ] {
            assert!(
                matches!(parse(bad), Err(RiotError::MalformedLockfile)),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn debug_formatting_redacts_the_password() {
        let rendered = format!("{:?}", parse(SAMPLE).unwrap());

        assert!(!rendered.contains("kPu2E1p6ZzKQ7SmVc9NNbA"));
        assert!(rendered.contains("<redacted>"));
        // The non-secret fields stay visible so the struct is still debuggable.
        assert!(rendered.contains("54321"));
    }
}
