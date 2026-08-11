# Live Player Act Rank Triangle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a selectable current-and-previous-act rank triangle to each expanded Live Game player row using the supplied `public/mmr` images.

**Architecture:** Extend the existing live snapshot with normalized competitive-season records from MMR data already fetched by the Rust backend. Keep rank-badge math in a pure TypeScript module, render the nine tiles in a focused component, and let `PlayerRow` retain the selected act while its detail panel is collapsed.

**Tech Stack:** Rust, serde_json, Tauri 2 IPC, React 19, TypeScript 6, Tailwind CSS 4, i18next, Bun test, Vite 8

## Global Constraints

- Do not add a Riot request or IPC channel; `enrich_players` already has each player's MMR response.
- Render at most the top nine ranked results, ordered by tier descending.
- Select borders at 9, 25, 50, 75, and 100 total wins.
- Keep the collapsed Live Game table unchanged.
- Keep selected-act state in `PlayerRow` so collapsing and reopening retains the choice.
- Use `/public/mmr/<tier>_up.png`, `/public/mmr/<tier>_down.png`, and `/public/mmr/border0.png` through `border5.png`.
- Do not add a frontend test framework; use Bun's built-in test runner for pure TypeScript logic.
- Add visible strings to English, Korean, and Traditional Chinese locale files.

---

## File Map

- Modify `src-tauri/src/commands/live.rs`: normalize seasonal MMR records and attach them to each live player.
- Modify `src/types/live-game.ts`: define `CompetitiveSeason` and extend `LivePlayer`.
- Modify `src/util/valorant-assets.ts`: expose season label and start-time metadata from the existing cached seasons request.
- Modify `src/components/live-game/use-live-game-assets.ts`: load typed season metadata for the Live Game UI.
- Create `src/components/live-game/act-rank.ts`: pure tile, border, season-sort, and default-selection logic.
- Create `src/components/live-game/act-rank.test.ts`: Bun tests for badge and season selection rules.
- Create `src/components/live-game/act-rank-triangle.tsx`: responsive image composition only.
- Create `src/components/live-game/act-rank-panel.tsx`: selector, selected-act statistics, and empty state.
- Modify `src/components/live-game/live-scout-table.tsx`: retain selection in `PlayerRow` and mount the panel only while expanded.
- Modify `src/i18n/locales/en.json`, `src/i18n/locales/ko.json`, and `src/i18n/locales/zh-TW.json`: panel labels and unavailable copy.
- Add `public/mmr/*.png`: track the user-supplied badge assets.

---

### Task 1: Normalize Competitive Seasons In The Live Snapshot

**Files:**
- Modify: `src-tauri/src/commands/live.rs`

**Interfaces:**
- Consumes: Riot MMR `Value` with `LatestCompetitiveUpdate` and `QueueSkills.competitive.SeasonalInfoBySeasonID`.
- Produces: `extract_competitive_seasons(mmr: Option<&Value>) -> (Option<String>, Vec<Value>)`, plus `currentSeasonId` and `competitiveSeasons` fields on every live player.

- [ ] **Step 1: Add failing normalization tests**

Add these tests inside the existing `#[cfg(test)] mod tests` in `live.rs`:

