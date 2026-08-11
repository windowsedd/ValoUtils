# Current Immortal Leaderboard Rank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Friend Profile Current Rank as Immortal 1/2/3 or Radiant from the current regional Riot leaderboard RR thresholds.

**Architecture:** Add one authenticated leaderboard method to the Riot PD client. Keep JSON parsing, threshold validation, and rank resolution as pure functions in `friend_profile.rs`; add a five-minute in-memory cache around the network request and treat the result as optional enrichment when normalizing profiles.

**Tech Stack:** Rust, serde_json, reqwest, Tokio/Tauri commands, Cargo tests.

## Global Constraints

- Only Current Rank from `friend:profile:get` is corrected.
- Peak Rank and all non-Immortal raw tiers remain unchanged.
- Leaderboard failure must never fail the profile request.
- Successful thresholds are cached for five minutes by region and season ID; failures are not cached.
- No new dependency is added.

---

### Task 1: Define and test threshold parsing and tier resolution

**Files:**
- Modify: `src-tauri/src/commands/friend_profile.rs`

**Interfaces:**
- Produces: `LeaderboardThresholds { immortal_two: i64, immortal_three: i64, radiant: i64 }`
- Produces: `parse_leaderboard_thresholds(&Value) -> Option<LeaderboardThresholds>`
- Produces: `resolve_current_tier(raw_tier: i64, rr: i64, thresholds: Option<&LeaderboardThresholds>) -> i64`

- [ ] **Step 1: Write failing parser tests**

Use a fixture containing `tierDetails[25/26/27].rankedRatingThreshold` and `topTierRRThreshold`. Assert that Radiant uses `max(tier 27 threshold, topTierRRThreshold)`. Add malformed, negative, missing, and non-monotonic fixtures that return `None`.

- [ ] **Step 2: Write failing resolver tests**

With thresholds `90/200/450`, assert RR `89→24`, `90→25`, `200→26`, and `450→27`. Assert raw tier 23 remains 23 and missing thresholds preserve raw tiers 24–27.

- [ ] **Step 3: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::friend_profile::tests`

Expected: FAIL because the threshold type and resolver functions do not exist.

- [ ] **Step 4: Implement the pure parser and resolver**

Read non-negative integer thresholds from the exact leaderboard fields, validate `immortal_two <= immortal_three <= radiant`, and return the highest qualifying tier only for raw tiers 24 through 27.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::friend_profile::tests`

Expected: All Friend Profile Rust tests pass.

---

### Task 2: Add the authenticated Riot leaderboard request

**Files:**
- Modify: `src-tauri/src/riot/api.rs`
- Modify: `src-tauri/src/commands/friend_profile.rs`

**Interfaces:**
- Produces: `RiotApiClient::get_competitive_leaderboard(&self, season_id: &str) -> Result<Value, String>`
- Produces: `current_leaderboard_thresholds(api: &RiotApiClient, season_id: &str) -> Option<LeaderboardThresholds>`

- [ ] **Step 1: Add a failing API source-contract test**

Add or extend a unit test in `api.rs` that verifies the leaderboard path builder includes the client's region, URL-encoded season ID, `queue/competitive`, `startIndex=0`, and `size=1`.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml riot::api::tests`

Expected: FAIL because the leaderboard path builder does not exist.

- [ ] **Step 3: Implement the PD API method**

Build `/mmr/v1/leaderboards/affinity/{region}/queue/competitive/season/{encodedSeasonId}?startIndex=0&size=1` and send it through the existing authenticated `request(Target::Pd, GET, ...)` flow.

- [ ] **Step 4: Add five-minute successful-result caching**

Use `OnceLock<Mutex<HashMap<String, CachedLeaderboardThresholds>>>`, key it by lowercased `region:seasonId`, check elapsed time before the request, insert only successfully parsed responses, and never hold the mutex across `.await`.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml riot::api::tests` and then `cargo test --manifest-path src-tauri/Cargo.toml commands::friend_profile::tests`

Expected: API and resolver tests pass.

---

### Task 3: Enrich Friend Profile Current Rank without affecting Peak Rank

**Files:**
- Modify: `src-tauri/src/commands/friend_profile.rs`

**Interfaces:**
- Consumes: `current_leaderboard_thresholds`, `resolve_current_tier`, existing MMR normalization.
- Produces: Corrected `profile.currentTier` for Friend Profile and clickable match-player modal.

- [ ] **Step 1: Write the failing normalization test**

Pass a raw Immortal 1 MMR fixture with `117 RR` and thresholds `80/200/400` into profile normalization. Assert `currentTier == 25`, while the fixture's existing `peakTier` and `peakSeasonId` remain unchanged. Add a `None` threshold case that preserves raw tier 24.

- [ ] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::friend_profile::tests`

Expected: FAIL because normalization does not accept or apply leaderboard thresholds.

- [ ] **Step 3: Wire optional leaderboard enrichment into `friend_profile_get`**

After the existing parallel MMR/history requests finish, read the current season ID and raw tier. Fetch thresholds only for raw tiers 24–27 with a non-empty season ID. Pass the optional thresholds into normalization; ignore any leaderboard error.

- [ ] **Step 4: Verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::friend_profile::tests`

Expected: All Friend Profile tests pass and Peak Rank assertions remain unchanged.

---

### Task 4: Complete regression verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Completed backend enrichment.
- Produces: Rust, frontend, build, and patch-hygiene evidence.

- [ ] **Step 1: Run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: Zero failures.

- [ ] **Step 2: Run all Bun tests**

Run: `bun test`

Expected: Zero failures.

- [ ] **Step 3: Run the production frontend build**

Run: `bun run build:vite`

Expected: TypeScript and Vite build successfully; existing warnings may remain.

- [ ] **Step 4: Check patch scope**

Run: `git diff --check`

Expected: No whitespace errors and only the Riot API client, Friend Profile backend, focused tests, and approved docs are changed by this task.
