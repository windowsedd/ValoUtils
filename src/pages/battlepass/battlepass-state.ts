import type { Localized } from "@/util/valorant-assets";

export const RADIANITE_UUID = "e59aa87c-4cbf-517a-5983-6e81511be9b7";
export const KINGDOM_UUID = "85ca954a-41f2-ce94-9b45-8ca3dd39a00d";
export const VP_UUID = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";

export type BattlepassKind = "season" | "event";
export type BattlepassTrack = "free" | "premium";
export type BattlepassRewardStatus = "claimed" | "current" | "locked" | "premiumLocked";

export type BattlepassReward = {
	type: string;
	uuid: string;
	amount: number;
	highlighted: boolean;
};

export type BattlepassLevel = {
	xp: number;
	reward: BattlepassReward;
};

export type BattlepassChapter = {
	isEpilogue: boolean;
	levels: BattlepassLevel[];
	freeRewards: BattlepassReward[];
};

export type BattlepassCatalogEntry = {
	id: string;
	name: Localized;
	icon: string | null;
	kind: BattlepassKind;
	seasonId: string | null;
	premiumRequired: boolean;
	chapters: BattlepassChapter[];
};

export type BattlepassProgress = {
	id: string;
	level: number;
	xpTowardNext: number;
	totalXp: number;
};

export type SeasonWindow = {
	id: string;
	startMillis: number;
	endMillis: number;
};

export type BattlepassRewardView = {
	reward: BattlepassReward;
	status: BattlepassRewardStatus;
	isCurrent: boolean;
	tier: number | null;
};

export const parseReward = (value: {
	type?: unknown;
	uuid?: unknown;
	amount?: unknown;
	isHighlighted?: unknown;
}): BattlepassReward | null => {
	const type = typeof value.type === "string" ? value.type : "";
	const uuid = typeof value.uuid === "string" ? value.uuid : "";
	if (!type || !uuid) return null;
	const amount = typeof value.amount === "number" && Number.isFinite(value.amount) ? value.amount : 1;
	return {
		type,
		uuid,
		amount,
		highlighted: value.isHighlighted === true,
	};
};

export const catalogFromContracts = (data: readonly unknown[]): BattlepassCatalogEntry[] => {
	const catalog: BattlepassCatalogEntry[] = [];
	for (const contract of data) {
		if (!contract || typeof contract !== "object") continue;
		const row = contract as {
			uuid?: unknown;
			displayName?: unknown;
			displayIcon?: unknown;
			content?: {
				relationType?: unknown;
				relationUuid?: unknown;
				chapters?: unknown;
				premiumVPCost?: unknown;
			};
		};
		const relation = row.content?.relationType;
		const kind: BattlepassKind | null =
			relation === "Season" ? "season" : relation === "Event" ? "event" : null;
		if (!kind) continue;
		const id = typeof row.uuid === "string" ? row.uuid : "";
		if (!id) continue;
		const chapters = Array.isArray(row.content?.chapters)
			? row.content.chapters.map((chapter) =>
					parseChapter((chapter && typeof chapter === "object" ? chapter : {}) as Parameters<typeof parseChapter>[0]),
				)
			: [];
		if (chapters.length === 0) continue;
		const premiumCost =
			typeof row.content?.premiumVPCost === "number" ? row.content.premiumVPCost : 0;
		catalog.push({
			id,
			name: (row.displayName as Localized) ?? id,
			icon: typeof row.displayIcon === "string" ? row.displayIcon : null,
			kind,
			seasonId: typeof row.content?.relationUuid === "string" ? row.content.relationUuid : null,
			premiumRequired: premiumCost > 0,
			chapters,
		});
	}
	return catalog;
};

export const parseChapter = (value: {
	isEpilogue?: unknown;
	levels?: unknown;
	freeRewards?: unknown;
}): BattlepassChapter => {
	const levels = Array.isArray(value.levels)
		? value.levels.flatMap((level) => {
				if (!level || typeof level !== "object") return [];
				const row = level as { xp?: unknown; reward?: unknown };
				const reward =
					row.reward && typeof row.reward === "object"
						? parseReward(row.reward as Parameters<typeof parseReward>[0])
						: null;
				if (!reward) return [];
				const xp = typeof row.xp === "number" && Number.isFinite(row.xp) ? row.xp : 0;
				return [{ xp, reward }];
			})
		: [];
	const freeRewards = Array.isArray(value.freeRewards)
		? value.freeRewards.flatMap((reward) => {
				if (!reward || typeof reward !== "object") return [];
				const parsed = parseReward(reward as Parameters<typeof parseReward>[0]);
				return parsed ? [parsed] : [];
			})
		: [];
	return {
		isEpilogue: value.isEpilogue === true,
		levels,
		freeRewards,
	};
};

