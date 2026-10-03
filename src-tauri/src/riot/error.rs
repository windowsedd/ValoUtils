//! Typed errors for Riot Client requests and chat integration.
//!
//! Every variant is written so that its `Display` output is safe to hand
//! straight to the frontend or to a log line. Specifically, no variant may
//! carry:
//!
//! - the lockfile password, or the `Authorization` header built from it,
//! - the raw lockfile contents,
//! - a raw response body (Riot's chat payloads contain PUUIDs and message
//!   text that we have no reason to echo back inside an error).
//!
//! Transport failures are the easy place to leak, because `reqwest::Error`'s
//! `Display` normally embeds the request URL. [`RiotError::from_transport`] is
//! the only sanctioned conversion and it calls `without_url()` first, so the
//! loopback port never lands in a message either.

use crate::riot::models::ChatChannel;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RiotError {
    #[error("Riot Client is not running.")]
    RiotClientNotRunning,

    #[error("Sign in to the Riot Client, then try again.")]
    LoginRequired,

    #[error("The Riot Client request timed out. Try again.")]
    Timeout,

    #[error("Could not read the Riot Client lockfile. Check file access and try again.")]
    LockfileReadFailed,

    #[error("{0}")]
    Other(String),

    #[error("Riot Client request failed (HTTP {status}).")]
    LocalHttp { status: u16 },

    #[error("Riot Client lockfile is malformed.")]
    MalformedLockfile,

    #[error("Could not reach the Riot Client: {0}")]
    Transport(String),

    #[error("Riot Client rejected the chat request (HTTP {status}).")]
    Http { status: u16 },

    #[error("Riot Client returned a chat response this app could not read.")]
    UnreadableResponse,

    #[error("{channel} chat is not available right now.")]
    ChannelUnavailable { channel: ChatChannel },

    #[error("Chat conversation id is not a valid Riot CID.")]
    InvalidCid,

    #[error("Chat conversation was not found.")]
    ConversationNotFound,

    #[error("{channel} chat conversation is no longer active.")]
    StaleConversation { channel: ChatChannel },

    #[error("Message history is not available for this conversation.")]
    MessageHistoryUnavailable,

    #[error("Riot Client is not running.")]
    RiotClientUnavailable,

    #[error("Riot Client rejected the chat request (HTTP {status}).")]
    AuthenticationFailed { status: u16 },

    #[error("Riot Client rejected the chat request (HTTP {status}).")]
    RequestFailed { status: u16 },

    #[error("Message is empty.")]
    EmptyMessage,

    #[error("Not connected to the Riot Client chat service.")]
    NotConnected,

    #[error("{0}")]
    InvalidCommand(String),
}

impl RiotError {
    /// The only permitted way to build a [`RiotError::Transport`] from reqwest.
    ///
    /// `without_url()` strips the URL from the error chain; without it the
    /// message would read `error sending request for url
    /// (https://127.0.0.1:54321/chat/v6/messages)` and put the local port into
    /// anything that logged it.
    pub fn from_transport(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else if error.is_connect() {
            Self::RiotClientNotRunning
        } else {
            Self::Transport(error.without_url().to_string())
        }
    }

    pub fn code(&self) -> &'static str {
        if self.is_login_required() {
            return "loginRequired";
        }
        match self {
            Self::MalformedLockfile => "malformedLockfile",
            Self::LockfileReadFailed => "lockfileReadFailed",
            Self::Timeout => "timeout",
            _ => "unavailable",
        }
    }

    pub fn from_lockfile_io(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::RiotClientNotRunning,
            std::io::ErrorKind::InvalidData => Self::MalformedLockfile,
            _ => Self::LockfileReadFailed,
        }
    }

    /// True when the failure means "nobody is signed in / the client isn't up"
    /// rather than a genuine fault, so callers can show a sign-in state instead
    /// of an error toast. Mirrors the intent of
    /// [`crate::riot::client::is_login_required_error`] for the typed layer.
    pub fn is_login_required(&self) -> bool {
        match self {
            RiotError::RiotClientNotRunning
            | RiotError::RiotClientUnavailable
            | RiotError::LoginRequired
            | RiotError::NotConnected
            | RiotError::AuthenticationFailed { .. } => true,
            RiotError::Http { status } | RiotError::RequestFailed { status } => {
                *status == 401 || *status == 403
            }
            _ => false,
        }
    }
}