```rust
#[test]
fn normalizes_competitive_seasons_and_current_id() {
    let mmr = json!({
        "LatestCompetitiveUpdate": {"SeasonID": "act-current"},
        "QueueSkills": {"competitive": {"SeasonalInfoBySeasonID": {
            "act-current": {
                "CompetitiveTier": 22,
                "RankedRating": 61,
                "NumberOfWins": 12,
                "NumberOfGames": 20,
                "WinsByTier": {"22": 8, "21": 4, "bad": 99, "20": -2}
            }
        }}}
    });

    let (current, seasons) = extract_competitive_seasons(Some(&mmr));
    assert_eq!(current.as_deref(), Some("act-current"));
    assert_eq!(seasons.len(), 1);
    assert_eq!(seasons[0]["seasonId"], "act-current");
    assert_eq!(seasons[0]["tier"], 22);
    assert_eq!(seasons[0]["rankedRating"], 61);
    assert_eq!(seasons[0]["wins"], 12);
    assert_eq!(seasons[0]["games"], 20);
    assert_eq!(seasons[0]["winsByTier"], json!({"21": 4, "22": 8}));
}

#[test]
fn competitive_seasons_tolerate_missing_and_negative_values() {
    assert_eq!(extract_competitive_seasons(None), (None, vec![]));

    let mmr = json!({
        "QueueSkills": {"competitive": {"SeasonalInfoBySeasonID": {
            "act-old": {"CompetitiveTier": -1, "NumberOfWins": null}
        }}}
    });
    let (current, seasons) = extract_competitive_seasons(Some(&mmr));
    assert_eq!(current, None);
    assert_eq!(seasons[0]["tier"], 0);
    assert_eq!(seasons[0]["rankedRating"], 0);
    assert_eq!(seasons[0]["wins"], 0);
    assert_eq!(seasons[0]["games"], 0);
    assert_eq!(seasons[0]["winsByTier"], json!({}));
}
```

- [ ] **Step 2: Run the tests and verify the missing function failure**

Run: `cargo test commands::live::tests::normalizes_competitive_seasons --manifest-path src-tauri/Cargo.toml`

Expected: compilation fails because `extract_competitive_seasons` does not exist.

- [ ] **Step 3: Implement defensive normalization**

Add the following beside `extract_rank`:

```rust
fn non_negative(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn extract_competitive_seasons(mmr: Option<&Value>) -> (Option<String>, Vec<Value>) {
    let Some(mmr) = mmr else {
        return (None, vec![]);
    };
    let current_season_id = mmr
        .pointer("/LatestCompetitiveUpdate/SeasonID")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let Some(seasonal) = mmr
        .pointer("/QueueSkills/competitive/SeasonalInfoBySeasonID")
        .and_then(Value::as_object)
    else {
        return (current_season_id, vec![]);
    };

    let seasons = seasonal
        .iter()
        .filter(|(season_id, _)| !season_id.is_empty())
        .map(|(season_id, info)| {
            let mut wins_by_tier = serde_json::Map::new();
            if let Some(wins) = info.get("WinsByTier").and_then(Value::as_object) {
                for (tier, count) in wins {
                    let valid_tier = tier.parse::<i64>().ok().filter(|tier| *tier >= 3 && *tier <= 27);
                    let count = non_negative(Some(count));
                    if valid_tier.is_some() && count > 0 {
                        wins_by_tier.insert(tier.clone(), json!(count));
                    }
                }
            }
            json!({
                "seasonId": season_id,
                "tier": non_negative(info.get("CompetitiveTier")),
                "rankedRating": non_negative(info.get("RankedRating")),
                "wins": non_negative(info.get("NumberOfWins")),
                "games": non_negative(info.get("NumberOfGames")),
                "winsByTier": wins_by_tier,
            })
        })
        .collect();
    (current_season_id, seasons)
}
```

In the player mapping, call the function once and add both fields:

```rust
let mmr = mmr_map.get(&puuid);
let (current_tier, current_rr, peak_tier, peak_season_id) = extract_rank(mmr);
let (current_season_id, competitive_seasons) = extract_competitive_seasons(mmr);
```

```rust
"currentSeasonId": current_season_id,
"competitiveSeasons": competitive_seasons,
```

- [ ] **Step 4: Run focused and full Rust tests**

Run: `cargo test commands::live::tests:: --manifest-path src-tauri/Cargo.toml`

Expected: all live command tests pass.

- [ ] **Step 5: Commit the backend payload**

```bash
git add src-tauri/src/commands/live.rs
git commit -m "feat: expose live player act ranks"
```

---

### Task 2: Add Types, Season Metadata, And Pure Badge Rules

