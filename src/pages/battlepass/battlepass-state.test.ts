import { describe, expect, test } from "bun:test";
import {
	buildChapterViews,
	catalogFromContracts,
	chapterEndLevels,
	currencyDisplayAmount,
	currentSeasonId,
	daysRemaining,
	nextLevelXp,
	pageIndexForLevel,
	parseChapter,
	parseReward,
	passesOfKind,
	RADIANITE_UUID,
	selectBattlepassId,
	sortBattlepasses,
	totalLevels,
	type BattlepassCatalogEntry,
	type BattlepassChapter,
	type SeasonWindow,
} from "./battlepass-state";

const reward = (uuid: string): BattlepassChapter["levels"][number]["reward"] => ({
	type: "PlayerCard",
	uuid,
	amount: 1,
	highlighted: false,
});

const chapter = (count: number, extra?: Partial<BattlepassChapter>): BattlepassChapter => ({
	isEpilogue: false,
	levels: Array.from({ length: count }, (_, index) => ({
		xp: 1000 + index * 250,
		reward: reward(`tier-${index}`),
	})),
	freeRewards: [reward("free-1")],
	...extra,
});

const seasons: SeasonWindow[] = [
	{ id: "act-3", startMillis: 1_000, endMillis: 2_000 },
	{ id: "act-4", startMillis: 2_000, endMillis: 3_000 },
	{ id: "act-5", startMillis: 3_000, endMillis: 4_000 },
];

const pass = (
	id: string,
	seasonId: string,
	kind: BattlepassCatalogEntry["kind"] = "season",
): BattlepassCatalogEntry => ({
	id,
	name: id,
	icon: null,
	kind,
	seasonId,
	premiumRequired: kind === "season",
	chapters: [chapter(5)],
});

describe("battlepass catalog parsing", () => {
	test("drops rewards that are missing a type or uuid", () => {
		expect(parseReward({ type: "Spray" })).toBeNull();
		expect(parseReward({ uuid: "abc" })).toBeNull();
		expect(parseReward({ type: "Spray", uuid: "abc", amount: 2, isHighlighted: true })).toEqual({
			type: "Spray",
			uuid: "abc",
			amount: 2,
			highlighted: true,
		});
	});

	test("keeps Season and Event contracts in separate kinds", () => {
		const catalog = catalogFromContracts([
			{
				uuid: "bp-4",
				displayName: "Season 2026 // Act IV",
				displayIcon: "https://example/icon.png",
				content: {
					relationType: "Season",
					relationUuid: "act-4",
					premiumVPCost: 1000,
					chapters: [{ isEpilogue: false, levels: [{ xp: 0, reward: { type: "Spray", uuid: "s1" } }] }],
				},
			},
			{
				uuid: "event-lunar",
				displayName: "Lunar 2026 Event Pass",
				content: {
					relationType: "Event",
					relationUuid: "event-4",
					premiumVPCost: -1,
					chapters: [{ levels: [{ xp: 1000, reward: { type: "PlayerCard", uuid: "c1" } }] }],
				},
			},
			{
				uuid: "agent-gear",
				displayName: "Jett Gear",
				content: { relationType: "Agent", chapters: [{ levels: [{ reward: { type: "Spray", uuid: "s2" } }] }] },
			},
			{ uuid: "empty", displayName: "Empty", content: { relationType: "Season", chapters: [] } },
		]);
		expect(passesOfKind(catalog, "season").map((entry) => entry.id)).toEqual(["bp-4"]);
		expect(passesOfKind(catalog, "event").map((entry) => entry.id)).toEqual(["event-lunar"]);
		expect(catalog.find((entry) => entry.id === "bp-4")?.premiumRequired).toBe(true);
		expect(catalog.find((entry) => entry.id === "event-lunar")?.premiumRequired).toBe(false);
		expect(catalog[0]?.chapters[0]?.levels).toHaveLength(1);
	});

	test("reads chapter levels and free rewards", () => {
		const parsed = parseChapter({
			isEpilogue: true,
			levels: [
				{ xp: 36500, reward: { type: "Currency", uuid: RADIANITE_UUID, amount: 1 } },
				{ xp: 36500, reward: {} },
			],
			freeRewards: [{ type: "Title", uuid: "title-1" }],
		});
		expect(parsed.isEpilogue).toBe(true);
		expect(parsed.levels).toHaveLength(1);
		expect(parsed.freeRewards).toHaveLength(1);
		expect(parsed.levels[0]?.xp).toBe(36500);
	});
});

