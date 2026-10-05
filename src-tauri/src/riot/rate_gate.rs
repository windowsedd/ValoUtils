//! One process-wide budget for Riot's `pd` game API.
//!
//! Riot throttles per client, not per feature, so a budget that only one screen
//! respects is not a budget. This gate used to live inside the live-game party
//! cache, which meant the live poller paced itself while Matches, Friends,
//! Tools, Inventory and Store fired as fast as the network allowed - and the
//! 1015 that earned then stalled the live path, which had done nothing wrong.
//! It sits under `RiotApiClient::request` now, so every pd call is spent from
//! the same budget no matter which screen asked for it.
//!
//! Two limits shape the traffic, both carried on [`Pacing`]: `spacing` is a
//! floor between any two requests, and `sustained` with `burst` is a leaky
//! bucket on top, so a burst - the ten-player roster a scout table is waiting
//! on - stays snappy while a long run of twenty match documents settles to a
//! rate the endpoint tolerates. On a refusal everything stops for a cooldown
//! that doubles per consecutive strike.
//!
//! Which pacing applies is the user's choice, from Settings; the cooldowns are
//! not, since those answer a refusal Riot has already made.

use std::collections::BTreeMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

const PD_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(60);
/// Cloudflare 1015 escalates against a client that keeps coming back, so each
/// strike waits twice as long as the last one before anything is tried again.
const PD_RATE_LIMIT_MAX_COOLDOWN: Duration = Duration::from_secs(10 * 60);
/// A strike this long after the previous one is a fresh incident, and starts
/// the backoff over at the base cooldown.
const PD_RATE_LIMIT_RESET: Duration = Duration::from_secs(15 * 60);
/// How often the gate reports what it has been sending, so a throttle can be
/// read back against the volume that earned it rather than guessed at.
const PD_LOG_WINDOW: Duration = Duration::from_secs(60);
/// How long after a cooldown lifts the gate withholds the burst allowance.
///
/// A cooldown that ends straight into a full burst puts the ten roster MMR
/// reads that earned the 429 back on the wire within a couple of seconds, and
/// the logs show exactly that: resume, fresh strike ten to twenty seconds
/// later, sixteen times over. For this long after a resume every request is
/// paced at the sustained rate instead, so the first thing Riot sees once a
/// pause ends is a trickle rather than the burst it just refused.
const PD_RECOVERY_WINDOW: Duration = Duration::from_secs(30);

/// How hard the gate paces requests.
///
/// The cooldowns above are not part of this: those answer a refusal Riot has
/// already made, and no preference should be able to shorten them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Pacing {
    /// A floor between any two requests, whatever else is going on.
    spacing: Duration,
    /// The sustained ceiling, applied on top of the spacing floor.
    ///
    /// Spacing alone allows a fixed rate forever, which is what scouting ten
    /// cold players sustains for a full minute. These two shape that into a
    /// burst that stays snappy - the roster names and ranks the table is
    /// waiting on - settling to a rate the endpoint tolerates once the burst
    /// credit is spent.
    sustained: Duration,
    /// How many requests may go out at the spacing floor before the ceiling
    /// starts holding them back.
    burst: u32,
}

// Riot has refused at roughly 165 requests in 45 seconds, during a cold
// 12-player scout that was also re-reading ranks and histories every poll.
// Those repeats are gone; Balanced and Safe also sit well under that rate.

/// For a machine Riot has never complained to: quick pages, less headroom.
/// 240 a minute sustained.
const PACING_FAST: Pacing = Pacing {
    spacing: Duration::from_millis(120),
    sustained: Duration::from_millis(250),
    burst: 30,
};

/// The default. 100 a minute sustained.
const PACING_BALANCED: Pacing = Pacing {
    spacing: Duration::from_millis(250),
    sustained: Duration::from_millis(600),
    burst: 15,
};

/// For someone who keeps getting throttled anyway: 60 a minute, and a burst
/// small enough that one busy page cannot spend the whole allowance.
const PACING_SAFE: Pacing = Pacing {
    spacing: Duration::from_millis(400),
    sustained: Duration::from_millis(1000),
    burst: 8,
};

