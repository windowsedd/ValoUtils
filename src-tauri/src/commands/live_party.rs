use crate::riot::api::RiotApiClient;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio::task::JoinSet;

const HISTORY_TTL: Duration = Duration::from_secs(30);
const MATCH_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_HISTORY_CACHE_ENTRIES: usize = 512;
const MAX_MATCH_CACHE_ENTRIES: usize = 512;
const EMPTY_PARTY_ID: &str = "00000000-0000-0000-0000-000000000000";
const RIOT_REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);
const HISTORY_FALLBACK_BUDGET: Duration = Duration::from_secs(4);
const PD_REQUEST_SPACING: Duration = Duration::from_millis(200);
const PD_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(60);
/// Cloudflare 1015 escalates against a client that keeps coming back, so each
/// strike waits twice as long as the last one before anything is tried again.
const PD_RATE_LIMIT_MAX_COOLDOWN: Duration = Duration::from_secs(10 * 60);
/// A strike this long after the previous one is a fresh incident, and starts
/// the backoff over at the base cooldown.
const PD_RATE_LIMIT_RESET: Duration = Duration::from_secs(15 * 60);
/// The sustained ceiling, applied on top of the spacing floor.
///
/// Spacing alone allows 5 requests a second forever, which is what scouting ten
/// cold players sustains for a full minute. These two shape that into a burst
/// that stays snappy - the roster names and ranks the table is waiting on -
/// settling to a rate the endpoint tolerates once the burst credit is spent.
const PD_SUSTAINED_INTERVAL: Duration = Duration::from_millis(400);
const PD_BURST_TOLERANCE: u32 = 20;
/// How far back a shared `partyId` still says anything about who is queued
/// together *now*.
///
/// Party inference for strangers has no live source — Riot only exposes party
/// ids through friend presence — so it falls back to "these two shared a
/// partyId in a match they both played". Match history is pulled 25 deep with
/// no time bound, and 25 matches can span weeks, so a duo from a fortnight ago
/// kept labelling two solo-queued strangers as a party. Evidence older than
/// this window is dropped; a match whose start time can't be read is kept,
/// since an unreadable timestamp is not evidence of staleness.
const HISTORICAL_PARTY_WINDOW_MS: i64 = 14 * 24 * 60 * 60 * 1000;

pub(super) const RATE_LIMITED_ERROR: &str = "rateLimited";

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

fn is_rate_limited_error(error: &str) -> bool {
    error.contains("\"status\":429")
        || error.contains("\"status\": 429")
        || error.to_ascii_lowercase().contains("error code: 1015")
}

/// How often the gate reports what it has been sending, so a throttle can be
/// read back against the volume that earned it rather than guessed at.
const PD_LOG_WINDOW: Duration = Duration::from_secs(60);

/// The endpoint a Riot error came from, for a log line that names the culprit.
///
/// Every id in it is replaced first: these paths carry PUUIDs and match ids,
/// and the line they end up on is written to a file a user may pass around.
fn error_path(error: &str) -> Option<String> {
    let path = error
        .split("\"path\":\"")
        .nth(1)?
        .split('"')
        .next()
        .filter(|path| !path.is_empty())?;
    let redacted: Vec<&str> = path
        .split('/')
        .map(|segment| if looks_like_id(segment) { "<id>" } else { segment })
        .collect();
    Some(redacted.join("/"))
}

fn looks_like_id(segment: &str) -> bool {
    segment.len() >= 32
        && segment
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

/// The `Retry-After` seconds Riot attached to the refusal, if it sent one.
fn retry_after_hint(error: &str) -> Option<Duration> {
    let raw = error.split("\"retryAfter\":").nth(1)?;
    let digits: String = raw
        .trim_start()
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    let seconds: u64 = digits.parse().ok()?;
    (seconds > 0).then(|| Duration::from_secs(seconds.min(PD_RATE_LIMIT_MAX_COOLDOWN.as_secs())))
}

#[derive(Default)]
struct RateGate {
    next_allowed: Option<Instant>,
    cooldown_until: Option<Instant>,
    /// Consecutive strikes, deciding how long the next cooldown lasts.
    strikes: u32,
    last_strike: Option<Instant>,
    /// How long the current cooldown was set for, to report on resuming.
    cooldown_len: Duration,
    /// Virtual arrival time of the next request under the sustained ceiling.
    /// Anything scheduled before it, less the burst tolerance, is free.
    theoretical_arrival: Option<Instant>,
    /// Rolling accounting, reported once per `PD_LOG_WINDOW`.
    window_started: Option<Instant>,
    window_requests: u32,
    window_longest_wait: Duration,
}

impl RateGate {
    /// Records a throttle and returns how long nothing may be sent for.
    fn mark_rate_limited(&mut self, now: Instant, hint: Option<Duration>) -> Duration {
        let consecutive = self
            .last_strike
            .is_some_and(|last| now.duration_since(last) < PD_RATE_LIMIT_RESET);
        self.strikes = if consecutive { self.strikes + 1 } else { 1 };
        self.last_strike = Some(now);

        // Riot's own number wins where it sent one; otherwise double per strike.
        let cooldown = hint.unwrap_or_else(|| {
            PD_RATE_LIMIT_COOLDOWN
                .saturating_mul(1u32 << (self.strikes - 1).min(8))
                .min(PD_RATE_LIMIT_MAX_COOLDOWN)
        });
        self.cooldown_until = Some(now + cooldown);
        self.cooldown_len = cooldown;
        // Anything queued behind the spacing floor is void: the whole point of
        // a cooldown is that nothing goes out during it.
        self.next_allowed = None;
        self.theoretical_arrival = None;
        cooldown
    }

    fn is_cooling_down_at(&self, now: Instant) -> bool {
        self.cooldown_until.is_some_and(|until| now < until)
    }

    fn cooldown_remaining_at(&self, now: Instant) -> Option<Duration> {
        self.cooldown_until
            .filter(|until| now < *until)
            .map(|until| until.duration_since(now))
    }

    /// When the next request may start: no sooner than the spacing floor, and
    /// no sooner than the sustained ceiling allows once the burst is spent.
    fn reserve_at(&mut self, now: Instant) -> Instant {
        if self.cooldown_until.is_some_and(|until| now >= until) {
            self.cooldown_until = None;
            log::info!(
                "PD requests resuming after a {}s pause (strike {})",
                self.cooldown_len.as_secs(),
                self.strikes
            );
        }
        let spaced = self.next_allowed.unwrap_or(now).max(now);
        let arrival = self.theoretical_arrival.unwrap_or(now).max(now);
        let burst = PD_SUSTAINED_INTERVAL * PD_BURST_TOLERANCE.saturating_sub(1);
        let sustained = arrival.checked_sub(burst).unwrap_or(now);

        let scheduled = spaced.max(sustained).max(now);
        self.next_allowed = Some(scheduled + PD_REQUEST_SPACING);
        self.theoretical_arrival = Some(arrival + PD_SUSTAINED_INTERVAL);
        self.account_for(scheduled.duration_since(now), now);
        scheduled
    }

    /// Counts a scheduled request, reporting the window once it closes. The
    /// longest wait says how hard the ceiling is shaping: near zero means the
    /// budget is untouched, seconds mean requests are queueing behind it.
    fn account_for(&mut self, wait: Duration, now: Instant) {
        let started = *self.window_started.get_or_insert(now);
        self.window_requests += 1;
        self.window_longest_wait = self.window_longest_wait.max(wait);

        let elapsed = now.duration_since(started);
        if elapsed < PD_LOG_WINDOW {
            return;
        }
        log::info!(
            "PD budget: {} requests in {}s, longest wait {}ms",
            self.window_requests,
            elapsed.as_secs(),
            self.window_longest_wait.as_millis()
        );
        self.window_started = Some(now);
        self.window_requests = 0;
        self.window_longest_wait = Duration::ZERO;
    }
}

fn valid_party_id(party_id: &str) -> bool {
    let party_id = party_id.trim();
    !party_id.is_empty() && !party_id.eq_ignore_ascii_case(EMPTY_PARTY_ID)
}

async fn riot_request_with_timeout<T, F>(duration: Duration, request: F) -> Option<T>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::time::timeout(duration, request).await.ok()?.ok()
}

