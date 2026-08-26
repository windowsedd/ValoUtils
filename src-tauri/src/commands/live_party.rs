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

pub(super) const RATE_LIMITED_ERROR: &str = "rateLimited";

fn is_rate_limited_error(error: &str) -> bool {
    error.contains("\"status\":429")
        || error.contains("\"status\": 429")
        || error.to_ascii_lowercase().contains("error code: 1015")
}

#[derive(Default)]
struct RateGate {
    next_allowed: Option<Instant>,
    cooldown_until: Option<Instant>,
}

impl RateGate {
    fn mark_rate_limited(&mut self, now: Instant) {
        self.cooldown_until = Some(now + PD_RATE_LIMIT_COOLDOWN);
    }

    fn is_cooling_down_at(&self, now: Instant) -> bool {
        self.cooldown_until.is_some_and(|until| now < until)
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
            let scheduled = gate.next_allowed.unwrap_or(now).max(now);
            gate.next_allowed = Some(scheduled + PD_REQUEST_SPACING);
            scheduled
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
                self.rate_gate
                    .lock()
                    .await
                    .mark_rate_limited(Instant::now());
                Err(RATE_LIMITED_ERROR.to_string())
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn is_cooling_down(&self) -> bool {
        self.rate_gate
            .lock()
            .await
            .is_cooling_down_at(Instant::now())
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

fn historical_groups_for_histories(
    histories: &HashMap<String, Vec<String>>,
    details_by_match: &HashMap<String, Value>,
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

    historical_groups_for_histories(&histories, &details_by_match)
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
            historical_groups_for_histories(&histories, &details),
            vec![vec!["p1".to_string(), "p2".to_string()]]
        );
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
    fn rate_gate_cools_down_for_sixty_seconds() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        gate.mark_rate_limited(now);

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
