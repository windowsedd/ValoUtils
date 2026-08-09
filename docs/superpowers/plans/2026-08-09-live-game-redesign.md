# Live Game Scouting Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Live Game roster with a dense, expandable scouting table backed by match context and each player's last five competitive-match statistics.

**Architecture:** Keep `live-game:fetch` as the fast roster snapshot. Add normalized match/team metadata to that response, then add `live-game:stats` as a bounded progressive enrichment command that emits one `live-game:player-stats` event per player. Split the React page into a data coordinator, asset hook, state panel, and scouting table so polling and display logic remain independent.

**Tech Stack:** Rust, Tauri 2, Tokio, serde_json, React 19, TypeScript, Tailwind CSS, react-i18next

## Global Constraints

- Recent performance uses the last five completed matches whose history `QueueID` equals `competitive`.
- Keep the existing five-second live-state poll and show the roster before recent statistics finish.
- Limit recent-stat work to three concurrent players; each worker fetches its five match details in sequence.
- Ignore progressive events whose `rosterKey` does not match the current snapshot.
- Preserve readable text when Riot fields or valorant-api.com assets are missing.
- Keep page-level horizontal scrolling disabled and preserve keyboard row expansion.
- Preserve unrelated edits in the shared dirty worktree. Stage or commit only changes whose ownership is unambiguous.

---

## File map

- Modify `src-tauri/src/commands/live.rs`: snapshot normalization, recent-stat cache, aggregation, progressive command, and Rust tests.
- Modify `src-tauri/src/riot/api.rs`: make `RiotApiClient` clonable for bounded Tokio workers.
- Modify `src-tauri/src/lib.rs`: manage `LiveStatsCache` and register `live_game_stats`.
- Modify `src/types/live-game.ts`: snapshot, match, team, and progressive-stat contracts.
- Create `src/components/live-game/use-live-game-assets.ts`: cached agent, rank, map, card, and skin resolution.
- Create `src/components/live-game/live-game-state-panel.tsx`: loading, idle, login, and error surfaces.
- Create `src/components/live-game/live-scout-table.tsx`: match bar, summaries, rows, responsive columns, and expanded details.
- Modify `src/pages/LiveGame.tsx`: polling coordinator and progressive-stat state.
- Modify `src/i18n/locales/en.json`, `ko.json`, and `zh-TW.json`: new labels and error copy.

---

### Task 1: Normalize match context and team summaries

**Files:**
- Modify: `src-tauri/src/commands/live.rs`
- Test: `src-tauri/src/commands/live.rs` inline `#[cfg(test)]` module

**Interfaces:**
- Produces: `extract_match_context(state: LiveState, source: &Value, match_id: Option<&str>) -> Value`
- Produces: `summarize_teams(players: &[Value]) -> Vec<Value>`
- Extends the successful `live_game_fetch` payload with `rosterKey`, `match`, and `teams`.

- [ ] **Step 1: Write failing context and team-summary tests**

```rust
#[test]
fn extracts_coregame_match_context() {
    let source = json!({
        "MapID": "/Game/Maps/Ascent/Ascent",
        "ModeID": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C",
        "QueueID": "competitive"
    });
    assert_eq!(extract_match_context(LiveState::CoreGame, &source, Some("match-1")), json!({
        "id": "match-1",
        "mapId": "/Game/Maps/Ascent/Ascent",
        "modeId": "/Game/GameModes/Bomb/BombGameMode.BombGameMode_C",
        "queueId": "competitive",
        "phase": "coregame"
    }));
}

#[test]
fn summarizes_only_rated_players() {
    let players = vec![
        json!({"teamId":"Blue","currentTier":15}),
        json!({"teamId":"Blue","currentTier":0}),
        json!({"teamId":"Blue","currentTier":17}),
    ];
    assert_eq!(summarize_teams(&players), vec![json!({
        "id":"Blue", "averageTier":16.0, "ratedPlayers":2
    })]);
}
```

- [ ] **Step 2: Run the tests and confirm the missing helpers fail**

Run: `cargo test commands::live::tests::extracts_coregame_match_context commands::live::tests::summarizes_only_rated_players --lib`

Expected: compile failure because both helpers are undefined. If Cargo accepts one filter only, run each fully qualified test separately.

- [ ] **Step 3: Implement the pure normalizers**