#[derive(Clone)]
struct Timed<T> {
    value: T,
    inserted_at: Instant,
}

#[derive(Clone)]
pub(crate) struct LivePartyHistoryCache {
    histories: Arc<Mutex<HashMap<String, Timed<Vec<String>>>>>,
    history_documents: Arc<Mutex<HashMap<String, Timed<Value>>>>,
    matches: Arc<Mutex<HashMap<String, Timed<Value>>>>,
    permits: Arc<Semaphore>,
    rate_gate: Arc<AsyncMutex<RateGate>>,
}

impl Default for LivePartyHistoryCache {
    fn default() -> Self {
        Self {
            histories: Arc::new(Mutex::new(HashMap::new())),
            history_documents: Arc::new(Mutex::new(HashMap::new())),
            matches: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(3)),
            rate_gate: Arc::new(AsyncMutex::new(RateGate::default())),
        }
    }
}

impl LivePartyHistoryCache {
    fn get_history_document_at(&self, puuid: &str, now: Instant) -> Option<Value> {
        let key = puuid.to_ascii_lowercase();
        let mut documents = self.history_documents.lock().unwrap();
        let entry = documents.get(&key)?;
        if now.duration_since(entry.inserted_at) > HISTORY_TTL {
            documents.remove(&key);
            return None;
        }
        Some(entry.value.clone())
    }

    fn put_history_document_at(&self, puuid: &str, document: Value, now: Instant) {
        let key = puuid.to_ascii_lowercase();
        let mut documents = self.history_documents.lock().unwrap();
        documents.retain(|_, entry| now.duration_since(entry.inserted_at) <= HISTORY_TTL);
        if !documents.contains_key(&key) && documents.len() >= MAX_HISTORY_CACHE_ENTRIES {
            if let Some(oldest) = documents
                .iter()
                .min_by_key(|(_, entry)| entry.inserted_at)
                .map(|(key, _)| key.clone())
            {
                documents.remove(&oldest);
            }
        }
        documents.insert(
            key,
            Timed {
                value: document,
                inserted_at: now,
            },
        );
    }

    fn get_history_at(&self, puuid: &str, now: Instant) -> Option<Vec<String>> {
        let key = puuid.to_ascii_lowercase();
        let mut histories = self.histories.lock().unwrap();
        let entry = histories.get(&key)?;
        if now.duration_since(entry.inserted_at) > HISTORY_TTL {
            histories.remove(&key);
            return None;
        }
        Some(entry.value.clone())
    }

    fn put_history_at(&self, puuid: &str, matches: Vec<String>, now: Instant) {
        let key = puuid.to_ascii_lowercase();
        let mut histories = self.histories.lock().unwrap();
        histories.retain(|_, entry| now.duration_since(entry.inserted_at) <= HISTORY_TTL);
        if !histories.contains_key(&key) && histories.len() >= MAX_HISTORY_CACHE_ENTRIES {
            if let Some(oldest) = histories
                .iter()
                .min_by_key(|(_, entry)| entry.inserted_at)
                .map(|(key, _)| key.clone())
            {
                histories.remove(&oldest);
            }
        }
        histories.insert(
            key,
            Timed {
                value: matches,
                inserted_at: now,
            },
        );
    }

    fn get_match_at(&self, match_id: &str, now: Instant) -> Option<Value> {
        let mut matches = self.matches.lock().unwrap();
        let entry = matches.get(match_id)?;
        if now.duration_since(entry.inserted_at) > MATCH_TTL {
            matches.remove(match_id);
            return None;
        }
        Some(entry.value.clone())
    }

    fn put_match_at(&self, match_id: &str, details: Value, now: Instant) {
        let mut matches = self.matches.lock().unwrap();
        if !matches.contains_key(match_id) && matches.len() >= MAX_MATCH_CACHE_ENTRIES {
            if let Some(oldest) = matches
                .iter()
                .min_by_key(|(_, entry)| entry.inserted_at)
                .map(|(key, _)| key.clone())
            {
                matches.remove(&oldest);
            }
        }
        matches.insert(
            match_id.to_string(),
            Timed {
                value: details,
                inserted_at: now,
            },
        );
    }

    fn get_history(&self, puuid: &str) -> Option<Vec<String>> {
        self.get_history_at(puuid, Instant::now())
    }

    fn put_history(&self, puuid: &str, matches: Vec<String>) {
        self.put_history_at(puuid, matches, Instant::now());
    }

    pub(super) fn get_history_document(&self, puuid: &str) -> Option<Value> {
        self.get_history_document_at(puuid, Instant::now())
    }

    pub(super) fn put_history_document(&self, puuid: &str, document: Value) {
        self.put_history_document_at(puuid, document, Instant::now());
    }

    pub(super) fn get_match(&self, match_id: &str) -> Option<Value> {
        self.get_match_at(match_id, Instant::now())
    }