/// Reads the `riotRequestPacing` config value. Anything unrecognised - a key
/// that was never set, or one written by a newer build - is the default.
pub fn pacing_for(id: &str) -> Pacing {
    match id.trim().to_ascii_lowercase().as_str() {
        "fast" => PACING_FAST,
        "safe" => PACING_SAFE,
        _ => PACING_BALANCED,
    }
}

fn pacing_slot() -> &'static RwLock<Pacing> {
    static PACING: OnceLock<RwLock<Pacing>> = OnceLock::new();
    PACING.get_or_init(|| RwLock::new(PACING_BALANCED))
}

/// Applies a pacing preference, from startup or from the Settings screen.
///
/// It takes effect on the next request rather than retiming the ones already
/// waiting: those have slots reserved under the old setting, and moving them
/// would let a switch to a faster preset release a burst all at once.
pub fn set_pacing(id: &str) {
    let pacing = pacing_for(id);
    if let Ok(mut slot) = pacing_slot().write() {
        if *slot != pacing {
            log::info!(
                "PD pacing set to {id}: {}ms floor, {}ms sustained, burst {}",
                pacing.spacing.as_millis(),
                pacing.sustained.as_millis(),
                pacing.burst
            );
        }
        *slot = pacing;
    }
}

/// The preference, stripped of its burst, for the window after a cooldown.
///
/// Burst credit is what makes a cold roster fill promptly; it is also what
/// spends a freshly restored allowance in two seconds. During recovery the
/// spacing floor is raised to the sustained interval and the burst is one, so
/// requests leave at a flat rate with nothing banked.
fn recovery_pacing(pacing: Pacing) -> Pacing {
    Pacing {
        spacing: pacing.sustained,
        sustained: pacing.sustained,
        burst: 1,
    }
}

fn current_pacing() -> Pacing {
    pacing_slot()
        .read()
        .map(|slot| *slot)
        .unwrap_or(PACING_BALANCED)
}

/// What a caller gets while the gate is cooling down: no request is sent.
///
/// It is shaped like a Riot refusal so that [`is_rate_limited_error`] and every
/// existing 429 arm recognise it, and it never reaches [`note_failure`] -
/// nothing went out, so there is nothing to strike for.
pub const LOCAL_COOLDOWN_ERROR: &str =
    r#"{"status":429,"path":"<local>","message":"held by the local pd rate gate","retryAfter":null}"#;

pub fn is_rate_limited_error(error: &str) -> bool {
    error.contains("\"status\":429")
        || error.contains("\"status\": 429")
        || error.to_ascii_lowercase().contains("error code: 1015")
}

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
    Some(redact_path(path))
}

/// A request path with its ids replaced and its query dropped, so the same
/// endpoint groups together and no PUUID or match id reaches the log file.
fn redact_path(path: &str) -> String {
    let path = path.split('?').next().unwrap_or(path);
    let redacted: Vec<&str> = path
        .split('/')
        .map(|segment| if looks_like_id(segment) { "<id>" } else { segment })
        .collect();
    redacted.join("/")
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
    /// While set and in the future, requests are paced without burst credit.
    recovery_until: Option<Instant>,
    /// Virtual arrival time of the next request under the sustained ceiling.
    /// Anything scheduled before it, less the burst tolerance, is free.
    theoretical_arrival: Option<Instant>,
    /// Rolling accounting, reported once per `PD_LOG_WINDOW`.
    window_started: Option<Instant>,
    window_requests: u32,
    window_longest_wait: Duration,
    /// The endpoint that waited longest this window.
    window_longest_endpoint: String,
    /// Requests this window per redacted endpoint.
    window_endpoints: BTreeMap<String, u32>,
}