**Files:**
- Modify: `src/types/live-game.ts`
- Modify: `src/util/valorant-assets.ts`
- Modify: `src/components/live-game/use-live-game-assets.ts`
- Create: `src/components/live-game/act-rank.ts`
- Create: `src/components/live-game/act-rank.test.ts`

**Interfaces:**
- Consumes: normalized `CompetitiveSeason[]` and Valorant API season start times.
- Produces: `buildActRankTiles`, `borderIndexForWins`, `sortCompetitiveSeasons`, `initialSeasonId`, `seasonFallbackLabel`, and `SeasonAsset`.

- [ ] **Step 1: Define the frontend payload type**

Add before `LivePlayer` in `src/types/live-game.ts`:

```ts
export type CompetitiveSeason = {
	seasonId: string;
	tier: number;
	rankedRating: number;
	wins: number;
	games: number;
	winsByTier: Record<string, number>;
};
```

Add to `LivePlayer`:

```ts
currentSeasonId: string | null;
competitiveSeasons: CompetitiveSeason[];
```

- [ ] **Step 2: Write failing tests for badge and season rules**

Create `src/components/live-game/act-rank.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { CompetitiveSeason } from "../../types/live-game";
import {
	borderIndexForWins,
	buildActRankTiles,
	initialSeasonId,
	seasonFallbackLabel,
	sortCompetitiveSeasons,
} from "./act-rank";

const season = (seasonId: string): CompetitiveSeason => ({
	seasonId, tier: 20, rankedRating: 40, wins: 10, games: 18, winsByTier: {},
});

describe("act rank badge", () => {
	test("keeps the nine highest tier wins and assigns tessellated slots", () => {
		const tiles = buildActRankTiles({ "20": 5, "24": 2, "22": 4, bad: 8, "28": 3 });
		expect(tiles.map((tile) => tile.tier)).toEqual([24, 24, 22, 22, 22, 22, 20, 20, 20]);
		expect(tiles.map((tile) => [tile.row, tile.column, tile.orientation])).toEqual([
			[0, 0, "up"],
			[1, 0, "up"], [1, 1, "down"], [1, 2, "up"],
			[2, 0, "up"], [2, 1, "down"], [2, 2, "up"], [2, 3, "down"], [2, 4, "up"],
		]);
	});

	test("selects borders at Riot win thresholds", () => {
		expect([0, 8, 9, 24, 25, 49, 50, 74, 75, 99, 100].map(borderIndexForWins))
			.toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
	});
});

describe("act selection", () => {
	test("sorts by season start and prefers the current act", () => {
		const seasons = [season("old"), season("current"), season("middle")];
		const starts = new Map([["old", 100], ["middle", 200], ["current", 300]]);
		expect(sortCompetitiveSeasons(seasons, starts).map((item) => item.seasonId))
			.toEqual(["current", "middle", "old"]);
		expect(initialSeasonId(seasons, "current", starts)).toBe("current");
		expect(initialSeasonId(seasons, "missing", starts)).toBe("current");
	});

	test("uses deterministic fallbacks", () => {
		expect(initialSeasonId([season("b"), season("a")], null, new Map())).toBe("a");
		expect(seasonFallbackLabel("12345678-abcd-efgh")).toBe("12345678");
	});
});
```

- [ ] **Step 3: Run the test and verify the missing module failure**

Run: `bun test src/components/live-game/act-rank.test.ts`

Expected: FAIL because `./act-rank` does not exist.

- [ ] **Step 4: Implement the pure rules**

Create `src/components/live-game/act-rank.ts`:

```ts
import type { CompetitiveSeason } from "../../types/live-game";

export type ActRankTile = {
	tier: number;
	row: number;
	column: number;
	orientation: "up" | "down";
};

const VALID_TIER_MIN = 3;
const VALID_TIER_MAX = 27;
const BADGE_TILE_COUNT = 9;

export const buildActRankTiles = (winsByTier: Record<string, number>): ActRankTile[] => {
	const tiers = Object.entries(winsByTier)
		.flatMap(([rawTier, rawCount]) => {
			const tier = Number(rawTier);
			const count = Math.max(0, Math.floor(Number(rawCount) || 0));
			return Number.isInteger(tier) && tier >= VALID_TIER_MIN && tier <= VALID_TIER_MAX
				? Array.from({ length: count }, () => tier)
				: [];
		})
		.sort((a, b) => b - a)
		.slice(0, BADGE_TILE_COUNT);

	return tiers.map((tier, index) => {
		const row = index === 0 ? 0 : index <= 3 ? 1 : 2;
		const rowStart = row === 0 ? 0 : row === 1 ? 1 : 4;
		const column = index - rowStart;
		return { tier, row, column, orientation: column % 2 === 0 ? "up" : "down" };
	});
};

export const borderIndexForWins = (wins: number): number => {
	if (wins >= 100) return 5;
	if (wins >= 75) return 4;
	if (wins >= 50) return 3;
	if (wins >= 25) return 2;
	if (wins >= 9) return 1;
	return 0;
};

export const sortCompetitiveSeasons = (
	seasons: CompetitiveSeason[],
	starts: Map<string, number>,
): CompetitiveSeason[] => [...seasons].sort((a, b) => {
	const dateDifference = (starts.get(b.seasonId.toLowerCase()) ?? 0) - (starts.get(a.seasonId.toLowerCase()) ?? 0);
	return dateDifference || a.seasonId.localeCompare(b.seasonId);
});

export const initialSeasonId = (
	seasons: CompetitiveSeason[],
	currentSeasonId: string | null,
	starts: Map<string, number>,
): string | null => {
	if (currentSeasonId && seasons.some((season) => season.seasonId === currentSeasonId)) return currentSeasonId;
	return sortCompetitiveSeasons(seasons, starts)[0]?.seasonId ?? null;
};

export const seasonFallbackLabel = (seasonId: string): string => seasonId.slice(0, 8);
```

- [ ] **Step 5: Expose season start times without breaking existing label consumers**

In `src/util/valorant-assets.ts`, replace `seasonsPromise` with one shared metadata promise and keep `getSeasonLabels` as a compatibility wrapper:

```ts
export type SeasonAsset = { label: string; startMillis: number };
let seasonAssetsPromise: Promise<Map<string, SeasonAsset>> | null = null;

export const getSeasonAssets = (): Promise<Map<string, SeasonAsset>> => {
	if (!seasonAssetsPromise) {
		seasonAssetsPromise = fetch(`${API}/seasons?language=all`)
			.then((r) => r.json())
			.then((json) => {
				const seasons: any[] = json?.data ?? [];
				type Ep = { uuid: string; label: string; start: number; end: number };
				const episodes: Ep[] = [];
				for (const season of seasons) {
					if (season.type !== "EAresSeasonType::Act") {
						episodes.push({
							uuid: season.uuid,
							label: episodeLabel(enName(season.displayName)),
							start: Date.parse(season.startTime) || 0,
							end: Date.parse(season.endTime) || Number.MAX_SAFE_INTEGER,
						});
					}
				}
				const byUuid = new Map(episodes.map((episode) => [episode.uuid, episode.label]));
				const byTime = (time: number) =>
					episodes.find((episode) => time >= episode.start && time < episode.end)?.label ?? "";
				const assets = new Map<string, SeasonAsset>();
				for (const season of seasons) {
					if (season.type !== "EAresSeasonType::Act") continue;
					const startMillis = Date.parse(season.startTime) || 0;
					const episode = byUuid.get(season.parentUuid) || byTime(startMillis);
					const label = formatSeasonActLabel(episode, actNumber(enName(season.displayName)));
					if (label) assets.set((season.uuid as string).toLowerCase(), { label, startMillis });
				}
				return assets;
			})
			.catch(() => new Map<string, SeasonAsset>());
	}
	return seasonAssetsPromise;
};

export const getSeasonLabels = (): Promise<Map<string, string>> =>
	getSeasonAssets().then((assets) => new Map([...assets].map(([id, asset]) => [id, asset.label])));
```

