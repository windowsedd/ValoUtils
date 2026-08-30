//! Built-in TLS identities for the local chat (presence) relay.
//!
//! The relay presents a PFX identity whose leaf certificate must match the
//! chat hostname that gets rewritten into the Riot client config. The user
//! picks one of these identities in Settings (`presenceCert` config key);
//! each identity keeps its own cached PFX file so switching is instant.

use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChatCertIdentity {
    pub id: &'static str,
    pub host: &'static str,
    /// HTTPS source the PFX is downloaded from when the cache is missing or
    /// within 20 days of expiry. The `VALOUTILS_PFX_URL` env var overrides it
    /// for local testing.
    pub download_url: &'static str,
}

pub const DECEIVE: ChatCertIdentity = ChatCertIdentity {
    id: "deceive",
    host: "deceive-localhost.molenzwiebel.xyz",
    download_url: "https://mln.cx/deceive/localhost.pfx",
};

pub const VALOUTILS: ChatCertIdentity = ChatCertIdentity {
    id: "valoutils",
    // Loopback-only hostname (A record to 127.0.0.1); the certificate repo
    // issues the PFX for this exact SAN. valoutils-tools.windowsed.me stays
    // the GitHub Pages domain the PFX is downloaded from.
    host: "valoutils-localhost.windowsed.me",
    download_url: "https://valoutils-tools.windowsed.me/valoutils/localhost.pfx",
};

pub static ALL: [ChatCertIdentity; 2] = [DECEIVE, VALOUTILS];
pub const DEFAULT: &ChatCertIdentity = &DECEIVE;

/// Resolves a `presenceCert` config value. Matching ignores case and
/// surrounding whitespace so hand-edited config files still resolve.
pub fn by_id(id: &str) -> Option<&'static ChatCertIdentity> {
    let id = id.trim();
    ALL.iter()
        .find(|identity| identity.id.eq_ignore_ascii_case(id))
}

/// The cached PFX lives in the ValoUtils user-data directory, named after the
/// host so both identities stay cached side by side.
pub fn cache_path(identity: &ChatCertIdentity) -> PathBuf {
    crate::store::user_data_dir().join(format!("{}.pfx", identity.host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_ids_case_insensitively() {
        assert_eq!(by_id("deceive"), Some(&DECEIVE));
        assert_eq!(by_id(" VALOUTILS "), Some(&VALOUTILS));
        assert_eq!(by_id("unknown"), None);
        assert_eq!(by_id(""), None);
    }

    #[test]
    fn defaults_to_the_deceive_identity() {
        assert_eq!(DEFAULT.id, "deceive");
        assert_eq!(by_id(DEFAULT.id), Some(DEFAULT));
    }

    #[test]
    fn identities_have_unique_ids_and_hosts() {
        for (index, identity) in ALL.iter().enumerate() {
            for other in &ALL[index + 1..] {
                assert_ne!(identity.id, other.id);
                assert_ne!(identity.host, other.host);
            }
            assert!(identity.host.contains('.'));
            assert!(identity.download_url.starts_with("https://"));
        }
    }

    #[test]
    fn cache_files_are_named_after_the_host() {
        assert_eq!(
            cache_path(&DECEIVE),
            crate::store::user_data_dir().join("deceive-localhost.molenzwiebel.xyz.pfx")
        );
        assert_eq!(
            cache_path(&VALOUTILS),
            crate::store::user_data_dir().join("valoutils-localhost.windowsed.me.pfx")
        );
    }
}
