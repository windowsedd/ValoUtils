use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::broadcast;

const BOT_DIRECT_CAPACITY: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BotDirectMessage {
    pub sequence: u64,
    pub body: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BotDirectError {
    NoActiveRelay,
}

impl fmt::Display for BotDirectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoActiveRelay => formatter
                .write_str("Dummy Bot direct messages require an active Riot relay connection."),
        }
    }
}

impl std::error::Error for BotDirectError {}

pub struct BotDirectHub {
    sender: broadcast::Sender<BotDirectMessage>,
    sequence: AtomicU64,
}

impl BotDirectHub {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(BOT_DIRECT_CAPACITY);
        Self {
            sender,
            sequence: AtomicU64::new(1),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BotDirectMessage> {
        self.sender.subscribe()
    }

    pub fn deliver(&self, body: &str) -> Result<BotDirectMessage, BotDirectError> {
        if self.sender.receiver_count() == 0 {
            return Err(BotDirectError::NoActiveRelay);
        }
        let message = BotDirectMessage {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            body: body.to_string(),
        };
        self.sender
            .send(message.clone())
            .map_err(|_| BotDirectError::NoActiveRelay)?;
        Ok(message)
    }
}

impl Default for BotDirectHub {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_requires_an_active_relay() {
        let hub = BotDirectHub::new();
        assert_eq!(hub.deliver("hello"), Err(BotDirectError::NoActiveRelay));
    }

    #[tokio::test]
    async fn subscriber_receives_one_message() {
        let hub = BotDirectHub::new();
        let mut receiver = hub.subscribe();
        let sent = hub.deliver("hello").unwrap();
        assert_eq!(receiver.recv().await.unwrap(), sent);
    }

    #[tokio::test]
    async fn message_sequences_are_monotonic() {
        let hub = BotDirectHub::new();
        let mut receiver = hub.subscribe();
        let first = hub.deliver("one").unwrap();
        let second = hub.deliver("two").unwrap();
        assert_eq!(second.sequence, first.sequence + 1);
        assert_eq!(receiver.recv().await.unwrap(), first);
        assert_eq!(receiver.recv().await.unwrap(), second);
    }
}