impl RateGate {
    /// Records a throttle and returns how long nothing may be sent for.
    fn mark_rate_limited(&mut self, now: Instant, hint: Option<Duration>) -> Duration {
        // Live Game still polls GLZ every ~5s during a pause. Counting those
        // as fresh strikes restarts a doubled cooldown and turns a brief
        // throttle into a ten-minute lockout.
        if self.is_cooling_down_at(now) {
            if let Some(hint) = hint {
                let proposed = now + hint;
                if self.cooldown_until.is_some_and(|until| proposed > until) {
                    self.cooldown_until = Some(proposed);
                    self.cooldown_len = hint;
                }
            }
            return self.cooldown_remaining_at(now).unwrap_or(self.cooldown_len);
        }

        let consecutive = self
            .last_strike
            .is_some_and(|last| now.duration_since(last) < PD_RATE_LIMIT_RESET);
        self.strikes = if consecutive { self.strikes + 1 } else { 1 };
        self.last_strike = Some(now);

        // Riot's own number sets the base where it sent one, and the ladder
        // doubles from there. Taking the hint verbatim let a client that kept
        // earning 429s sit at the same wait forever: Riot repeated
        // `Retry-After: 60` through sixteen consecutive strikes, so the backoff
        // only began to climb once the header stopped coming.
        let base = hint.unwrap_or(PD_RATE_LIMIT_COOLDOWN);
        let cooldown = base
            .saturating_mul(1u32 << (self.strikes - 1).min(8))
            .min(PD_RATE_LIMIT_MAX_COOLDOWN);
        self.cooldown_until = Some(now + cooldown);
        self.cooldown_len = cooldown;
        // Anything queued behind the spacing floor is void: the whole point of
        // a cooldown is that nothing goes out during it.
        self.next_allowed = None;
        self.theoretical_arrival = None;
        self.recovery_until = None;
        cooldown
    }

    fn is_cooling_down_at(&self, now: Instant) -> bool {
        self.cooldown_until.is_some_and(|until| now < until)
    }

    /// Whether the window after a resume is still running. Expiry is cleared
    /// here rather than left behind, so a later strike reads a clean slate.
    fn is_recovering_at(&mut self, now: Instant) -> bool {
        match self.recovery_until {
            Some(until) if now < until => true,
            Some(_) => {
                self.recovery_until = None;
                false
            }
            None => false,
        }
    }

    fn cooldown_remaining_at(&self, now: Instant) -> Option<Duration> {
        self.cooldown_until
            .filter(|until| now < *until)
            .map(|until| until.duration_since(now))
    }

    /// When the next request may start: no sooner than the spacing floor, and
    /// no sooner than the sustained ceiling allows once the burst is spent.
    fn reserve_at(&mut self, now: Instant, pacing: Pacing, endpoint: &str) -> Instant {
        if self.cooldown_until.is_some_and(|until| now >= until) {
            self.cooldown_until = None;
            self.recovery_until = Some(now + PD_RECOVERY_WINDOW);
            log::info!(
                "PD requests resuming after a {}s pause (strike {}); no burst for {}s",
                self.cooldown_len.as_secs(),
                self.strikes,
                PD_RECOVERY_WINDOW.as_secs()
            );
        }
        let pacing = if self.is_recovering_at(now) {
            recovery_pacing(pacing)
        } else {
            pacing
        };
        let spaced = self.next_allowed.unwrap_or(now).max(now);
        let arrival = self.theoretical_arrival.unwrap_or(now).max(now);
        let burst = pacing.sustained * pacing.burst.saturating_sub(1);
        let sustained = arrival.checked_sub(burst).unwrap_or(now);

        let scheduled = spaced.max(sustained).max(now);
        self.next_allowed = Some(scheduled + pacing.spacing);
        self.theoretical_arrival = Some(arrival + pacing.sustained);
        self.account_for(scheduled.duration_since(now), now, endpoint);
        scheduled
    }

    /// Counts a scheduled request, reporting the window once it closes. The
    /// longest wait says how hard the ceiling is shaping: near zero means the
    /// budget is untouched, seconds mean requests are queueing behind it.
    ///
    /// The window is reported by the first request after it closes, not on a
    /// timer, so while the app is quiet a window can span several minutes.
    fn account_for(&mut self, wait: Duration, now: Instant, endpoint: &str) {
        let started = *self.window_started.get_or_insert(now);
        let endpoint = redact_path(endpoint);
        self.window_requests += 1;
        if wait >= self.window_longest_wait {
            self.window_longest_wait = wait;
            self.window_longest_endpoint = endpoint.clone();
        }
        *self.window_endpoints.entry(endpoint).or_default() += 1;

        let elapsed = now.duration_since(started);
        if elapsed < PD_LOG_WINDOW {
            return;
        }
        log::info!("{}", self.window_summary(elapsed));
        self.window_started = Some(now);
        self.window_requests = 0;
        self.window_longest_wait = Duration::ZERO;
        self.window_longest_endpoint.clear();
        self.window_endpoints.clear();
    }