In `use-live-game-assets.ts`, import `getSeasonAssets` and `SeasonAsset`, change `seasons` to `Map<string, SeasonAsset>`, and load `getSeasonAssets()` in the existing `Promise.all`.

- [ ] **Step 6: Run tests and TypeScript build**

Run: `bun test src/components/live-game/act-rank.test.ts`

Expected: 4 tests pass.

Run: `bun run build:vite`

Expected: TypeScript and Vite build successfully after updating `peakAct` usage in `live-scout-table.tsx` from the map value to `.label`.

- [ ] **Step 7: Commit types and pure logic**

```bash
git add src/types/live-game.ts src/util/valorant-assets.ts src/components/live-game/use-live-game-assets.ts src/components/live-game/act-rank.ts src/components/live-game/act-rank.test.ts src/components/live-game/live-scout-table.tsx
git commit -m "feat: add act rank badge rules"
```

---

### Task 3: Render The Supplied Act Rank Images

**Files:**
- Create: `src/components/live-game/act-rank-triangle.tsx`
- Add: `public/mmr/*.png`

**Interfaces:**
- Consumes: `winsByTier: Record<string, number>` and `wins: number`.
- Produces: `ActRankTriangle`, a presentation-only responsive square.

- [ ] **Step 1: Add a failing asset-integrity test**

Append to `act-rank.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

test("all valid tier orientations and borders have supplied assets", () => {
	for (let tier = 3; tier <= 27; tier++) {
		for (const orientation of ["up", "down"]) {
			expect(existsSync(join(process.cwd(), "public", "mmr", `${tier}_${orientation}.png`))).toBe(true);
		}
	}
	for (let border = 0; border <= 5; border++) {
		expect(existsSync(join(process.cwd(), "public", "mmr", `border${border}.png`))).toBe(true);
	}
});
```

- [ ] **Step 2: Run the asset test**

Run: `bun test src/components/live-game/act-rank.test.ts`

Expected: PASS because the user supplied every required file. If it fails, report the exact missing filename and stop rather than generating substitute art.

- [ ] **Step 3: Implement fixed-coordinate image composition**

Create `act-rank-triangle.tsx`:

```tsx
import { borderIndexForWins, buildActRankTiles } from "./act-rank";

const TILE_WIDTH = 24.4140625;
const TILE_HEIGHT = 21.6796875;
const FIRST_ROW_TOP = 29.6875;

export const ActRankTriangle = ({ winsByTier, wins }: {
	winsByTier: Record<string, number>;
	wins: number;
}) => {
	const tiles = buildActRankTiles(winsByTier);
	const border = borderIndexForWins(wins);
	return (
		<div className="relative aspect-square w-full max-w-[24rem] mx-auto" aria-hidden="true">
			{tiles.map((tile, index) => {
				const rowWidth = TILE_WIDTH * (tile.row + 1);
				const left = 50 - rowWidth / 2 + tile.column * TILE_WIDTH / 2;
				const top = FIRST_ROW_TOP + tile.row * TILE_HEIGHT / 2;
				return (
					<img
						key={`${tile.tier}-${index}`}
						src={`/mmr/${tile.tier}_${tile.orientation}.png`}
						alt=""
						className="absolute object-fill"
						style={{ left: `${left}%`, top: `${top}%`, width: `${TILE_WIDTH}%`, height: `${TILE_HEIGHT}%` }}
					/>
				);
			})}
			<img src={`/mmr/border${border}.png`} alt="" className="absolute inset-0 z-10 h-full w-full object-contain pointer-events-none" />
		</div>
	);
};
```

- [ ] **Step 4: Run unit tests and production build**