    pub(super) fn put_match(&self, match_id: &str, details: Value) {
        self.put_match_at(match_id, details, Instant::now());
    }

    pub(super) async fn run_pd<T, F>(&self, request: F) -> Result<T, String>
    where
        F: Future<Output = Result<T, String>>,
    {
        let scheduled = {
            let mut gate = self.rate_gate.lock().await;
            let now = Instant::now();
            if gate.is_cooling_down_at(now) {
                return Err(RATE_LIMITED_ERROR.to_string());
            }
            gate.reserve_at(now)
        };

        tokio::time::sleep_until(tokio::time::Instant::from_std(scheduled)).await;
        if self
            .rate_gate
            .lock()
            .await
            .is_cooling_down_at(Instant::now())
        {
            return Err(RATE_LIMITED_ERROR.to_string());
        }

        match request.await {
            Ok(value) => Ok(value),
            Err(error) if is_rate_limited_error(&error) => {
                let hint = retry_after_hint(&error);
                let mut gate = self.rate_gate.lock().await;
                let cooldown = gate.mark_rate_limited(Instant::now(), hint);
                log::warn!(
                    "Riot throttled {} (strike {}); holding PD requests for {}s{}",
                    error_path(&error)
                        .unwrap_or_else(|| "a PD endpoint".to_string()),
                    gate.strikes,
                    cooldown.as_secs(),
                    if hint.is_some() {
                        ", as asked by Retry-After"
                    } else {
                        ""
                    }
                );
                Err(RATE_LIMITED_ERROR.to_string())
            }
            Err(error) => Err(error),
        }
    }

    /// Seconds until requests are worth trying again, so a caller can say when
    /// data is coming back rather than only that it is missing.
    pub(super) async fn cooldown_seconds(&self) -> Option<u64> {
        self.rate_gate
            .lock()
            .await
            .cooldown_remaining_at(Instant::now())
            .map(|remaining| remaining.as_secs().max(1))
    }
}

fn recent_match_ids(history: &Value, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    history
        .get("History")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("MatchID").and_then(Value::as_str))
        .filter(|match_id| !match_id.is_empty() && seen.insert((*match_id).to_string()))
        .take(limit)
        .map(str::to_string)
        .collect()
}

fn shared_match_ids(histories: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut occurrences: HashMap<&str, (usize, usize)> = HashMap::new();
    for matches in histories.values() {
        let mut seen_for_player = HashSet::new();
        for (index, match_id) in matches.iter().enumerate() {
            if match_id.is_empty() || !seen_for_player.insert(match_id.as_str()) {
                continue;
            }
            let entry = occurrences.entry(match_id).or_insert((0, index));
            entry.0 += 1;
            entry.1 = entry.1.min(index);
        }
    }
    let mut shared: Vec<(&str, usize)> = occurrences
        .into_iter()
        .filter_map(|(match_id, (players, index))| (players >= 2).then_some((match_id, index)))
        .collect();
    shared.sort_unstable_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(right.0)));
    shared
        .into_iter()
        .map(|(match_id, _)| match_id.to_string())
        .collect()
}

fn shared_match_owners(
    histories: &HashMap<String, Vec<String>>,
) -> HashMap<String, HashSet<String>> {
    let mut owners_by_match: HashMap<String, HashSet<String>> = HashMap::new();
    for (puuid, matches) in histories {
        let puuid = puuid.to_ascii_lowercase();
        for match_id in matches {
            if !match_id.is_empty() {
                owners_by_match
                    .entry(match_id.clone())
                    .or_default()
                    .insert(puuid.clone());
            }
        }
    }
    owners_by_match.retain(|_, owners| owners.len() >= 2);
    owners_by_match
}

/// Match start time, from either spelling Riot uses for match details.
fn match_start_millis(details: &Value) -> Option<i64> {
    details
        .pointer("/matchInfo/gameStartMillis")
        .or_else(|| details.pointer("/MatchInfo/GameStartMillis"))
        .or_else(|| details.get("gameStartMillis"))
        .and_then(Value::as_i64)
}

/// Whether a past match is recent enough to say anything about current parties.
/// Unknown start times pass — see [`HISTORICAL_PARTY_WINDOW_MS`].
fn within_party_window(details: &Value, now_millis: i64) -> bool {
    match match_start_millis(details) {
        Some(start) => now_millis.saturating_sub(start) <= HISTORICAL_PARTY_WINDOW_MS,
        None => true,
    }
}

fn historical_groups_for_histories(
    histories: &HashMap<String, Vec<String>>,
    details_by_match: &HashMap<String, Value>,
    now_millis: i64,
) -> Vec<Vec<String>> {
    let owners_by_match = shared_match_owners(histories);
    let unresolved: HashSet<String> = owners_by_match
        .values()
        .flat_map(|owners| owners.iter().cloned())
        .collect();
    let eligible_details: HashMap<String, Value> = owners_by_match
        .into_iter()
        .filter_map(|(match_id, owners)| {
            let details = details_by_match.get(&match_id)?;
            if !within_party_window(details, now_millis) {
                return None;
            }
            let players: Vec<Value> = details
                .get("players")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|player| {
                    player
                        .get("subject")
                        .or_else(|| player.get("Subject"))
                        .and_then(Value::as_str)
                        .is_some_and(|subject| owners.contains(&subject.to_ascii_lowercase()))
                })
                .cloned()
                .collect();
            Some((match_id, serde_json::json!({ "players": players })))
        })
        .collect();
    historical_groups(&unresolved, &eligible_details)
}

fn historical_groups(
    unresolved: &HashSet<String>,
    details_by_match: &HashMap<String, Value>,
) -> Vec<Vec<String>> {
    let unresolved: HashSet<String> = unresolved
        .iter()
        .map(|puuid| puuid.to_ascii_lowercase())
        .collect();
    let mut candidates: HashSet<Vec<String>> = HashSet::new();

    for details in details_by_match.values() {
        let mut parties: HashMap<&str, Vec<String>> = HashMap::new();
        for player in details
            .get("players")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(subject) = player
                .get("subject")
                .or_else(|| player.get("Subject"))
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)
            else {
                continue;
            };
            if !unresolved.contains(&subject) {
                continue;
            }
            let Some(party_id) = player
                .get("partyId")
                .and_then(Value::as_str)
                .filter(|party_id| valid_party_id(party_id))
            else {
                continue;
            };
            parties.entry(party_id).or_default().push(subject);
        }
        for mut members in parties.into_values() {
            members.sort_unstable();
            members.dedup();
            if members.len() >= 2 {
                candidates.insert(members);
            }
        }
    }

    let mut appearances: HashMap<String, usize> = HashMap::new();
    for candidate in &candidates {
        for member in candidate {
            *appearances.entry(member.clone()).or_default() += 1;
        }
    }
    let conflicted: HashSet<String> = appearances
        .into_iter()
        .filter_map(|(member, count)| (count > 1).then_some(member))
        .collect();
    let mut groups: Vec<Vec<String>> = candidates
        .into_iter()
        .filter(|candidate| {
            candidate
                .iter()
                .all(|member| !conflicted.contains(member.as_str()))
        })
        .collect();
    groups.sort_unstable();
    groups
}