describe("current battlepass selection", () => {
	test("uses the act whose window contains now, exclusive of the end", () => {
		expect(currentSeasonId(seasons, 1_999)).toBe("act-3");
		expect(currentSeasonId(seasons, 2_000)).toBe("act-4");
		expect(currentSeasonId(seasons, 3_999)).toBe("act-5");
		expect(currentSeasonId(seasons, 4_000)).toBeNull();
	});

	test("selects the catalog pass for the live act", () => {
		const catalog = [pass("bp-3", "act-3"), pass("bp-4", "act-4")];
		expect(selectBattlepassId(catalog, seasons, 2_500)).toBe("bp-4");
	});

	test("falls back to the newest catalog pass when the live act has no contract yet", () => {
		const catalog = [pass("bp-3", "act-3"), pass("bp-4", "act-4")];
		expect(selectBattlepassId(catalog, seasons, 3_500)).toBe("bp-4");
	});

	test("sorts passes from newest act to oldest", () => {
		const catalog = [pass("bp-3", "act-3"), pass("bp-5", "act-5"), pass("bp-4", "act-4")];
		expect(sortBattlepasses(catalog, seasons).map((entry) => entry.id)).toEqual([
			"bp-5",
			"bp-4",
			"bp-3",
		]);
	});

	test("selects the live event pass without mixing in act battle passes", () => {
		const catalog = [
			pass("bp-4", "act-4"),
			pass("event-old", "act-3", "event"),
			pass("event-now", "act-4", "event"),
		];
		const events = passesOfKind(catalog, "event");
		expect(selectBattlepassId(events, seasons, 2_500)).toBe("event-now");
		expect(selectBattlepassId(passesOfKind(catalog, "season"), seasons, 2_500)).toBe("bp-4");
	});
});

describe("page and XP helpers", () => {
	const chapters = [chapter(5), chapter(5), chapter(5, { isEpilogue: true, freeRewards: [] })];

	test("counts flattened levels and chapter ends", () => {
		expect(totalLevels(chapters)).toBe(15);
		expect(chapterEndLevels(chapters)).toEqual([5, 10, 15]);
	});

	test("maps a reached level onto its chapter page", () => {
		expect(pageIndexForLevel(chapters, 0)).toBe(0);
		expect(pageIndexForLevel(chapters, 4)).toBe(0);
		expect(pageIndexForLevel(chapters, 5)).toBe(1);
		expect(pageIndexForLevel(chapters, 14)).toBe(2);
		expect(pageIndexForLevel(chapters, 20)).toBe(2);
	});

	test("reads the XP needed for the next unclaimed level", () => {
		expect(nextLevelXp(chapters, 0)).toBe(1000);
		expect(nextLevelXp(chapters, 1)).toBe(1250);
		expect(nextLevelXp(chapters, 5)).toBe(1000);
		expect(nextLevelXp(chapters, 15)).toBe(0);
	});

	test("treats a 1-stack radianite grant as 10 points", () => {
		expect(currencyDisplayAmount(RADIANITE_UUID, 1)).toBe(10);
		expect(currencyDisplayAmount(RADIANITE_UUID, 2)).toBe(2);
		expect(currencyDisplayAmount("other", 1)).toBe(1);
	});

	test("counts remaining days without going negative", () => {
		expect(daysRemaining(86_400_000, 0)).toBe(1);
		expect(daysRemaining(0, 1)).toBe(0);
	});
});

describe("chapter reward views", () => {
	const chapters = [chapter(5), chapter(5, { isEpilogue: true, freeRewards: [] })];

	test("marks claimed, current, and locked premium tiers when the pass is owned", () => {
		const { premium } = buildChapterViews(chapters, 0, 2, true);
		expect(premium.map((item) => item.status)).toEqual([
			"claimed",
			"claimed",
			"current",
			"locked",
			"locked",
		]);
		expect(premium[2]?.isCurrent).toBe(true);
		expect(premium[0]?.tier).toBe(1);
	});

	test("locks premium tiers behind the paid track even after they are earned", () => {
		const { premium } = buildChapterViews(chapters, 0, 2, false);
		expect(premium.map((item) => item.status)).toEqual([
			"premiumLocked",
			"premiumLocked",
			"premiumLocked",
			"locked",
			"locked",
		]);
		expect(premium[2]?.isCurrent).toBe(true);
	});

	test("unlocks free chapter rewards only after the chapter is finished", () => {
		const locked = buildChapterViews(chapters, 0, 4, true);
		expect(locked.free[0]?.status).toBe("locked");
		expect(locked.free[0]?.isCurrent).toBe(true);
		const claimed = buildChapterViews(chapters, 0, 5, true);
		expect(claimed.free[0]?.status).toBe("claimed");
	});

	test("treats epilogue tiers as a free track", () => {
		const { premium } = buildChapterViews(chapters, 1, 6, false);
		expect(premium[0]?.status).toBe("claimed");
		expect(premium[1]?.status).toBe("current");
		expect(premium[2]?.status).toBe("locked");
	});
});
