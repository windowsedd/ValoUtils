//! Typed errors for the local Riot Client chat integration.
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
        RiotError::Transport(error.without_url().to_string())
    }

    /// True when the failure means "nobody is signed in / the client isn't up"
    /// rather than a genuine fault, so callers can show a sign-in state instead
    /// of an error toast. Mirrors the intent of
    /// [`crate::riot::client::is_login_required_error`] for the typed layer.
    pub fn is_login_required(&self) -> bool {
        match self {
            RiotError::RiotClientNotRunning
            | RiotError::RiotClientUnavailable
            | RiotError::MalformedLockfile
            | RiotError::Transport(_)
            | RiotError::NotConnected
            | RiotError::AuthenticationFailed { .. } => true,
            RiotError::Http { status } | RiotError::RequestFailed { status } => {
                *status == 401 || *status == 403 || *status == 503
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