// Preserve text at legacy IPC boundaries; classification must happen beforehand.
impl From<RiotError> for String {
    fn from(error: RiotError) -> Self {
        error.to_string()
    }
}

impl From<String> for RiotError {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}

impl serde::Serialize for RiotError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn faults_do_not_request_login() {
        assert!(!RiotError::MalformedLockfile.is_login_required());
        assert!(!RiotError::Timeout.is_login_required());
        assert!(!RiotError::Transport("lockfile read timed out".into()).is_login_required());
        assert!(!RiotError::Http { status: 503 }.is_login_required());
        assert!(RiotError::RiotClientNotRunning.is_login_required());
        assert!(RiotError::Http { status: 401 }.is_login_required());
    }

    #[test]
    fn lockfile_io_faults_keep_their_kind_without_exposing_paths() {
        for (kind, expected) in [
            (std::io::ErrorKind::NotFound, "loginRequired"),
            (std::io::ErrorKind::PermissionDenied, "lockfileReadFailed"),
            (std::io::ErrorKind::InvalidData, "malformedLockfile"),
        ] {
            let error = RiotError::from_lockfile_io(std::io::Error::new(kind, "private-path"));
            assert_eq!(error.code(), expected);
            assert!(!error.to_string().contains("private-path"));
            assert_eq!(serde_json::to_value(&error).unwrap(), error.to_string());
        }
    }

    #[tokio::test]
    async fn timeout_and_connection_refusal_have_different_login_behavior() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_millis(100))
            .build()
            .unwrap();
        // The listener accepts TCP connections but never sends an HTTP response.
        let error = RiotError::from_transport(client.get(&url).send().await.unwrap_err());
        assert!(matches!(error, RiotError::Timeout));
        assert_eq!(error.code(), "timeout");
        assert!(!error.is_login_required());

        drop(listener);
        let closed_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_url = format!("http://{}/", closed_listener.local_addr().unwrap());
        drop(closed_listener);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let error = RiotError::from_transport(client.get(&closed_url).send().await.unwrap_err());
        assert!(matches!(error, RiotError::RiotClientNotRunning), "{error:?}");
        assert!(error.is_login_required());
        assert!(!error.to_string().contains("127.0.0.1"));
    }

    #[test]
    fn channel_unavailable_names_the_channel_it_refused() {
        let error = RiotError::ChannelUnavailable {
            channel: ChatChannel::All,
        };
        assert_eq!(error.to_string(), "All chat is not available right now.");
    }

    #[test]
    fn transport_and_http_errors_stay_free_of_ports_and_bodies() {
        // A 401 body from the Riot Client can contain the echoed request; the
        // error must reduce it to a status code and nothing else.
        let http = RiotError::Http { status: 401 };
        assert_eq!(
            http.to_string(),
            "Riot Client rejected the chat request (HTTP 401)."
        );
        assert!(!http.to_string().contains("127.0.0.1"));
    }

    #[test]
    fn typed_history_errors_do_not_embed_cids_or_bodies() {
        let stale = RiotError::StaleConversation {
            channel: ChatChannel::Team,
        };
        assert_eq!(
            stale.to_string(),
            "Team chat conversation is no longer active."
        );
        assert!(!stale.to_string().contains('@'));
        assert_eq!(
            RiotError::InvalidCid.to_string(),
            "Chat conversation id is not a valid Riot CID."
        );
        assert_eq!(
            RiotError::ConversationNotFound.to_string(),
            "Chat conversation was not found."
        );
    }
}