pub(super) struct PartyResolution {
    membership_by_puuid: HashMap<String, String>,
}

fn live_membership_by_puuid(
    roster: &[String],
    presence: &HashMap<String, String>,
    premade: &HashSet<String>,
    own_party_id: Option<&str>,
) -> HashMap<String, String> {
    let normalized_presence: HashMap<String, &String> = presence
        .iter()
        .filter(|(_, party_id)| valid_party_id(party_id))
        .map(|(puuid, party_id)| (puuid.to_ascii_lowercase(), party_id))
        .collect();
    let normalized_premade: HashSet<String> = premade
        .iter()
        .map(|puuid| puuid.to_ascii_lowercase())
        .collect();
    let own_party_id = own_party_id.filter(|party_id| valid_party_id(party_id));
    let mut memberships = HashMap::new();

    for puuid in roster {
        let normalized = puuid.to_ascii_lowercase();
        let live_party = normalized_presence
            .get(&normalized)
            .map(|party_id| party_id.as_str())
            .or_else(|| {
                normalized_premade
                    .contains(&normalized)
                    .then_some(own_party_id)
                    .flatten()
            });
        if let Some(party_id) = live_party {
            memberships.insert(normalized, format!("live:{party_id}"));
        }
    }
    memberships
}

fn unresolved_puuids(
    roster: &[String],
    presence: &HashMap<String, String>,
    premade: &HashSet<String>,
    own_party_id: Option<&str>,
) -> Vec<String> {
    let live = live_membership_by_puuid(roster, presence, premade, own_party_id);
    roster
        .iter()
        .map(|puuid| puuid.to_ascii_lowercase())
        .filter(|puuid| !live.contains_key(puuid))
        .collect()
}

fn continuity_groups(labels: &HashMap<String, String>) -> Vec<Vec<String>> {
    let mut by_label: HashMap<&str, Vec<String>> = HashMap::new();
    for (puuid, label) in labels {
        by_label
            .entry(label.as_str())
            .or_default()
            .push(puuid.to_ascii_lowercase());
    }
    let mut groups: Vec<Vec<String>> = by_label
        .into_values()
        .filter_map(|mut members| {
            members.sort_unstable();
            members.dedup();
            (members.len() >= 2).then_some(members)
        })
        .collect();
    groups.sort_unstable();
    groups
}

fn continuity_resolved_members(
    roster: &[String],
    live_memberships: &HashMap<String, String>,
    groups: &[Vec<String>],
) -> HashSet<String> {
    let normalized_roster: HashSet<String> = roster
        .iter()
        .map(|puuid| puuid.to_ascii_lowercase())
        .collect();
    groups
        .iter()
        .filter_map(|group| {
            let members: HashSet<String> = group
                .iter()
                .map(|puuid| puuid.to_ascii_lowercase())
                .filter(|puuid| normalized_roster.contains(puuid))
                .collect();
            let live_parties: HashSet<&str> = members
                .iter()
                .filter_map(|puuid| live_memberships.get(puuid).map(String::as_str))
                .collect();
            (members.len() >= 2 && live_parties.len() <= 1).then_some(members)
        })
        .flatten()
        .collect()
}

impl PartyResolution {
    pub(super) fn partition_key(&self, roster: &[String]) -> String {
        let mut groups: HashMap<&str, Vec<String>> = HashMap::new();
        for puuid in roster {
            let normalized = puuid.to_ascii_lowercase();
            if let Some(membership) = self.membership_by_puuid.get(&normalized) {
                groups.entry(membership).or_default().push(normalized);
            }
        }
        let mut partitions: Vec<String> = groups
            .into_values()
            .map(|mut members| {
                members.sort_unstable();
                members.join(",")
            })
            .collect();
        partitions.sort_unstable();
        partitions.join("|")
    }

    pub(super) fn anonymous_labels(&self, roster: &[String]) -> HashMap<String, String> {
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for membership in self.membership_by_puuid.values() {
            *counts.entry(membership).or_default() += 1;
        }

        let mut labels_by_membership: HashMap<&str, String> = HashMap::new();
        let mut labels = HashMap::new();
        for puuid in roster {
            let normalized = puuid.to_ascii_lowercase();
            let Some(membership) = self.membership_by_puuid.get(&normalized) else {
                continue;
            };
            if counts.get(membership.as_str()).copied().unwrap_or_default() < 2 {
                continue;
            }
            let next_number = labels_by_membership.len() + 1;
            let label = labels_by_membership
                .entry(membership)
                .or_insert_with(|| format!("Team {next_number}"))
                .clone();
            labels.insert(normalized, label);
        }
        labels
    }
}

fn resolve_sources(
    roster: &[String],
    presence: &HashMap<String, String>,
    premade: &HashSet<String>,
    own_party_id: Option<&str>,
    continuity_groups: &[Vec<String>],
    historical_groups: &[Vec<String>],
) -> PartyResolution {
    let mut membership_by_puuid = live_membership_by_puuid(roster, presence, premade, own_party_id);

    for group in continuity_groups {
        let mut members: Vec<String> = group
            .iter()
            .map(|puuid| puuid.to_ascii_lowercase())
            .filter(|puuid| roster.iter().any(|entry| entry.eq_ignore_ascii_case(puuid)))
            .collect();
        members.sort_unstable();
        members.dedup();
        if members.len() < 2 {
            continue;
        }

        let live_memberships: HashSet<String> = members
            .iter()
            .filter_map(|puuid| membership_by_puuid.get(puuid))
            .filter(|membership| membership.starts_with("live:"))
            .cloned()
            .collect();
        let continuity_membership = match live_memberships.len() {
            0 => format!("continuity:{}", members.join(",")),
            1 => live_memberships.into_iter().next().unwrap(),
            _ => continue,
        };
        for puuid in members {
            membership_by_puuid
                .entry(puuid)
                .or_insert_with(|| continuity_membership.clone());
        }
    }

    for group in historical_groups {
        let mut members: Vec<String> = group
            .iter()
            .map(|puuid| puuid.to_ascii_lowercase())
            .filter(|puuid| roster.iter().any(|entry| entry.eq_ignore_ascii_case(puuid)))
            .collect();
        members.sort_unstable();
        members.dedup();
        if members.len() < 2
            || members
                .iter()
                .any(|puuid| membership_by_puuid.contains_key(puuid))
        {
            continue;
        }
        let membership = format!("history:{}", members.join(","));
        for puuid in members {
            membership_by_puuid.insert(puuid, membership.clone());
        }
    }

    for puuid in roster {
        let normalized = puuid.to_ascii_lowercase();
        membership_by_puuid
            .entry(normalized.clone())
            .or_insert_with(|| format!("solo:{normalized}"));
    }

    PartyResolution {
        membership_by_puuid,
    }
}