    /// One line naming the volume, the worst wait and what was asked for,
    /// busiest endpoint first.
    fn window_summary(&self, elapsed: Duration) -> String {
        let mut endpoints: Vec<(&String, &u32)> = self.window_endpoints.iter().collect();
        endpoints.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        let breakdown = endpoints
            .iter()
            .map(|(endpoint, count)| format!("{endpoint} x{count}"))
            .collect::<Vec<_>>()
            .join(", ");
        let longest = if self.window_longest_wait.is_zero() || self.window_longest_endpoint.is_empty() {
            String::new()
        } else {
            format!(" ({})", self.window_longest_endpoint)
        };
        format!(
            "PD budget: {} requests in {}s, longest wait {}ms{longest}; {breakdown}",
            self.window_requests,
            elapsed.as_secs(),
            self.window_longest_wait.as_millis()
        )
    }
}

fn gate() -> &'static AsyncMutex<RateGate> {
    static GATE: OnceLock<AsyncMutex<RateGate>> = OnceLock::new();
    GATE.get_or_init(|| AsyncMutex::new(RateGate::default()))
}

/// Waits for this request's slot in the budget.
///
/// Returns [`LOCAL_COOLDOWN_ERROR`] instead of waiting when the gate is cooling
/// down. Failing fast matters more than queueing here: a poller that waits out
/// a ten-minute cooldown delivers a stale answer ten minutes late, where an
/// immediate refusal lets the caller fall back to its cache and say so.
///
/// `endpoint` is the request path, kept only for the budget's log summary.
pub async fn acquire(endpoint: &str) -> Result<(), String> {
    acquire_on(gate(), endpoint).await
}

/// The body of [`acquire`], against a caller-supplied gate so that tests can
/// exercise the pacing without sharing the process-wide one.
async fn acquire_on(gate: &AsyncMutex<RateGate>, endpoint: &str) -> Result<(), String> {
    let pacing = current_pacing();
    let scheduled = {
        let mut locked = gate.lock().await;
        let now = Instant::now();
        if locked.is_cooling_down_at(now) {
            return Err(LOCAL_COOLDOWN_ERROR.to_string());
        }
        locked.reserve_at(now, pacing, endpoint)
    };

    // The lock is not held across the wait: other callers must be able to
    // reserve their own slots while this one sits on its.
    tokio::time::sleep_until(tokio::time::Instant::from_std(scheduled)).await;
    if gate.lock().await.is_cooling_down_at(Instant::now()) {
        return Err(LOCAL_COOLDOWN_ERROR.to_string());
    }
    Ok(())
}

/// Records a failed request, striking the gate if Riot refused it as a throttle.
pub async fn note_failure(error: &str) {
    note_failure_on(gate(), error).await;
}

async fn note_failure_on(gate: &AsyncMutex<RateGate>, error: &str) {
    if !is_rate_limited_error(error) {
        return;
    }
    let hint = retry_after_hint(error);
    let mut locked = gate.lock().await;
    let cooldown = locked.mark_rate_limited(Instant::now(), hint);
    log::warn!(
        "Riot throttled {} (strike {}); holding PD requests for {}s{}",
        error_path(error).unwrap_or_else(|| "a PD endpoint".to_string()),
        locked.strikes,
        cooldown.as_secs(),
        match hint {
            // The hint is the base the ladder doubles from, so past the first
            // strike the wait is longer than the number Riot sent.
            Some(hint) => format!(", from a {}s Retry-After", hint.as_secs()),
            None => String::new(),
        }
    );
}