export const currentSeasonId = (seasons: readonly SeasonWindow[], now: number): string | null => {
	const match = seasons.find((season) => now >= season.startMillis && now < season.endMillis);
	return match?.id ?? null;
};

export const passesOfKind = (
	catalog: readonly BattlepassCatalogEntry[],
	kind: BattlepassKind,
): BattlepassCatalogEntry[] => catalog.filter((entry) => entry.kind === kind);

export const sortBattlepasses = (
	catalog: readonly BattlepassCatalogEntry[],
	seasons: readonly SeasonWindow[],
): BattlepassCatalogEntry[] => {
	const start = new Map(seasons.map((season) => [season.id.toLowerCase(), season.startMillis]));
	return [...catalog].sort((a, b) => {
		const aStart = start.get((a.seasonId ?? "").toLowerCase()) ?? 0;
		const bStart = start.get((b.seasonId ?? "").toLowerCase()) ?? 0;
		if (aStart !== bStart) return bStart - aStart;
		return a.id.localeCompare(b.id);
	});
};

export const selectBattlepassId = (
	catalog: readonly BattlepassCatalogEntry[],
	seasons: readonly SeasonWindow[],
	now: number,
): string | null => {
	const seasonId = currentSeasonId(seasons, now);
	if (seasonId) {
		const current = catalog.find(
			(entry) => (entry.seasonId ?? "").toLowerCase() === seasonId.toLowerCase(),
		);
		if (current) return current.id;
	}
	return sortBattlepasses(catalog, seasons)[0]?.id ?? null;
};

export const totalLevels = (chapters: readonly BattlepassChapter[]): number =>
	chapters.reduce((sum, chapter) => sum + chapter.levels.length, 0);

export const chapterEndLevels = (chapters: readonly BattlepassChapter[]): number[] => {
	const ends: number[] = [];
	let reached = 0;
	for (const chapter of chapters) {
		reached += chapter.levels.length;
		ends.push(reached);
	}
	return ends;
};

export const pageIndexForLevel = (chapters: readonly BattlepassChapter[], level: number): number => {
	if (chapters.length === 0) return 0;
	const ends = chapterEndLevels(chapters);
	const index = ends.findIndex((end) => level < end);
	if (index >= 0) return index;
	return chapters.length - 1;
};

export const nextLevelXp = (chapters: readonly BattlepassChapter[], level: number): number => {
	let index = 0;
	for (const chapter of chapters) {
		for (const row of chapter.levels) {
			if (index === level) return row.xp;
			index += 1;
		}
	}
	return 0;
};

export const currencyDisplayAmount = (uuid: string, amount: number): number => {
	if (uuid.toLowerCase() === RADIANITE_UUID && amount === 1) return 10;
	return amount;
};

export const daysRemaining = (endMillis: number, now: number): number =>
	Math.max(0, Math.ceil((endMillis - now) / 86_400_000));

const premiumLevelStatus = (
	reached: number,
	tierIndex: number,
	premium: boolean,
	freeTrack: boolean,
): { status: BattlepassRewardStatus; isCurrent: boolean } => {
	const isCurrent = tierIndex === reached;
	if (freeTrack || premium) {
		if (tierIndex < reached) return { status: "claimed", isCurrent };
		if (isCurrent) return { status: "current", isCurrent };
		return { status: "locked", isCurrent };
	}
	if (tierIndex < reached) return { status: "premiumLocked", isCurrent };
	if (isCurrent) return { status: "premiumLocked", isCurrent };
	return { status: "locked", isCurrent };
};

export const buildChapterViews = (
	chapters: readonly BattlepassChapter[],
	pageIndex: number,
	reached: number,
	premium: boolean,
): { free: BattlepassRewardView[]; premium: BattlepassRewardView[] } => {
	const chapter = chapters[pageIndex];
	if (!chapter) return { free: [], premium: [] };
	const ends = chapterEndLevels(chapters);
	const start = pageIndex === 0 ? 0 : ends[pageIndex - 1]!;
	const end = ends[pageIndex]!;
	const freeUnlocked = reached >= end;
	const free: BattlepassRewardView[] = chapter.freeRewards.map((reward) => ({
		reward,
		status: freeUnlocked ? "claimed" : "locked",
		isCurrent: !freeUnlocked && reached >= start && reached < end,
		tier: null,
	}));
	const premiumViews: BattlepassRewardView[] = chapter.levels.map((level, offset) => {
		const tierIndex = start + offset;
		const { status, isCurrent } = premiumLevelStatus(
			reached,
			tierIndex,
			premium,
			chapter.isEpilogue,
		);
		return {
			reward: level.reward,
			status,
			isCurrent,
			tier: tierIndex + 1,
		};
	});
	return { free, premium: premiumViews };
};