```rust
fn extract_match_context(state: LiveState, source: &Value, match_id: Option<&str>) -> Value {
    let string = |keys: &[&str]| keys.iter().find_map(|key| source.get(*key).and_then(Value::as_str));
    json!({
        "id": match_id,
        "mapId": string(&["MapID", "MapId"]),
        "modeId": string(&["ModeID", "ModeId", "GameMode"]),
        "queueId": string(&["QueueID", "QueueId"]).unwrap_or_default(),
        "phase": state.as_str(),
    })
}

fn summarize_teams(players: &[Value]) -> Vec<Value> {
    let mut teams: HashMap<String, (u64, u64)> = HashMap::new();
    for player in players {
        let Some(team) = player.get("teamId").and_then(Value::as_str) else { continue };
        let tier = player.get("currentTier").and_then(Value::as_u64).unwrap_or(0);
        if tier > 0 {
            let entry = teams.entry(team.to_string()).or_default();
            entry.0 += tier;
            entry.1 += 1;
        } else {
            teams.entry(team.to_string()).or_default();
        }
    }
    let mut output: Vec<Value> = teams.into_iter().map(|(id, (sum, count))| json!({
        "id": id,
        "averageTier": if count > 0 { Some(sum as f64 / count as f64) } else { None },
        "ratedPlayers": count,
    })).collect();
    output.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    output
}
```

- [ ] **Step 4: Add the fields to `live_game_fetch` and keep the idle payload compatible**

Build the active payload from the existing `state_key`, `match_data`, and `players`:

```rust
let match_context = extract_match_context(
    detected.state,
    &match_data,
    detected.match_id.as_deref(),
);
let teams = summarize_teams(&players);
let payload = json!({
    "success": true,
    "state": detected.state.as_str(),
    "rosterKey": state_key,
    "match": match_context,
    "teams": teams,
    "players": players,
}).to_string();
```

Return `rosterKey: "idle"`, `match: null`, and `teams: []` for idle.

- [ ] **Step 5: Run focused tests and a compile check**

Run: `cargo test commands::live::tests --lib --quiet`

Expected: all Live Game unit tests pass.

Run: `cargo check --quiet`

Expected: exit 0; existing warnings may remain.

---

### Task 2: Add last-five competitive statistics and progressive events

**Files:**
- Modify: `src-tauri/src/commands/live.rs`
- Modify: `src-tauri/src/riot/api.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/commands/live.rs` inline tests

**Interfaces:**
- Produces: `select_competitive_match_ids(history: &Value, limit: usize) -> Vec<String>`
- Produces: `aggregate_recent_stats(puuid: &str, matches: &[Value]) -> Result<Value, String>`
- Produces: managed `LiveStatsCache(Mutex<HashMap<String, Value>>)`.
- Produces: Tauri command `live_game_stats(args, app, riot, cache)` and event `live-game:player-stats`.

- [ ] **Step 1: Write failing selection and aggregation tests**

```rust
#[test]
fn selects_five_newest_competitive_matches() {
    let history = json!({"History": [
        {"MatchID":"c1","QueueID":"competitive"},
        {"MatchID":"u1","QueueID":"unrated"},
        {"MatchID":"c2","QueueID":"competitive"},
        {"MatchID":"c3","QueueID":"competitive"},
        {"MatchID":"c4","QueueID":"competitive"},
        {"MatchID":"c5","QueueID":"competitive"},
        {"MatchID":"c6","QueueID":"competitive"}
    ]});
    assert_eq!(select_competitive_match_ids(&history, 5), ["c1","c2","c3","c4","c5"]);
}

#[test]
fn aggregates_recent_player_stats() {
    let matches = vec![
        json!({"players":[{"subject":"p1","teamId":"Blue","stats":{"kills":20,"deaths":10,"assists":5,"score":4000,"roundsPlayed":20}}],"teams":[{"teamId":"Blue","won":true}]}),
        json!({"players":[{"subject":"p1","teamId":"Red","stats":{"kills":10,"deaths":10,"assists":7,"score":3000,"roundsPlayed":20}}],"teams":[{"teamId":"Red","won":false}]})
    ];
    let result = aggregate_recent_stats("p1", &matches).unwrap();
    assert_eq!(result["matches"], 2);
    assert_eq!(result["kills"], 30);
    assert_eq!(result["deaths"], 20);
    assert_eq!(result["assists"], 12);
    assert_eq!(result["kd"], 1.5);
    assert_eq!(result["winRate"], 50.0);
    assert_eq!(result["acs"], 175.0);
}
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run each test by fully qualified name under `cargo test ... --lib`.

Expected: compile failure because selection and aggregation functions are undefined.

- [ ] **Step 3: Implement history filtering and aggregation**

Filter `History` in source order, match `QueueID` case-insensitively against `competitive`, discard empty match IDs, and stop at `limit`. Aggregate only documents that contain the requested player. Derive the player's win from the matching `teamId` entry in `teams`. Return an error when zero documents contain the player.

The output must match this contract:

```rust
json!({
    "matches": analyzed,
    "kills": kills,
    "deaths": deaths,
    "assists": assists,
    "wins": wins,
    "kd": kills as f64 / deaths.max(1) as f64,
    "winRate": wins as f64 * 100.0 / analyzed as f64,
    "acs": score as f64 / rounds.max(1) as f64,
})
```

- [ ] **Step 4: Add a clonable API client, cache, and bounded worker command**

Add `#[derive(Clone)]` to `RiotApiClient`. Define:

```rust
#[derive(Default)]
pub struct LiveStatsCache(Mutex<HashMap<String, Value>>);
```

Parse `args[0]` as `rosterKey` and `args[1]` as a string array of player IDs. Create one API client, clone it into a `tokio::task::JoinSet`, and keep at most three workers active. Each worker fetches 20 history entries, selects five competitive IDs, fetches their details in order, builds a cache key from player ID plus selected IDs, and returns `(puuid, Result<Value, String>)`.

Emit this exact event shape from the command thread:

```rust
app.emit("live-game:player-stats", json!({
    "rosterKey": roster_key,
    "puuid": puuid,
    "success": result.is_ok(),
    "stats": result.as_ref().ok(),
    "error": result.err(),
}).to_string())
```

Return `{"success":true,"count":<requested player count>}` after all workers finish. Register `LiveStatsCache::default()` with `app.manage(...)` and add `commands::live::live_game_stats` to `generate_handler!`.

- [ ] **Step 5: Run backend verification**

Run: `cargo test commands::live::tests --lib --quiet`

Expected: selection, aggregation, context, and existing Live Game tests pass.

Run: `cargo check --quiet`

Expected: exit 0.

---

### Task 3: Add frontend contracts, asset loading, and progressive state

**Files:**
- Modify: `src/types/live-game.ts`
- Create: `src/components/live-game/use-live-game-assets.ts`
- Modify: `src/pages/LiveGame.tsx`

**Interfaces:**
- Produces: `LiveMatchContext`, `LiveTeamSummary`, `RecentPlayerStats`, and `RecentStatsEvent` types.
- Produces: `useLiveGameAssets(players)` with agents, tiers, maps, seasons, skins, and cards.
- Produces page state `Record<string, RecentStatsState>` keyed by PUUID.

- [ ] **Step 1: Extend the TypeScript contracts**

```ts
export type LiveMatchContext = {
  id: string | null;
  mapId: string | null;
  modeId: string | null;
  queueId: string;
  phase: Exclude<LiveState, "idle">;
};

export type LiveTeamSummary = {
  id: string;
  averageTier: number | null;
  ratedPlayers: number;
};

export type RecentPlayerStats = {
  matches: number;
  kills: number;
  deaths: number;
  assists: number;
  wins: number;
  kd: number;
  winRate: number;
  acs: number;
};

export type RecentStatsEvent =
  | { rosterKey: string; puuid: string; success: true; stats: RecentPlayerStats; error: null }
  | { rosterKey: string; puuid: string; success: false; stats: null; error: string };

export type RecentStatsState =
  | { status: "loading" }
  | { status: "ready"; stats: RecentPlayerStats }
  | { status: "error"; error: string };
```

Extend the successful response with `rosterKey`, `match`, and `teams`.

- [ ] **Step 2: Extract the existing asset hook**

Move the current pooled skin/card loading from `LiveGame.tsx` into `use-live-game-assets.ts`. Add `getMaps()` to the one-time asset load. Export `LiveGameAssets` and `useLiveGameAssets(players)`. Keep module-scope caches in `valorant-assets.ts` and cancel state writes when the component unmounts.

- [ ] **Step 3: Add progressive event coordination to the page**

Register one `live-game:player-stats` listener. Parse `RecentStatsEvent`, ignore any event whose `rosterKey` differs from a `useRef` containing the latest roster key, and update only `recent[event.puuid]`.

On a new successful roster key:

```ts
setRecent(Object.fromEntries(res.players.map((player) => [player.puuid, { status: "loading" as const }])));
window.Main.send("live-game:stats", res.rosterKey, res.players.map((player) => player.puuid));
```

Do not restart enrichment on identical five-second snapshots. Keep the previous snapshot visible while a refresh request is in flight.

- [ ] **Step 4: Run TypeScript compilation**

Run: `bunx tsc --noEmit`

Expected: exit 0.

---

### Task 4: Build the dense expandable scouting table

**Files:**
- Create: `src/components/live-game/live-game-state-panel.tsx`
- Create: `src/components/live-game/live-scout-table.tsx`
- Modify: `src/pages/LiveGame.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`

**Interfaces:**
- Consumes: `LiveGameAssets`, the expanded success snapshot, and `Record<string, RecentStatsState>`.
- Produces: `LiveGameStatePanel` and `LiveScoutTable`.

- [ ] **Step 1: Implement the shared state panel**

`LiveGameStatePanel` accepts `{ kind: "loading" | "idle" | "login" | "error"; detail?: string; onRetry?: () => void }`. Use semantic text, `role="alert"` for errors, a retry button with at least 44-pixel height, and fixed skeleton blocks for loading.