Run: `bun test src/components/live-game/act-rank.test.ts`

Expected: all tests pass.

Run: `bun run build:vite`

Expected: Vite emits the production bundle without TypeScript errors.

- [ ] **Step 5: Commit the renderer and supplied assets**

```bash
git add src/components/live-game/act-rank-triangle.tsx public/mmr
git commit -m "feat: render act rank triangle assets"
```

---

### Task 4: Add The Dropdown Panel To Expanded Player Rows

**Files:**
- Create: `src/components/live-game/act-rank-panel.tsx`
- Modify: `src/components/live-game/live-scout-table.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/ko.json`
- Modify: `src/i18n/locales/zh-TW.json`

**Interfaces:**
- Consumes: a `LivePlayer`, `LiveGameAssets`, `selectedSeasonId`, and `onSeasonChange`.
- Produces: an accessible act selector and reference-style act statistics around `ActRankTriangle`.

- [ ] **Step 1: Add locale keys before writing JSX**

Add these keys inside each `liveGame` object:

```json
// en.json
"actRank": "Act Rank",
"selectAct": "Select competitive act",
"rank": "Rank",
"rankedRating": "RR",
"wins": "Wins",
"games": "Games",
"lowest": "Lowest",
"finalRank": "Final",
"noActRank": "No competitive act data available"
```

```json
// ko.json
"actRank": "액트 랭크",
"selectAct": "경쟁전 액트 선택",
"rank": "랭크",
"rankedRating": "RR",
"wins": "승리",
"games": "게임",
"lowest": "최저",
"finalRank": "최종",
"noActRank": "경쟁전 액트 데이터를 불러올 수 없습니다"
```

```json
// zh-TW.json
"actRank": "章節牌位",
"selectAct": "選擇競技章節",
"rank": "牌位",
"rankedRating": "RR",
"wins": "勝場",
"games": "場次",
"lowest": "最低",
"finalRank": "最終",
"noActRank": "沒有可用的競技章節資料"
```

Remove the comment lines when editing JSON and preserve valid comma placement.

- [ ] **Step 2: Implement the panel**

Create `src/components/live-game/act-rank-panel.tsx`:

```tsx
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CompetitiveSeason, LivePlayer } from "../../types/live-game";
import { tierColor, tierName } from "../../util/valorant-ranks";
import { seasonFallbackLabel, sortCompetitiveSeasons } from "./act-rank";
import { ActRankTriangle } from "./act-rank-triangle";
import type { LiveGameAssets } from "./use-live-game-assets";

type Props = {
	player: LivePlayer;
	assets: LiveGameAssets;
	selectedSeasonId: string | null;
	onSeasonChange: (seasonId: string) => void;
};

const tierFromWins = (season: CompetitiveSeason, edge: "min" | "max") => {
	const tiers = Object.entries(season.winsByTier)
		.filter(([, count]) => count > 0)
		.map(([tier]) => Number(tier))
		.filter((tier) => Number.isInteger(tier) && tier >= 3 && tier <= 27);
	return tiers.length ? (edge === "min" ? Math.min(...tiers) : Math.max(...tiers)) : 0;
};

const ActStat = ({ label, value }: { label: string; value: ReactNode }) => (
	<div className="min-w-0">
		<p className="text-[9px] uppercase tracking-widest text-gray-600">{label}</p>
		<p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-gray-100">{value}</p>
	</div>
);

export const ActRankPanel = ({ player, assets, selectedSeasonId, onSeasonChange }: Props) => {
	const { t } = useTranslation();
	const starts = useMemo(
		() => new Map([...assets.seasons].map(([id, season]) => [id, season.startMillis])),
		[assets.seasons],
	);
	const seasons = useMemo(
		() => sortCompetitiveSeasons(player.competitiveSeasons, starts),
		[player.competitiveSeasons, starts],
	);
	const selected = seasons.find((season) => season.seasonId === selectedSeasonId) ?? seasons[0];
	const labelFor = (seasonId: string) =>
		assets.seasons.get(seasonId.toLowerCase())?.label ?? seasonFallbackLabel(seasonId);

	if (!selected) {
		return (
			<section className="rounded-lg border border-white/6 bg-white/2 px-3 py-5 text-center">
				<p className="text-xs text-gray-500">{t("liveGame.noActRank")}</p>
			</section>
		);
	}

	const peakTier = tierFromWins(selected, "max");
	const lowestTier = tierFromWins(selected, "min");
	const rankText = (tier: number) => tier > 0 ? tierName(tier) : t("liveGame.unavailable");
	const winRate = selected.games > 0 ? `${((selected.wins / selected.games) * 100).toFixed(1)}%` : t("liveGame.unavailable");

	return (
		<section className="rounded-lg border border-white/6 bg-black/15 p-3">
			<header className="flex items-center justify-between gap-3 border-b border-white/6 pb-2">
				<div className="min-w-0">
					<h3 className="text-xs font-bold text-white">{t("liveGame.actRank")}</h3>
					<p className="text-[9px] uppercase tracking-widest text-gray-600">{labelFor(selected.seasonId)}</p>
				</div>
				<select
					aria-label={t("liveGame.selectAct")}
					value={selected.seasonId}
					onChange={(event) => onSeasonChange(event.target.value)}
					className="h-9 max-w-44 rounded-md border border-white/10 bg-[#101218] px-2 text-xs text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
				>
					{seasons.map((season) => <option key={season.seasonId} value={season.seasonId}>{labelFor(season.seasonId)}</option>)}
				</select>
			</header>

			<div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-[minmax(8rem,1fr)_minmax(16rem,24rem)_minmax(8rem,1fr)] lg:items-center">
				<div className="order-2 grid grid-cols-2 gap-3 lg:order-1 lg:grid-cols-1">
					<ActStat label={t("liveGame.rank")} value={<span style={{ color: selected.tier > 0 ? tierColor(selected.tier) : undefined }}>{rankText(selected.tier)}</span>} />
					<ActStat label={t("liveGame.rankedRating")} value={selected.tier > 0 ? `${selected.rankedRating} / 100` : t("liveGame.unavailable")} />
				</div>
				<div className="order-1 col-span-2 lg:order-2 lg:col-span-1">
					<ActRankTriangle winsByTier={selected.winsByTier} wins={selected.wins} />
				</div>
				<div className="order-3 grid grid-cols-2 gap-3 lg:grid-cols-1">
					<ActStat label={t("liveGame.wins")} value={selected.wins} />
					<ActStat label={t("liveGame.games")} value={selected.games} />
					<ActStat label={t("liveGame.winRate")} value={winRate} />
					<ActStat label={t("liveGame.peak")} value={rankText(peakTier)} />
					<ActStat label={t("liveGame.lowest")} value={rankText(lowestTier)} />
					<ActStat label={t("liveGame.finalRank")} value={rankText(selected.tier)} />
				</div>
			</div>
		</section>
	);
};
```

- [ ] **Step 3: Integrate persistent selection into `PlayerRow`**

Import `useEffect` and `ActRankPanel`. Inside `PlayerRow`, build the season start map and retain selection:

```tsx
const seasonStarts = useMemo(
	() => new Map([...assets.seasons].map(([id, season]) => [id, season.startMillis])),
	[assets.seasons],
);
const defaultSeasonId = useMemo(
	() => initialSeasonId(player.competitiveSeasons, player.currentSeasonId, seasonStarts),
	[player.competitiveSeasons, player.currentSeasonId, seasonStarts],
);
const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(defaultSeasonId);
useEffect(() => {
	if (!selectedSeasonId || !player.competitiveSeasons.some((season) => season.seasonId === selectedSeasonId)) {
		setSelectedSeasonId(defaultSeasonId);
	}
}, [defaultSeasonId, player.competitiveSeasons, selectedSeasonId]);
```