/// Seconds until requests are worth trying again, so a caller can say when data
/// is coming back rather than only that it is missing.
pub async fn cooldown_seconds() -> Option<u64> {
    gate()
        .lock()
        .await
        .cooldown_remaining_at(Instant::now())
        .map(|remaining| remaining.as_secs().max(1))
}

/// How long a GLZ refusal holds GLZ reads when Riot sent no `Retry-After`.
///
/// Pregame is polled every few seconds. A short hold skips those ticks. It does
/// not enter the PD doubling ladder: a pregame 429 must not freeze names, ranks,
/// and the other screens that spend the PD budget.
const GLZ_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(15);

/// What a GLZ caller gets while that host is cooling down. No request is sent.
///
/// Shaped like a Riot refusal so existing 429 arms recognise it. It never
/// reaches [`note_failure`]: nothing went out, and a GLZ pause is not a PD strike.
pub const GLZ_LOCAL_COOLDOWN_ERROR: &str =
    r#"{"status":429,"path":"<local-glz>","message":"held by the local glz rate gate","retryAfter":null}"#;

#[derive(Default)]
struct GlzGate {
    cooldown_until: Option<Instant>,
}

impl GlzGate {
    fn mark_rate_limited(&mut self, now: Instant, hint: Option<Duration>) -> Duration {
        let cooldown = hint.unwrap_or(GLZ_RATE_LIMIT_COOLDOWN);
        if let Some(until) = self.cooldown_until.filter(|until| now < *until) {
            if let Some(hint) = hint {
                let proposed = now + hint;
                if proposed > until {
                    self.cooldown_until = Some(proposed);
                    return hint;
                }
            }
            return until.duration_since(now);
        }
        self.cooldown_until = Some(now + cooldown);
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
}

fn glz_gate() -> &'static AsyncMutex<GlzGate> {
    static GLZ: OnceLock<AsyncMutex<GlzGate>> = OnceLock::new();
    GLZ.get_or_init(|| AsyncMutex::new(GlzGate::default()))
}

/// Refuses immediately while GLZ is cooling down. GLZ is not paced: the live
/// poll wants a fast session read, and the hold only starts after a refusal.
pub async fn acquire_glz() -> Result<(), String> {
    acquire_glz_on(glz_gate()).await
}

async fn acquire_glz_on(gate: &AsyncMutex<GlzGate>) -> Result<(), String> {
    if gate.lock().await.is_cooling_down_at(Instant::now()) {
        return Err(GLZ_LOCAL_COOLDOWN_ERROR.to_string());
    }
    Ok(())
}

/// Records a GLZ refusal on the GLZ gate only. A PD caller is not struck.
pub async fn note_glz_failure(error: &str) {
    note_glz_failure_on(glz_gate(), error).await;
}

async fn note_glz_failure_on(gate: &AsyncMutex<GlzGate>, error: &str) {
    if !is_rate_limited_error(error) || error.contains("<local") {
        return;
    }
    let hint = retry_after_hint(error);
    let mut locked = gate.lock().await;
    let cooldown = locked.mark_rate_limited(Instant::now(), hint);
    log::warn!(
        "Riot throttled GLZ {} ; holding GLZ requests for {}s{}",
        error_path(error).unwrap_or_else(|| "a GLZ endpoint".to_string()),
        cooldown.as_secs(),
        if hint.is_some() {
            ", as asked by Retry-After"
        } else {
            ""
        }
    );
}

