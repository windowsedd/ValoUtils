//! Tauri command handlers, one module per feature.

use serde_json::{json, Value};

/// The `code` a command replies with when the request never left the machine
/// because the PD budget is spent, or when Riot itself refused it as a
/// throttle.
///
/// Live Game has answered with this marker since it grew its own cache. Every
/// other pd-backed screen passed the refusal straight through to `error`, so a
/// spent budget reached the user as the gate's raw JSON blob - a page cannot
/// render `{"status":429,...,"message":"held by the local pd rate gate"}` as
/// anything but noise, and it reads like a crash rather than a pause.
pub(crate) const RATE_LIMITED_CODE: &str = "rateLimited";

/// The reply for a throttled request, or `None` when the failure is something
/// else and the caller's own error arm should handle it.
///
/// `retryInSeconds` is what the gate knows about its own cooldown, so a page
/// can say when the data is coming back rather than only that it is missing.
pub(crate) async fn rate_limited_reply(error: &str) -> Option<Value> {
    if !crate::riot::rate_gate::is_rate_limited_error(error) {
        return None;
    }
    Some(json!({
        "success": false,
        "code": RATE_LIMITED_CODE,
        "retryInSeconds": crate::riot::rate_gate::cooldown_seconds().await,
    }))
}

pub mod app;
pub mod battlepass;
pub(crate) mod bot_template;
pub mod career;
pub mod chat;
pub mod display;
pub mod fake_player;
pub mod friend_profile;
pub mod friends;
pub mod inventory;
pub mod live;
pub mod logs;
pub(crate) mod live_party;
pub mod matches;
mod pregame_roster;
pub mod presence;
pub mod profiles;
pub(crate) mod rank_shields;
pub mod riot;
pub mod riot_chat;
pub mod riot_launch;
pub mod startup;
pub mod store;
pub mod tools;