Inside the existing `expanded` block, add the panel after the two summary grids and before `LivePlayerHistory`:

```tsx
<div className="lg:col-span-2">
	<ActRankPanel
		player={player}
		assets={assets}
		selectedSeasonId={selectedSeasonId}
		onSeasonChange={setSelectedSeasonId}
	/>
</div>
```

The panel remains inside `{expanded && (...)}`, so its images and layout do not mount for collapsed rows. `selectedSeasonId` remains in `PlayerRow`, which stays mounted.

- [ ] **Step 4: Run JSON, unit, and build verification**

Run: `Get-Content -Raw src/i18n/locales/en.json | ConvertFrom-Json | Out-Null; Get-Content -Raw src/i18n/locales/ko.json | ConvertFrom-Json | Out-Null; Get-Content -Raw src/i18n/locales/zh-TW.json | ConvertFrom-Json | Out-Null`

Expected: exit code 0 with no JSON parse errors.

Run: `bun test src/components/live-game/act-rank.test.ts`

Expected: all tests pass.

Run: `bun run build:vite`

Expected: TypeScript and Vite build successfully.

- [ ] **Step 5: Commit the panel and integration**

```bash
git add src/components/live-game/act-rank-panel.tsx src/components/live-game/live-scout-table.tsx src/i18n/locales/en.json src/i18n/locales/ko.json src/i18n/locales/zh-TW.json
git commit -m "feat: show act ranks in expanded live players"
```

---

### Task 5: Verify Geometry, Responsiveness, And Full Build

**Files:**
- Modify if verification finds a defect: `src/components/live-game/act-rank-triangle.tsx`
- Modify if verification finds a defect: `src/components/live-game/act-rank-panel.tsx`
- Modify if verification finds a defect: `src/components/live-game/live-scout-table.tsx`

**Interfaces:**
- Consumes: completed feature and a live Riot roster with at least one player who has seasonal MMR data.
- Produces: build/test evidence and screenshots showing the expanded desktop and narrow layouts.

- [ ] **Step 1: Run the complete automated verification set**

Run: `bun test src/components/live-game/act-rank.test.ts`

Expected: all badge tests pass.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests pass.

Run: `bun run build:vite`

Expected: TypeScript and Vite production build passes.

- [ ] **Step 2: Start the application for visual verification**

Run: `bun run dev`

Expected: Tauri opens ValoUtils and Vite reports its local URL. Keep the process running until screenshots and interaction checks finish.

- [ ] **Step 3: Verify the expanded row at desktop width**

With the Riot Client signed in and a party, pregame, or active game visible:

1. Expand a player with competitive data.
2. Confirm the act panel appears between the summary/skins and recent history.
3. Confirm exactly the best nine tier tiles appear and align with the supplied border grid.
4. Switch to an older act and confirm the rank, RR, statistics, tiles, and border update together.
5. Collapse and reopen the row and confirm the selected act remains selected.
6. Capture a screenshot at approximately 1280 by 800.

- [ ] **Step 4: Verify narrow layout and accessibility**

Resize the app to its narrow supported width and confirm:

1. No horizontal overflow or overlapping text appears.
2. The triangle stays square and the statistics form two columns below it.
3. The selector works with keyboard focus and arrow keys.
4. Missing-season and unranked states show text instead of broken images.
5. Capture a screenshot at the narrow width.

- [ ] **Step 5: Re-run checks after any visual corrections**

Run the same three commands from Step 1 after adjusting only the three listed UI files. Expected: all tests and the build pass again.

- [ ] **Step 6: Commit verified layout corrections, if any**

```bash
git add src/components/live-game/act-rank-triangle.tsx src/components/live-game/act-rank-panel.tsx src/components/live-game/live-scout-table.tsx
git diff --cached --quiet || git commit -m "fix: align live act rank panel"
```

Do not create an empty commit when no visual corrections were needed.