/// Seconds until a GLZ read is worth trying again.
pub async fn glz_cooldown_seconds() -> Option<u64> {
    glz_gate()
        .lock()
        .await
        .cooldown_remaining_at(Instant::now())
        .map(|remaining| remaining.as_secs().max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_detection_handles_http_429_and_riot_1015_only() {
        assert!(is_rate_limited_error(
            r#"{"status":429,"message":"limited"}"#
        ));
        assert!(is_rate_limited_error("error code: 1015"));
        assert!(!is_rate_limited_error(r#"{"status":500}"#));
    }

    #[test]
    fn the_local_cooldown_refusal_reads_as_a_throttle_to_every_caller() {
        assert!(is_rate_limited_error(LOCAL_COOLDOWN_ERROR));
        // It must carry no Retry-After of its own: the cooldown that produced
        // it is already running, and a hint here would restart it.
        assert_eq!(retry_after_hint(LOCAL_COOLDOWN_ERROR), None);
    }

    #[test]
    fn the_budget_summary_names_endpoints_without_ids() {
        let mut gate = RateGate::default();
        let now = Instant::now();
        let puuid = "1d4e93f0-8a5b-4c21-9f6e-0b7a5c3d2e14";
        gate.account_for(Duration::ZERO, now, &format!("/mmr/v1/players/{puuid}"));
        gate.account_for(
            Duration::from_millis(340),
            now,
            &format!("/match-history/v1/history/{puuid}?startIndex=0&endIndex=20"),
        );
        gate.account_for(Duration::from_millis(200), now, "/mmr/v1/players/0b7a5c3d2e141d4e93f08a5b4c219f6e");

        let line = gate.window_summary(Duration::from_secs(223));
        assert_eq!(
            line,
            "PD budget: 3 requests in 223s, longest wait 340ms (/match-history/v1/history/<id>); /mmr/v1/players/<id> x2, /match-history/v1/history/<id> x1"
        );
        assert!(!line.contains(puuid));
        assert!(!line.contains("startIndex"));
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

        gate.account_for(Duration::from_millis(10), now, "/test");
        gate.account_for(Duration::from_millis(900), now + Duration::from_secs(30), "/test");
        assert_eq!(gate.window_requests, 2);
        assert_eq!(gate.window_longest_wait, Duration::from_millis(900));

        gate.account_for(Duration::ZERO, now + PD_LOG_WINDOW, "/test");
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
            now += gate.cooldown_len + Duration::from_secs(1);
        }
        gate.mark_rate_limited(now, None);

        // Twelve doublings of 60s is over 40 hours; the ceiling holds it to ten
        // minutes, measured from this last strike.
        assert_eq!(
            gate.cooldown_remaining_at(now).map(|left| left.as_secs()),
            Some(PD_RATE_LIMIT_MAX_COOLDOWN.as_secs())
        );
    }

    #[test]
    fn riot_own_retry_after_sets_the_first_cooldown() {
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
    fn a_repeated_retry_after_still_escalates() {
        // Riot answered sixteen consecutive strikes with the same
        // `Retry-After: 60`. Honouring it verbatim pinned every one of them to
        // a minute, so the client came back on the same schedule sixteen times
        // and the ladder never left the bottom rung. The hint is the base now.
        let mut gate = RateGate::default();
        let mut now = Instant::now();
        let minute = Some(Duration::from_secs(60));

        for expected in [60u64, 120, 240, 480] {
            gate.mark_rate_limited(now, minute);
            assert_eq!(
                gate.cooldown_remaining_at(now).map(|left| left.as_secs()),
                Some(expected)
            );
            now += gate.cooldown_len + Duration::from_secs(1);
        }

        // A short hint escalates from its own number rather than from a minute,
        // so a mild throttle stays mild.
        let mut brief = RateGate::default();
        let start = Instant::now();
        brief.mark_rate_limited(start, Some(Duration::from_secs(5)));
        let second = start + Duration::from_secs(6);
        brief.mark_rate_limited(second, Some(Duration::from_secs(5)));
        assert_eq!(
            brief.cooldown_remaining_at(second).map(|left| left.as_secs()),
            Some(10)
        );
    }

    #[test]
    fn the_window_after_a_resume_spends_no_burst() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        gate.mark_rate_limited(now, None);

        // The first request after the pause goes out at once; the rest trickle
        // at the sustained rate instead of emptying the burst into the endpoint
        // that just refused them.
        let resumed = now + Duration::from_secs(61);
        let scheduled: Vec<Duration> = (0..5)
            .map(|_| gate.reserve_at(resumed, PACING_BALANCED, "/test").duration_since(resumed))
            .collect();
        assert_eq!(scheduled[0], Duration::ZERO);
        assert_eq!(scheduled[1], PACING_BALANCED.sustained);
        assert_eq!(scheduled[4], PACING_BALANCED.sustained * 4);

        // Once the window closes the burst is available again, so an ordinary
        // page does not pay for a throttle that has long since passed.
        let recovered = resumed + PD_RECOVERY_WINDOW;
        assert_eq!(gate.reserve_at(recovered, PACING_BALANCED, "/test"), recovered);
        assert_eq!(
            gate.reserve_at(recovered, PACING_BALANCED, "/test")
                .duration_since(recovered),
            PACING_BALANCED.spacing
        );
        assert_eq!(gate.recovery_until, None);
    }

    #[test]
    fn rate_gate_spends_a_burst_then_settles_to_the_sustained_rate() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        let scheduled: Vec<Duration> = (0..60)
            .map(|_| gate.reserve_at(now, PACING_BALANCED, "/test").duration_since(now))
            .collect();

        // The burst runs at the spacing floor, so the roster fills promptly.
        assert_eq!(scheduled[0], Duration::ZERO);
        assert_eq!(scheduled[10], PACING_BALANCED.spacing * 10);
        // Once the burst credit is spent, the ceiling takes over.
        let tail = scheduled[59] - scheduled[58];
        assert_eq!(tail, PACING_BALANCED.sustained);
        assert!(scheduled[59] > PACING_BALANCED.spacing * 59);
    }

    #[test]
    fn a_cooldown_voids_everything_already_queued_behind_the_gate() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        for _ in 0..40 {
            gate.reserve_at(now, PACING_BALANCED, "/test");
        }
        gate.mark_rate_limited(now, None);

        let resumed = now + Duration::from_secs(61);
        assert_eq!(gate.reserve_at(resumed, PACING_BALANCED, "/test"), resumed);
    }

    #[test]
    fn rate_gate_cools_down_for_sixty_seconds() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        gate.mark_rate_limited(now, None);

        assert!(gate.is_cooling_down_at(now + Duration::from_secs(59)));
        assert!(!gate.is_cooling_down_at(now + Duration::from_secs(60)));
    }

    #[test]
    fn a_strike_during_an_active_cooldown_does_not_lengthen_it() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        gate.mark_rate_limited(now, None);
        assert_eq!(gate.strikes, 1);

        // Live Game still polls GLZ every ~5s while PD is paused. Those 429s
        // must not restart a doubled cooldown or a brief throttle becomes
        // a ten-minute lockout.
        gate.mark_rate_limited(now + Duration::from_secs(5), None);
        gate.mark_rate_limited(now + Duration::from_secs(10), None);
        assert_eq!(gate.strikes, 1);
        assert!(gate.is_cooling_down_at(now + Duration::from_secs(59)));
        assert!(!gate.is_cooling_down_at(now + Duration::from_secs(60)));
    }

    #[test]
    fn a_longer_retry_after_during_cooldown_can_extend_it() {
        let now = Instant::now();
        let mut gate = RateGate::default();
        gate.mark_rate_limited(now, Some(Duration::from_secs(30)));
        gate.mark_rate_limited(now + Duration::from_secs(5), Some(Duration::from_secs(90)));
        assert_eq!(gate.strikes, 1);
        assert!(gate.is_cooling_down_at(now + Duration::from_secs(94)));
        assert!(!gate.is_cooling_down_at(now + Duration::from_secs(96)));
    }

    #[tokio::test]
    async fn concurrent_callers_are_spaced_apart() {
        let gate = AsyncMutex::new(RateGate::default());
        let started = Instant::now();

        let (first, second) = tokio::join!(acquire_on(&gate, "/test"), acquire_on(&gate, "/test"));

        assert!(first.is_ok());
        assert!(second.is_ok());
        // Two callers that arrived together left one spacing interval apart:
        // the second waited out the slot the first reserved.
        assert!(Instant::now().duration_since(started) >= current_pacing().spacing);
    }

    #[tokio::test]
    async fn a_cooldown_refuses_callers_rather_than_queueing_them() {
        let gate = AsyncMutex::new(RateGate::default());
        note_failure_on(&gate, r#"{"status":429}"#).await;

        assert_eq!(
            acquire_on(&gate, "/test").await,
            Err(LOCAL_COOLDOWN_ERROR.to_string())
        );
    }

    #[test]
    fn each_preset_is_slower_than_the_one_above_it() {
        // Read through pacing_for so the names the Settings screen sends are
        // what gets ordered, not three constants compared to themselves.
        let presets = ["fast", "balanced", "safe"].map(pacing_for);

        for pair in presets.windows(2) {
            let (quicker, slower) = (pair[0], pair[1]);
            assert!(quicker.spacing < slower.spacing);
            assert!(quicker.sustained < slower.sustained);
            assert!(quicker.burst > slower.burst);
        }
    }

    #[test]
    fn an_unset_or_unknown_preference_is_the_default() {
        // An empty key is a config that has never been written; an unknown one
        // is a value a newer build saved. Neither may leave pacing undefined.
        assert_eq!(pacing_for(""), PACING_BALANCED);
        assert_eq!(pacing_for("turbo"), PACING_BALANCED);
        assert_eq!(pacing_for("  BALANCED  "), PACING_BALANCED);
    }

    #[test]
    fn a_slower_preset_schedules_a_burst_further_apart() {
        let now = Instant::now();
        let mut fast = RateGate::default();
        let mut safe = RateGate::default();
        for _ in 0..5 {
            fast.reserve_at(now, PACING_FAST, "/test");
            safe.reserve_at(now, PACING_SAFE, "/test");
        }

        assert!(safe.reserve_at(now, PACING_SAFE, "/test") > fast.reserve_at(now, PACING_FAST, "/test"));
    }

    #[tokio::test]
    async fn an_ordinary_failure_does_not_strike_the_gate() {
        let gate = AsyncMutex::new(RateGate::default());
        note_failure_on(&gate, r#"{"status":404,"message":"no such match"}"#).await;

        assert!(acquire_on(&gate, "/test").await.is_ok());
    }

    #[test]
    fn a_glz_throttle_cools_down_for_fifteen_seconds_without_doubling() {
        let now = Instant::now();
        let mut gate = GlzGate::default();

        gate.mark_rate_limited(now, None);
        assert!(gate.is_cooling_down_at(now + Duration::from_secs(14)));
        assert!(!gate.is_cooling_down_at(now + Duration::from_secs(15)));

        let second = now + Duration::from_secs(16);
        gate.mark_rate_limited(second, None);
        assert!(gate.is_cooling_down_at(second + Duration::from_secs(14)));
        assert!(!gate.is_cooling_down_at(second + Duration::from_secs(15)));
    }

    #[test]
    fn a_glz_retry_after_overrides_the_default_cooldown() {
        let now = Instant::now();
        let mut gate = GlzGate::default();
        gate.mark_rate_limited(now, Some(Duration::from_secs(8)));
        assert!(gate.is_cooling_down_at(now + Duration::from_secs(7)));
        assert!(!gate.is_cooling_down_at(now + Duration::from_secs(9)));
    }

    #[tokio::test]
    async fn a_glz_429_does_not_strike_the_pd_gate() {
        let pd = AsyncMutex::new(RateGate::default());
        let glz = AsyncMutex::new(GlzGate::default());
        note_glz_failure_on(&glz, r#"{"status":429,"path":"/pregame/v1/players/<id>"}"#).await;

        assert!(acquire_on(&pd, "/test").await.is_ok());
        assert_eq!(
            acquire_glz_on(&glz).await,
            Err(GLZ_LOCAL_COOLDOWN_ERROR.to_string())
        );
    }

    #[tokio::test]
    async fn a_pd_429_still_strikes_the_pd_gate() {
        let pd = AsyncMutex::new(RateGate::default());
        let glz = AsyncMutex::new(GlzGate::default());
        note_failure_on(&pd, r#"{"status":429,"path":"/mmr/v1/players/<id>"}"#).await;

        assert_eq!(
            acquire_on(&pd, "/test").await,
            Err(LOCAL_COOLDOWN_ERROR.to_string())
        );
        assert!(acquire_glz_on(&glz).await.is_ok());
    }
}
