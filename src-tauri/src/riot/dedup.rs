//! Bounded "have I already handled this message?" cache for the chat poller.
//!
//! Polling `/chat/v6/messages` returns a rolling history, not a delta, so every
//! tick re-reports messages that were already seen. Without a memory the poller
//! would re-emit the whole window each time and re-translate the same line
//! forever.
//!
//! The cache is bounded because a long session in a busy All chat would
//! otherwise grow without limit. Eviction is strictly oldest-first, which is
//! safe here: Riot's history window is small and fixed, so a key old enough to
//! be evicted is also old enough to have fallen out of the window it could
//! reappear in.

use std::collections::{HashSet, VecDeque};

/// Enough to cover Riot's history window many times over while staying trivial
/// in memory (a few hundred short strings).
pub const DEFAULT_CAPACITY: usize = 512;

#[derive(Debug)]
pub struct SeenMessages {
    capacity: usize,
    order: VecDeque<String>,
    seen: HashSet<String>,
}

impl Default for SeenMessages {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl SeenMessages {
    /// A zero capacity would mean "remember nothing", which silently turns the
    /// poller into an infinite re-emitter, so it is clamped to at least one.
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            capacity,
            order: VecDeque::with_capacity(capacity),
            seen: HashSet::with_capacity(capacity),
        }
    }

    /// Records a key. Returns `true` the first time a key is offered and
    /// `false` on every repeat, so callers can write `if seen.observe(key) {
    /// ...handle it... }`.
    pub fn observe(&mut self, key: impl Into<String>) -> bool {
        let key = key.into();
        if !self.seen.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        while self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.seen.remove(&evicted);
            }
        }
        true
    }

    /// Marks a key as already handled without treating it as new.
    ///
    /// This is what stops a reconnect from replaying history: the first poll
    /// after (re)connecting primes every message it finds, so only genuinely
    /// new traffic is emitted afterwards.
    pub fn prime(&mut self, key: impl Into<String>) {
        self.observe(key);
    }

    pub fn contains(&self, key: &str) -> bool {
        self.seen.contains(key)
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Forgets everything. Used when the VALORANT session changes and the CIDs
    /// are re-resolved, so keys from a finished match cannot mask a new one.
    pub fn clear(&mut self) {
        self.order.clear();
        self.seen.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_new_exactly_once() {
        let mut seen = SeenMessages::default();

        assert!(seen.observe("msg-1"));
        assert!(!seen.observe("msg-1"));
        assert!(!seen.observe("msg-1"));
        assert!(seen.observe("msg-2"));
    }

    #[test]
    fn priming_history_stops_it_being_replayed() {
        let mut seen = SeenMessages::default();

        for key in ["old-1", "old-2", "old-3"] {
            seen.prime(key);
        }

        assert!(!seen.observe("old-2"), "primed history must not re-emit");
        assert!(
            seen.observe("new-1"),
            "fresh traffic must still come through"
        );
    }

    #[test]
    fn the_cache_stays_bounded_and_evicts_oldest_first() {
        let mut seen = SeenMessages::new(3);

        for key in ["a", "b", "c"] {
            seen.observe(key);
        }
        assert_eq!(seen.len(), 3);

        seen.observe("d");

        assert_eq!(seen.len(), 3, "capacity must hold");
        assert!(!seen.contains("a"), "oldest key should have been evicted");
        assert!(seen.contains("b") && seen.contains("c") && seen.contains("d"));
    }

    #[test]
    fn zero_capacity_is_clamped_so_it_cannot_become_a_re_emitter() {
        let mut seen = SeenMessages::new(0);

        assert!(seen.observe("only"));
        assert!(!seen.observe("only"));
    }

    #[test]
    fn clearing_lets_a_new_session_reuse_old_keys() {
        let mut seen = SeenMessages::default();
        seen.observe("msg-1");

        seen.clear();

        assert!(seen.is_empty());
        assert!(seen.observe("msg-1"));
    }
}