pub(super) async fn resolve_live_parties(
    api: &RiotApiClient,
    roster: &[String],
    presence: &HashMap<String, String>,
    premade: &HashSet<String>,
    own_party_id: Option<&str>,
    continuity_labels: &HashMap<String, String>,
    cache: &LivePartyHistoryCache,
) -> PartyResolution {
    let continuity = continuity_groups(continuity_labels);
    let live_memberships = live_membership_by_puuid(roster, presence, premade, own_party_id);
    let continuity_members = continuity_resolved_members(roster, &live_memberships, &continuity);
    let unresolved: Vec<String> = unresolved_puuids(roster, presence, premade, own_party_id)
        .into_iter()
        .filter(|puuid| !continuity_members.contains(puuid))
        .collect();
    if unresolved.len() < 2 {
        return resolve_sources(roster, presence, premade, own_party_id, &continuity, &[]);
    }

    let historical = tokio::time::timeout(
        HISTORY_FALLBACK_BUDGET,
        fetch_historical_groups(api, &unresolved, cache),
    )
    .await
    .unwrap_or_default();
    resolve_sources(
        roster,
        presence,
        premade,
        own_party_id,
        &continuity,
        &historical,
    )
}

async fn fetch_historical_groups(
    api: &RiotApiClient,
    unresolved: &[String],
    cache: &LivePartyHistoryCache,
) -> Vec<Vec<String>> {
    let mut histories = HashMap::new();
    let mut history_tasks = JoinSet::new();
    for puuid in unresolved {
        if let Some(matches) = cache.get_history(puuid) {
            histories.insert(puuid.clone(), matches);
            continue;
        }
        if let Some(history) = cache.get_history_document(puuid) {
            let matches = recent_match_ids(&history, 25);
            cache.put_history(puuid, matches.clone());
            histories.insert(puuid.clone(), matches);
            continue;
        }
        let api = api.clone();
        let cache = cache.clone();
        let puuid = puuid.clone();
        history_tasks.spawn(async move {
            let _permit = cache.permits.acquire().await.ok()?;
            let history = riot_request_with_timeout(
                RIOT_REQUEST_TIMEOUT,
                cache.run_pd(api.get_match_history(&puuid, 0, 25)),
            )
            .await?;
            cache.put_history_document(&puuid, history.clone());
            let matches = recent_match_ids(&history, 25);
            cache.put_history(&puuid, matches.clone());
            Some((puuid, matches))
        });
    }
    while let Some(result) = history_tasks.join_next().await {
        if let Ok(Some((puuid, matches))) = result {
            histories.insert(puuid, matches);
        }
    }

    let mut details_by_match = HashMap::new();
    let mut match_tasks = JoinSet::new();
    for match_id in shared_match_ids(&histories) {
        if let Some(details) = cache.get_match(&match_id) {
            details_by_match.insert(match_id, details);
            continue;
        }
        let api = api.clone();
        let cache = cache.clone();
        match_tasks.spawn(async move {
            let _permit = cache.permits.acquire().await.ok()?;
            let details = riot_request_with_timeout(
                RIOT_REQUEST_TIMEOUT,
                cache.run_pd(api.get_match_details(&match_id)),
            )
            .await?;
            cache.put_match(&match_id, details.clone());
            Some((match_id, details))
        });
    }
    while let Some(result) = match_tasks.join_next().await {
        if let Ok(Some((match_id, details))) = result {
            details_by_match.insert(match_id, details);
        }
    }

    historical_groups_for_histories(&histories, &details_by_match, now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    fn roster() -> Vec<String> {
        ["p1", "p2", "p3", "p4"]
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn source_presence_wins_over_history() {
        let presence = HashMap::from([
            ("p1".into(), "live-a".into()),
            ("p2".into(), "live-a".into()),
        ]);
        let resolution = resolve_sources(
            &roster(),
            &presence,
            &HashSet::new(),
            None,
            &[],
            &[vec!["p1".into(), "p3".into()]],
        );

        let labels = resolution.anonymous_labels(&roster());
        assert_eq!(labels.get("p1"), Some(&"Team 1".to_string()));
        assert_eq!(labels.get("p2"), Some(&"Team 1".to_string()));
        assert!(!labels.contains_key("p3"));
    }

    #[test]
    fn source_live_membership_fills_missing_members_from_continuity() {
        let presence = HashMap::from([("p1".into(), "current-live-party".into())]);
        let resolution = resolve_sources(
            &roster(),
            &presence,
            &HashSet::new(),
            None,
            &[vec!["p1".into(), "p2".into()]],
            &[],
        );

        let labels = resolution.anonymous_labels(&roster());
        assert_eq!(labels.get("p1"), Some(&"Team 1".to_string()));
        assert_eq!(labels.get("p2"), Some(&"Team 1".to_string()));
    }

    #[test]
    fn source_own_party_roster_remains_live() {
        let premade = HashSet::from(["p1".into(), "p2".into()]);
        let resolution = resolve_sources(
            &roster(),
            &HashMap::new(),
            &premade,
            Some("own-live-party"),
            &[],
            &[],
        );

        let labels = resolution.anonymous_labels(&roster());
        assert_eq!(labels.get("p1"), Some(&"Team 1".to_string()));
        assert_eq!(labels.get("p2"), Some(&"Team 1".to_string()));
    }

    #[test]
    fn source_history_groups_only_players_without_live_membership() {
        let presence = HashMap::from([("p1".into(), "live-a".into())]);
        let resolution = resolve_sources(
            &roster(),
            &presence,
            &HashSet::new(),
            None,
            &[],
            &[
                vec!["p2".into(), "p3".into()],
                vec!["p1".into(), "p4".into()],
            ],
        );

        let labels = resolution.anonymous_labels(&roster());
        assert_eq!(labels.get("p2"), Some(&"Team 1".to_string()));
        assert_eq!(labels.get("p3"), Some(&"Team 1".to_string()));
        assert!(!labels.contains_key("p1"));
        assert!(!labels.contains_key("p4"));
    }

    #[test]
    fn source_partition_and_labels_are_anonymous() {
        let presence = HashMap::from([
            ("p1".into(), "secret-party-id".into()),
            ("p2".into(), "secret-party-id".into()),
        ]);
        let resolution = resolve_sources(
            &roster(),
            &presence,
            &HashSet::new(),
            None,
            &[],
            &[vec!["p3".into(), "p4".into()]],
        );

        let partition = resolution.partition_key(&roster());
        let labels = resolution.anonymous_labels(&roster());
        assert!(!partition.contains("secret-party-id"));
        assert_eq!(labels.get("p1"), Some(&"Team 1".to_string()));
        assert_eq!(labels.get("p3"), Some(&"Team 2".to_string()));
        assert!(labels.values().all(|label| label.starts_with("Team ")));
    }

    #[test]
    fn source_zero_uuid_presence_party_is_unresolved() {
        let roster = vec!["p1".into(), "p2".into()];
        let presence = HashMap::from([
            ("p1".into(), "00000000-0000-0000-0000-000000000000".into()),
            ("p2".into(), "00000000-0000-0000-0000-000000000000".into()),
        ]);

        let resolution = resolve_sources(&roster, &presence, &HashSet::new(), None, &[], &[]);

        assert!(resolution.anonymous_labels(&roster).is_empty());
    }

    #[test]
    fn history_uses_only_25_recent_unique_non_empty_match_ids() {
        let mut entries: Vec<serde_json::Value> = (0..27)
            .map(|index| json!({ "MatchID": format!("match-{index}") }))
            .collect();
        entries.insert(1, json!({ "MatchID": "match-0" }));
        entries.insert(2, json!({ "MatchID": "" }));

        let ids = recent_match_ids(&json!({ "History": entries }), 25);

        assert_eq!(ids.len(), 25);
        assert_eq!(ids.first().map(String::as_str), Some("match-0"));
        assert_eq!(ids.last().map(String::as_str), Some("match-24"));
    }

    #[test]
    fn history_requests_only_shared_match_ids_once() {
        let histories = HashMap::from([
            ("p1".into(), vec!["shared".into(), "only-p1".into()]),
            ("p2".into(), vec!["shared".into(), "other".into()]),
            ("p3".into(), vec!["shared".into(), "other".into()]),
        ]);

        assert_eq!(shared_match_ids(&histories), vec!["shared", "other"]);
    }

    #[test]
    fn history_links_only_same_non_empty_party_in_the_same_match() {
        let unresolved = HashSet::from(["p1".into(), "p2".into(), "p3".into()]);
        let details = HashMap::from([(
            "match-a".into(),
            json!({ "players": [
                { "subject": "p1", "partyId": "party-a" },
                { "subject": "P2", "partyId": "party-a" },
                { "subject": "p3", "partyId": "" }
            ]}),
        )]);

        assert_eq!(
            historical_groups(&unresolved, &details),
            vec![vec!["p1".to_string(), "p2".to_string()]]
        );
    }

    #[test]
    fn history_collapses_repeated_identical_member_sets() {
        let unresolved = HashSet::from(["p1".into(), "p2".into()]);
        let details = HashMap::from([
            (
                "match-a".into(),
                json!({ "players": [
                    { "subject": "p1", "partyId": "old-party-a" },
                    { "subject": "p2", "partyId": "old-party-a" }
                ]}),
            ),
            (
                "match-b".into(),
                json!({ "players": [
                    { "subject": "p1", "partyId": "old-party-b" },
                    { "subject": "p2", "partyId": "old-party-b" }
                ]}),
            ),
        ]);

        assert_eq!(historical_groups(&unresolved, &details).len(), 1);
    }

    #[test]
    fn history_discards_overlapping_candidates_with_different_members() {
        let unresolved = HashSet::from(["p1".into(), "p2".into(), "p3".into()]);
        let details = HashMap::from([
            (
                "match-a".into(),
                json!({ "players": [
                    { "subject": "p1", "partyId": "party-a" },
                    { "subject": "p2", "partyId": "party-a" }
                ]}),
            ),
            (
                "match-b".into(),
                json!({ "players": [
                    { "subject": "p1", "partyId": "party-b" },
                    { "subject": "p3", "partyId": "party-b" }
                ]}),
            ),
        ]);

        assert!(historical_groups(&unresolved, &details).is_empty());
    }

    #[test]
    fn history_missing_match_details_produces_no_group() {
        let unresolved = HashSet::from(["p1".into(), "p2".into()]);
        assert!(historical_groups(&unresolved, &HashMap::new()).is_empty());
    }

    #[test]
    fn history_excludes_details_players_without_recent_match_ownership() {
        let histories = HashMap::from([
            ("p1".into(), vec!["match-a".into()]),
            ("p2".into(), vec!["match-a".into()]),
            ("p3".into(), vec!["older-match".into()]),
        ]);
        let details = HashMap::from([(
            "match-a".into(),
            json!({ "players": [
                { "subject": "p1", "partyId": "party-a" },
                { "subject": "p2", "partyId": "party-a" },
                { "subject": "p3", "partyId": "party-a" }
            ]}),
        )]);

        assert_eq!(
            historical_groups_for_histories(&histories, &details, 0),
            vec![vec!["p1".to_string(), "p2".to_string()]]
        );
    }

    #[test]
    fn history_ignores_party_evidence_older_than_the_window() {
        let now = 1_700_000_000_000i64;
        let histories = HashMap::from([
            ("p1".into(), vec!["stale".into()]),
            ("p2".into(), vec!["stale".into()]),
        ]);
        let players = json!([
            { "subject": "p1", "partyId": "party-a" },
            { "subject": "p2", "partyId": "party-a" }
        ]);

        // A duo from three weeks ago says nothing about who queued together now.
        let stale = HashMap::from([(
            "stale".to_string(),
            json!({
                "matchInfo": { "gameStartMillis": now - 21 * 24 * 60 * 60 * 1000i64 },
                "players": players
            }),
        )]);
        assert!(historical_groups_for_histories(&histories, &stale, now).is_empty());

        // The same duo from yesterday still counts.
        let fresh = HashMap::from([(
            "stale".to_string(),
            json!({
                "matchInfo": { "gameStartMillis": now - 24 * 60 * 60 * 1000i64 },
                "players": players
            }),
        )]);
        assert_eq!(
            historical_groups_for_histories(&histories, &fresh, now),
            vec![vec!["p1".to_string(), "p2".to_string()]]
        );
    }

    #[test]
    fn history_keeps_matches_whose_start_time_is_unreadable() {
        // An unreadable timestamp is not evidence of staleness, so the match
        // stays eligible rather than silently dropping a real party.
        let now = 1_700_000_000_000i64;
        assert!(within_party_window(&json!({ "players": [] }), now));
        assert!(within_party_window(
            &json!({ "matchInfo": { "gameStartMillis": "not-a-number" } }),
            now
        ));
        assert!(!within_party_window(
            &json!({ "matchInfo": { "gameStartMillis": 0 } }),
            now
        ));
    }

    #[test]
    fn cache_history_entries_expire_after_30_seconds() {
        let cache = LivePartyHistoryCache::default();
        let now = Instant::now();
        cache.put_history_at("p1", vec!["match-a".into()], now);

        assert_eq!(
            cache.get_history_at("P1", now + Duration::from_secs(29)),
            Some(vec!["match-a".to_string()])
        );
        assert_eq!(
            cache.get_history_at("p1", now + Duration::from_secs(31)),
            None
        );
    }

    #[test]
    fn cache_match_entries_expire_after_six_hours() {
        let cache = LivePartyHistoryCache::default();
        let now = Instant::now();
        cache.put_match_at("match-a", json!({ "players": [] }), now);

        assert!(cache
            .get_match_at("match-a", now + Duration::from_secs(6 * 60 * 60 - 1))
            .is_some());
        assert!(cache
            .get_match_at("match-a", now + Duration::from_secs(6 * 60 * 60 + 1))
            .is_none());
    }

    #[test]
    fn cache_match_entries_are_bounded_to_512() {
        let cache = LivePartyHistoryCache::default();
        let now = Instant::now();
        for index in 0..513 {
            cache.put_match_at(
                &format!("match-{index}"),
                json!({ "match": index }),
                now + Duration::from_millis(index),
            );
        }

        assert!(cache
            .get_match_at("match-0", now + Duration::from_secs(1))
            .is_none());
        assert!(cache
            .get_match_at("match-512", now + Duration::from_secs(1))
            .is_some());
    }

    #[test]
    fn cache_history_entries_are_bounded_to_512() {
        let cache = LivePartyHistoryCache::default();
        let now = Instant::now();
        for index in 0..513 {
            cache.put_history_at(
                &format!("p{index}"),
                vec![format!("match-{index}")],
                now + Duration::from_millis(index),
            );
        }

        assert!(cache
            .get_history_at("p0", now + Duration::from_secs(1))
            .is_none());
        assert!(cache
            .get_history_at("p512", now + Duration::from_secs(1))
            .is_some());
    }

    #[test]
    fn cache_request_plan_contains_only_players_without_live_sources() {
        let presence = HashMap::from([("p1".into(), "live-a".into())]);
        let premade = HashSet::from(["p2".into()]);

        assert_eq!(
            unresolved_puuids(&roster(), &presence, &premade, Some("own-live-party")),
            vec!["p3".to_string(), "p4".to_string()]
        );
    }

    #[tokio::test]
    async fn cache_hung_riot_request_times_out_as_missing_evidence() {
        let result = riot_request_with_timeout(
            Duration::from_millis(10),
            std::future::pending::<Result<serde_json::Value, String>>(),
        )
        .await;

        assert!(result.is_none());
    }

    #[test]
    fn rate_limit_detection_handles_http_429_and_riot_1015_only() {
        assert!(is_rate_limited_error(
            r#"{"status":429,"message":"limited"}"#
        ));
        assert!(is_rate_limited_error("error code: 1015"));
        assert!(!is_rate_limited_error(r#"{"status":500}"#));
    }

    #[test]
    fn a_logged_endpoint_path_carries_no_player_ids() {
        let error = r#"{"status":429,"path":"/mmr/v1/players/1d4e93f0-8a5b-4c21-9f6e-0b7a5c3d2e14","message":"x"}"#;
        assert_eq!(error_path(error).as_deref(), Some("/mmr/v1/players/<id>"));

        let history = r#"{"status":429,"path":"/match-history/v1/history/1d4e93f08a5b4c219f6e0b7a5c3d2e14","message":"x"}"#;
        assert_eq!(
            error_path(history).as_deref(),
            Some("/match-history/v1/history/<id>")
        );
        // Short, non-hex segments are route names and stay readable.
        assert_eq!(
            error_path(r#"{"status":429,"path":"/name-service/v2/players"}"#).as_deref(),
            Some("/name-service/v2/players")
        );
        assert_eq!(error_path(r#"{"status":429}"#), None);
    }

    #[test]
    fn the_request_window_reports_and_resets_once_it_closes() {
        let now = Instant::now();
        let mut gate = RateGate::default();

        gate.account_for(Duration::from_millis(10), now);
        gate.account_for(Duration::from_millis(900), now + Duration::from_secs(30));
        assert_eq!(gate.window_requests, 2);
        assert_eq!(gate.window_longest_wait, Duration::from_millis(900));

        gate.account_for(Duration::ZERO, now + PD_LOG_WINDOW);
        assert_eq!(gate.window_requests, 0);
        assert_eq!(gate.window_longest_wait, Duration::ZERO);
        assert_eq!(gate.window_started, Some(now + PD_LOG_WINDOW));
    }

    #[test]
    fn rate_gate_doubles_the_cooldown_while_strikes_keep_coming() {
        let now = Instant::now();
        let mut gate = RateGate::default();

        gate.mark_rate_limited(now, None);
        assert!(!gate.is_cooling_down_at(now + Duration::from_secs(60)));

        // A second strike right after the first cooldown ends waits twice as long.
        let second = now + Duration::from_secs(61);
        gate.mark_rate_limited(second, None);
        assert!(gate.is_cooling_down_at(second + Duration::from_secs(119)));
        assert!(!gate.is_cooling_down_at(second + Duration::from_secs(120)));

        let third = second + Duration::from_secs(121);
        gate.mark_rate_limited(third, None);
        assert!(gate.is_cooling_down_at(third + Duration::from_secs(239)));
        assert!(!gate.is_cooling_down_at(third + Duration::from_secs(240)));
    }

    #[test]
    fn rate_gate_backoff_restarts_after_a_quiet_stretch() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        gate.mark_rate_limited(now, None);
        gate.mark_rate_limited(now + Duration::from_secs(61), None);

        let quiet = now + Duration::from_secs(61) + PD_RATE_LIMIT_RESET;
        gate.mark_rate_limited(quiet, None);

        assert!(gate.is_cooling_down_at(quiet + Duration::from_secs(59)));
        assert!(!gate.is_cooling_down_at(quiet + Duration::from_secs(60)));
    }

    #[test]
    fn rate_gate_never_waits_longer_than_the_ceiling() {
        let mut gate = RateGate::default();
        let mut now = Instant::now();
        for _ in 0..12 {
            gate.mark_rate_limited(now, None);
            now += Duration::from_secs(1);
        }

        // Twelve doublings of 60s is over 40 hours; the ceiling holds it to ten
        // minutes, measured from the last strike a second ago.
        assert_eq!(
            gate.cooldown_remaining_at(now).map(|left| left.as_secs()),
            Some(PD_RATE_LIMIT_MAX_COOLDOWN.as_secs() - 1)
        );
    }

    #[test]
    fn riot_own_retry_after_overrides_the_computed_cooldown() {
        assert_eq!(
            retry_after_hint(r#"{"status":429,"message":"limited","retryAfter":45}"#),
            Some(Duration::from_secs(45))
        );
        assert_eq!(retry_after_hint(r#"{"status":429,"retryAfter":null}"#), None);
        assert_eq!(retry_after_hint(r#"{"status":429}"#), None);
        // A hint longer than the ceiling is clamped rather than trusted outright.
        assert_eq!(
            retry_after_hint(r#"{"status":429,"retryAfter":86400}"#),
            Some(PD_RATE_LIMIT_MAX_COOLDOWN)
        );

        let now = Instant::now();
        let mut gate = RateGate::default();
        gate.mark_rate_limited(now, Some(Duration::from_secs(5)));
        assert!(gate.is_cooling_down_at(now + Duration::from_secs(4)));
        assert!(!gate.is_cooling_down_at(now + Duration::from_secs(6)));
    }

    #[test]
    fn rate_gate_spends_a_burst_then_settles_to_the_sustained_rate() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        let scheduled: Vec<Duration> = (0..60)
            .map(|_| gate.reserve_at(now).duration_since(now))
            .collect();

        // The burst runs at the spacing floor, so the roster fills promptly.
        assert_eq!(scheduled[0], Duration::ZERO);
        assert_eq!(scheduled[10], PD_REQUEST_SPACING * 10);
        // Once the burst credit is spent, the ceiling takes over.
        let tail = scheduled[59] - scheduled[58];
        assert_eq!(tail, PD_SUSTAINED_INTERVAL);
        assert!(scheduled[59] > PD_REQUEST_SPACING * 59);
    }

    #[test]
    fn a_cooldown_voids_everything_already_queued_behind_the_gate() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        for _ in 0..40 {
            gate.reserve_at(now);
        }
        gate.mark_rate_limited(now, None);

        let resumed = now + Duration::from_secs(61);
        assert_eq!(gate.reserve_at(resumed), resumed);
    }

    #[test]
    fn rate_gate_cools_down_for_sixty_seconds() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        gate.mark_rate_limited(now, None);

        assert!(gate.is_cooling_down_at(now + Duration::from_secs(59)));
        assert!(!gate.is_cooling_down_at(now + Duration::from_secs(60)));
    }

    #[tokio::test]
    async fn rate_gate_spaces_concurrent_request_starts() {
        let cache = LivePartyHistoryCache::default();
        let starts = Arc::new(Mutex::new(Vec::new()));
        let first_starts = starts.clone();
        let second_starts = starts.clone();

        let (first, second) = tokio::join!(
            cache.run_pd(async move {
                first_starts.lock().unwrap().push(Instant::now());
                Ok::<_, String>(())
            }),
            cache.run_pd(async move {
                second_starts.lock().unwrap().push(Instant::now());
                Ok::<_, String>(())
            })
        );

        assert!(first.is_ok());
        assert!(second.is_ok());
        let starts = starts.lock().unwrap();
        assert!(starts[1].duration_since(starts[0]) >= PD_REQUEST_SPACING);
    }

    #[tokio::test]
    async fn rate_gate_does_not_poll_queued_requests_during_cooldown() {
        let cache = LivePartyHistoryCache::default();
        assert_eq!(
            cache
                .run_pd(async { Err::<(), _>(r#"{"status":429}"#.to_string()) })
                .await,
            Err(RATE_LIMITED_ERROR.to_string())
        );
        let polled = Arc::new(AtomicBool::new(false));
        let request_polled = polled.clone();

        let result = cache
            .run_pd(async move {
                request_polled.store(true, Ordering::SeqCst);
                Ok::<_, String>(())
            })
            .await;

        assert_eq!(result, Err(RATE_LIMITED_ERROR.to_string()));
        assert!(!polled.load(Ordering::SeqCst));
    }

    #[test]
    fn raw_history_documents_are_cached_case_insensitively() {
        let cache = LivePartyHistoryCache::default();
        let now = Instant::now();
        cache.put_history_document_at("P1", json!({ "History": [{ "MatchID": "m1" }] }), now);

        assert_eq!(
            cache.get_history_document_at("p1", now + Duration::from_secs(29)),
            Some(json!({ "History": [{ "MatchID": "m1" }] }))
        );
        assert!(cache
            .get_history_document_at("p1", now + Duration::from_secs(31))
            .is_none());
    }

    #[test]
    fn continuity_labels_become_groups_without_solo_entries() {
        let labels = HashMap::from([
            ("p1".to_string(), "Team 1".to_string()),
            ("p2".to_string(), "Team 1".to_string()),
            ("p3".to_string(), "Team 2".to_string()),
        ]);

        assert_eq!(
            continuity_groups(&labels),
            vec![vec!["p1".to_string(), "p2".to_string()]]
        );
    }

    #[test]
    fn conflicting_live_parties_leave_missing_continuity_members_for_history() {
        let live = HashMap::from([
            ("p1".to_string(), "live:a".to_string()),
            ("p2".to_string(), "live:b".to_string()),
        ]);
        let groups = vec![vec![
            "p1".to_string(),
            "p2".to_string(),
            "p3".to_string(),
            "p4".to_string(),
        ]];

        assert!(continuity_resolved_members(&roster(), &live, &groups).is_empty());
    }
}