- [ ] **Step 2: Implement the match bar and summary cells**

Use `PageHeader` for the page title. Resolve the map through `mapName` and the queue through `queueLabel`. The match bar shows phase text, a non-color live marker, and a manual refresh button with an accessible label. Render ally/enemy average tier through `tierName(Math.round(averageTier))`, plus rated-player count. Show detected party count and roster size in the other summary cells.

- [ ] **Step 3: Implement expandable scouting rows**

Use a semantic `<button>` as each row trigger with `aria-expanded` and `aria-controls`. Desktop columns are player/agent, party, current rank/RR, peak rank, K/D, win rate, ACS, and skins. Keep player, team, rank, K/D, and win rate visible below the desktop breakpoint; move the remaining fields into the expansion.

Format recent values as `kd.toFixed(2)`, `${winRate.toFixed(0)}%`, and `acs.toFixed(0)`. Render fixed-width skeletons for `loading` and `Unavailable` for `error`. Display `matches` next to the recent-stat heading so small samples remain clear.

The expanded area shows three skin cards with stable image boxes and localized names. It also shows aggregate K/D/A and the per-player error. Keep one expanded PUUID in page state; clicking it again closes the row.

- [ ] **Step 4: Add translations**

Add these exact English keys under `liveGame`:

```json
{
  "matchContext": "Match context",
  "teamAverage": "Team average",
  "ratedPlayers": "{{count}} rated",
  "detectedParties": "Detected parties",
  "rosterSize": "Roster",
  "recentFive": "Last 5 competitive matches",
  "kd": "K/D",
  "winRate": "Win rate",
  "acs": "ACS",
  "matchesAnalyzed": "{{count}} analyzed",
  "unavailable": "Unavailable",
  "refresh": "Refresh",
  "refreshing": "Refreshing",
  "expandPlayer": "Expand {{player}}",
  "collapsePlayer": "Collapse {{player}}",
  "retry": "Retry",
  "partyDetected": "Detected {{party}}"
}
```

Use these Traditional Chinese values: `對戰資訊`, `隊伍平均`, `{{count}} 位有牌位`, `偵測到的組隊`, `玩家名單`, `最近 5 場競技對戰`, `K/D`, `勝率`, `ACS`, `已分析 {{count}} 場`, `無法取得`, `重新整理`, `正在重新整理`, `展開 {{player}}`, `收合 {{player}}`, `重試`, `偵測到 {{party}}`.

Use these Korean values: `매치 정보`, `팀 평균`, `랭크 {{count}}명`, `감지된 파티`, `로스터`, `최근 경쟁전 5경기`, `K/D`, `승률`, `ACS`, `{{count}}경기 분석`, `사용할 수 없음`, `새로고침`, `새로고침 중`, `{{player}} 펼치기`, `{{player}} 접기`, `다시 시도`, `감지된 {{party}}`.

- [ ] **Step 5: Replace the old page composition**

Remove the five-column oversized title card and old `TeamSection`/`PlayerRow` layout from `LiveGame.tsx`. Compose `PageHeader`, `LiveGameStatePanel`, and `LiveScoutTable`. Preserve the developer dump action but replace its text glyph with the existing `react-icons/fa6` download icon and an accessible title.

- [ ] **Step 6: Run frontend verification**

Run: `bun run build:vite`

Expected: TypeScript and Vite build succeed. Existing chunk-size and Vite config warnings may remain.

Run: `bun run lint`

Expected: exit 0 when ESLint is installed. If this checkout still lacks the ESLint executable, record that environment limitation without changing dependencies.

---

### Task 5: Final verification and review

**Files:**
- Review all files listed in the file map.

**Interfaces:**
- Consumes the complete backend and frontend feature.
- Produces verification evidence and a reviewed handoff.

- [ ] **Step 1: Run focused backend tests**

Run: `cargo test commands::live::tests --lib --quiet`

Expected: all focused tests pass.

- [ ] **Step 2: Run compiler and formatting checks**

Run: `cargo check --quiet`

Expected: exit 0.

Run: `cargo fmt --check`

Expected: exit 0.

- [ ] **Step 3: Run the production frontend build**

Run: `bun run build:vite`

Expected: exit 0.

- [ ] **Step 4: Inspect the final page at narrow and desktop widths**

Verify no page-level horizontal scrollbar, keyboard row expansion, visible focus, stable loading geometry, map/queue fallbacks, and stale-event rejection. Use the in-app browser or local app preview if available.

- [ ] **Step 5: Request a code review**

Ask the reviewer to check snapshot compatibility, request bounds, cache keys, stale progressive events, team/party labeling, responsive overflow, keyboard semantics, and preservation of unrelated worktree changes. Fix Critical and Important findings, then repeat the affected verification commands.
