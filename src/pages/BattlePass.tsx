import { LoginRequiredPanel } from "@/components/login-required-panel";
import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import {
	buildChapterViews,
	catalogFromContracts,
	currencyDisplayAmount,
	daysRemaining,
	nextLevelXp,
	pageIndexForLevel,
	passesOfKind,
	RADIANITE_UUID,
	selectBattlepassId,
	sortBattlepasses,
	totalLevels,
	type BattlepassCatalogEntry,
	type BattlepassKind,
	type BattlepassProgress,
	type BattlepassRewardView,
	type SeasonWindow,
} from "@/pages/battlepass/battlepass-state";
import {
	getBattlepassContracts,
	getBattlepassReward,
	getEventAssets,
	getSeasonAssets,
	localize,
	type EventAsset,
	type SeasonAsset,
	type SkinAsset,
} from "@/util/valorant-assets";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronLeft, LuChevronRight, LuLock, LuTicket } from "react-icons/lu";

type BattlepassResponse = {
	success: boolean;
	code?: string;
	error?: string;
	contracts?: BattlepassProgress[];
	premiumContractIds?: string[];
};

const RewardArt = ({ asset, className = "" }: { asset: SkinAsset | null; className?: string }) =>
	asset?.icon ? (
		<img src={asset.icon} alt={localize(asset.name)} className={`object-contain ${className}`} />
	) : (
		<div className={`flex items-center justify-center px-1 text-center text-[10px] text-(--text-muted) ${className}`}>
			{asset ? localize(asset.name) : "—"}
		</div>
	);

const RewardTile = ({
	view,
	asset,
	claimedLabel,
	lockedLabel,
	premiumLabel,
}: {
	view: BattlepassRewardView;
	asset: SkinAsset | null;
	claimedLabel: string;
	lockedLabel: string;
	premiumLabel: string;
}) => {
	const dimmed = view.status === "locked" || view.status === "premiumLocked";
	const name = asset ? localize(asset.name) : view.reward.type;
	const amount = currencyDisplayAmount(view.reward.uuid, view.reward.amount);
	const showAmount = view.reward.type.toLowerCase() === "currency" || amount > 1;
	/*
	 * Claimed and premium-locked used to be two near-identical grey glyphs, so
	 * "already yours" and "needs the premium pass" read the same at a glance.
	 * Colour separates them: earned is positive, paywalled is a warning, and a
	 * plain lock stays neutral for "not there yet".
	 */
	const status = {
		claimed: { icon: <LuCheck title={claimedLabel} />, tone: "text-(--signal-pos)" },
		premiumLocked: { icon: <LuLock title={premiumLabel} />, tone: "text-(--signal-warn)" },
		locked: { icon: <LuLock title={lockedLabel} />, tone: "text-(--text-muted)" },
	}[view.status as "claimed" | "premiumLocked" | "locked"];
	return (
		<div
			data-battlepass-reward={view.reward.uuid}
			data-status={view.status}
			className={`relative flex flex-col gap-2 rounded-[8px] border p-2.5 ${
				view.isCurrent
					? "border-(--accent-border) bg-(--accent-soft)"
					: view.status === "claimed"
						? "border-(--signal-pos)/25 bg-(--signal-pos)/5"
						: "border-(--line)"
			} ${dimmed ? "opacity-60" : ""}`}
		>
			{view.tier !== null && (
				<span className="absolute left-2 top-2 text-[10px] tabular-nums text-(--text-muted)">{view.tier}</span>
			)}
			<div className={`absolute right-2 top-2 text-[11px] ${status?.tone ?? "text-(--text-muted)"}`}>
				{status?.icon}
			</div>
			<RewardArt asset={asset} className="mt-4 h-14 w-full" />
			<div className="min-w-0">
				<p className="truncate text-xs text-(--text-primary)">{name}</p>
				{showAmount && (
					<p className="text-[10px] tabular-nums text-(--text-muted)">
						×{amount}
						{view.reward.uuid.toLowerCase() === RADIANITE_UUID ? " RAD" : ""}
					</p>
				)}
			</div>
		</div>
	);
};

const stepClass =
	"grid h-6 w-6 place-items-center rounded-[5px] border border-(--border) bg-(--control) text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-35";

const BattlePass = () => {
	const { t } = useTranslation();
	const [catalog, setCatalog] = useState<BattlepassCatalogEntry[]>([]);
	// Bumped when the login panel sees a Riot Client appear, so the fetch
	// below re-runs without the user having to leave and re-enter the page.
	const [reloadKey, setReloadKey] = useState(0);
	const [seasons, setSeasons] = useState<Map<string, SeasonAsset>>(new Map());
	const [events, setEvents] = useState<Map<string, EventAsset>>(new Map());
	const [progress, setProgress] = useState<BattlepassProgress[]>([]);
	const [premiumIds, setPremiumIds] = useState<string[]>([]);
	const [kind, setKind] = useState<BattlepassKind>("season");
	const [selectedByKind, setSelectedByKind] = useState<Record<BattlepassKind, string | null>>({
		season: null,
		event: null,
	});
	const [page, setPage] = useState(0);
	const [assets, setAssets] = useState<Map<string, SkinAsset | null>>(new Map());
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const [catalogReady, setCatalogReady] = useState(false);

	useEffect(() => {
		let cancelled = false;
		Promise.all([getBattlepassContracts(), getSeasonAssets(), getEventAssets()]).then(
			([contracts, seasonAssets, eventAssets]) => {
				if (cancelled) return;
				setCatalog(catalogFromContracts(contracts));
				setSeasons(seasonAssets);
				setEvents(eventAssets);
				setCatalogReady(true);
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!window.Main) return;
		const onResponse = (message: string) => {
			window.Main.removeAllListeners("battlepass:get");
			let response: BattlepassResponse;
			try {
				response = JSON.parse(message) as BattlepassResponse;
			} catch {
				setError(t("battlepass.failedToLoad"));
				setLoading(false);
				return;
			}
			if (!response.success) {
				if (response.code === "loginRequired") {
					setLoginRequired(true);
					setLoading(false);
					return;
				}
				setError(response.error ?? t("battlepass.failedToLoad"));
				setLoading(false);
				return;
			}
			// A retry got through — drop the signed-out state so the panel makes way
			// for the content instead of hiding a successful load behind it.
			setLoginRequired(false);
			setError(null);
			setProgress(response.contracts ?? []);
			setPremiumIds(response.premiumContractIds ?? []);
			setLoading(false);
		};
		window.Main.on("battlepass:get", onResponse);
		window.Main.send("analytics:track", "battlepass:view", JSON.stringify({}));
		window.Main.send("battlepass:get");
		return () => window.Main.removeAllListeners("battlepass:get");
	}, [t, reloadKey]);

	const seasonWindows: SeasonWindow[] = useMemo(
		() =>
			[...seasons].map(([id, season]) => ({
				id,
				startMillis: season.startMillis,
				endMillis: season.endMillis,
			})),
		[seasons],
	);
	const eventWindows: SeasonWindow[] = useMemo(
		() =>
			[...events].map(([id, event]) => ({
				id,
				startMillis: event.startMillis,
				endMillis: event.endMillis,
			})),
		[events],
	);
	const windows = kind === "season" ? seasonWindows : eventWindows;
	const passes = useMemo(
		() => sortBattlepasses(passesOfKind(catalog, kind), windows),
		[catalog, kind, windows],
	);
	const selectedId = selectedByKind[kind];

	useEffect(() => {
		const now = Date.now();
		setSelectedByKind((current) => {
			const next = { ...current };
			if (!next.season) {
				next.season = selectBattlepassId(
					sortBattlepasses(passesOfKind(catalog, "season"), seasonWindows),
					seasonWindows,
					now,
				);
			}
			if (!next.event) {
				next.event = selectBattlepassId(
					sortBattlepasses(passesOfKind(catalog, "event"), eventWindows),
					eventWindows,
					now,
				);
			}
			if (next.season === current.season && next.event === current.event) return current;
			return next;
		});
	}, [catalog, seasonWindows, eventWindows]);

	const entry = useMemo(
		() => passes.find((pass) => pass.id === selectedId) ?? null,
		[passes, selectedId],
	);
	const contract = progress.find((row) => row.id.toLowerCase() === (entry?.id ?? "").toLowerCase());
	const premium = premiumIds.some((id) => id.toLowerCase() === (entry?.id ?? "").toLowerCase());
	const level = contract?.level ?? 0;
	const xpTowardNext = contract?.xpTowardNext ?? 0;

	useEffect(() => {
		if (!entry) return;
		setPage(pageIndexForLevel(entry.chapters, level));
	}, [entry, level]);

	const chapter = entry?.chapters[page];
	const views = useMemo(
		() =>
			entry
				? buildChapterViews(entry.chapters, page, level, premium || !entry.premiumRequired)
				: { free: [], premium: [] },
		[entry, page, level, premium],
	);
	const visibleRewards = useMemo(() => [...views.free, ...views.premium], [views]);

	useEffect(() => {
		if (!visibleRewards.length) return;
		let cancelled = false;
		Promise.all(
			visibleRewards.map((view) =>
				getBattlepassReward(view.reward.type, view.reward.uuid).then(
					(asset) => [`${view.reward.type}:${view.reward.uuid}`, asset] as const,
				),
			),
		).then((entries) => {
			if (!cancelled) setAssets(new Map(entries));
		});
		return () => {
			cancelled = true;
		};
	}, [visibleRewards]);

	const levelsTotal = entry ? totalLevels(entry.chapters) : 0;
	const xpNeeded = entry ? nextLevelXp(entry.chapters, level) : 0;
	const complete = levelsTotal > 0 && level >= levelsTotal;
	const xpPercent = complete || xpNeeded <= 0 ? 100 : Math.min(100, Math.round((xpTowardNext / xpNeeded) * 100));
	const schedule =
		entry?.seasonId == null
			? undefined
			: kind === "season"
				? seasons.get(entry.seasonId.toLowerCase())
				: events.get(entry.seasonId.toLowerCase());
	const remaining = schedule ? daysRemaining(schedule.endMillis, Date.now()) : null;
	const chapterCount = entry?.chapters.length ?? 0;
	/** Chapter the player's level actually falls in, distinct from the one on screen. */
	const liveChapter = entry ? pageIndexForLevel(entry.chapters, level) : -1;
	const showPremiumBadge = Boolean(entry?.premiumRequired && premium);
	const waiting = loading || !catalogReady;

	return (
		<div className="flex h-full flex-col animate-fade-in">
			<PageHeader
				icon={<LuTicket className="text-lg" />}
				title={kind === "event" ? t("battlepass.kindEvent") : t("battlepass.title")}
				subtitle={entry ? localize(entry.name) : undefined}
			>
				<div className="flex items-center gap-2">
					<div data-battlepass-kind="" className="flex overflow-hidden rounded-[6px] border border-(--border)">
						{(
							[
								["season", t("battlepass.kindBattle")],
								["event", t("battlepass.kindEvent")],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								type="button"
								data-kind={value}
								onClick={() => setKind(value)}
								className={`h-8 px-2.5 text-[12px] transition-colors ${
									kind === value
										? "bg-(--accent-soft) text-(--accent-selected)"
										: "text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary)"
								}`}
							>
								{label}
							</button>
						))}
					</div>
					{passes.length > 0 && (
						<select
							aria-label={kind === "event" ? t("battlepass.selectEvent") : t("battlepass.selectPass")}
							value={selectedId ?? ""}
							onChange={(event) =>
								setSelectedByKind((current) => ({ ...current, [kind]: event.target.value }))
							}
							className="h-8 max-w-56 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[12px] text-(--text-primary) outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
						>
							{passes.map((pass) => (
								<option key={pass.id} value={pass.id}>
									{localize(pass.name)}
								</option>
							))}
						</select>
					)}
				</div>
			</PageHeader>

			<div className={pageBodyClass}>
				{loginRequired && (
					<LoginRequiredPanel
						onRetry={() => setReloadKey((key) => key + 1)}
						icon={<LuTicket />}
						title={t("battlepass.loginRequired")}
						description={t("battlepass.loginRequiredDesc")}
					/>
				)}

				{waiting && !loginRequired && !error && (
					<div className="flex flex-1 items-center justify-center text-sm text-(--text-muted)">
						{t("battlepass.loading")}
					</div>
				)}

				{!waiting && error && !loginRequired && (
					<div className="panel px-4 py-3">
						<p className="text-[12px] font-semibold text-(--signal-neg)">{t("battlepass.failedToLoad")}</p>
						<p className="mt-0.5 text-xs text-(--text-muted)">{error}</p>
					</div>
				)}

				{!waiting && !error && !loginRequired && !entry && (
					<div className="flex flex-1 items-center justify-center">
						<div className="panel flex max-w-md flex-col items-center gap-2 p-6 text-center">
							<LuTicket className="mb-1 text-3xl text-(--text-muted)" />
							<p className="font-semibold text-(--text-primary)">
								{kind === "event" ? t("battlepass.noEvent") : t("battlepass.noPass")}
							</p>
							<p className="text-sm text-(--text-muted)">
								{kind === "event" ? t("battlepass.noEventDesc") : t("battlepass.noPassDesc")}
							</p>
						</div>
					</div>
				)}

				{!waiting && !error && !loginRequired && entry && (
					<>
						<SectionCard
							title={t("battlepass.level")}
							right={
								<span className="flex items-center gap-2">
									{showPremiumBadge && (
										<span className="rounded-[5px] border border-(--accent-border) px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-(--accent-selected)">
											{t("battlepass.premium")}
										</span>
									)}
									{remaining !== null && (
										<span>
											{remaining <= 0
												? t("battlepass.ended")
												: remaining === 1
													? t("battlepass.endsToday")
													: t("battlepass.daysLeft", { count: remaining })}
										</span>
									)}
								</span>
							}
						>
							<div className="flex flex-col gap-2 px-3 py-2">
								<div className="flex items-baseline justify-between gap-3">
									<p className="text-sm font-semibold text-(--text-primary)">
										{t("battlepass.levelValue", { level: Math.min(level, levelsTotal), total: levelsTotal })}
									</p>
									<p className="text-xs tabular-nums text-(--text-muted)">
										{complete
											? t("battlepass.complete")
											: contract
												? t("battlepass.xpToNext", { current: xpTowardNext, needed: xpNeeded })
												: t("battlepass.notStarted")}
									</p>
								</div>
								<div className="h-1.5 overflow-hidden rounded-full bg-(--control)">
									<div className="h-full bg-(--accent)" style={{ width: `${xpPercent}%` }} />
								</div>
							</div>
						</SectionCard>

						<SectionCard
							title={
								entry.kind === "event"
									? t("battlepass.rewards")
									: chapter?.isEpilogue
										? t("battlepass.epilogue")
										: t("battlepass.page", { page: page + 1 })
							}
							right={
								chapterCount > 1 ? (
									<span className="flex items-center gap-1">
										<button
											type="button"
											data-battlepass-prev=""
											onClick={() => setPage((current) => Math.max(0, current - 1))}
											disabled={page === 0}
											aria-label={t("battlepass.prevChapter")}
											className={stepClass}
										>
											<LuChevronLeft className="h-3 w-3" />
										</button>
										<span className="min-w-16 text-center text-[11px] tabular-nums text-(--text-secondary)">
											{t("battlepass.chapterPosition", { page: page + 1, total: chapterCount })}
										</span>
										<button
											type="button"
											data-battlepass-next=""
											onClick={() => setPage((current) => Math.min(chapterCount - 1, current + 1))}
											disabled={page >= chapterCount - 1}
											aria-label={t("battlepass.nextChapter")}
											className={stepClass}
										>
											<LuChevronRight className="h-3 w-3" />
										</button>
									</span>
								) : undefined
							}
						>
							{chapterCount > 1 && (
								<div
									data-battlepass-pages=""
									className="flex flex-wrap gap-1.5 border-b border-(--line) px-2.5 pb-2.5 pt-1"
								>
									{entry.chapters.map((item, index) => {
										// Where the player actually is, as opposed to what they're
										// looking at — the old row only expressed the latter.
										const atLevel = liveChapter === index;
										const viewing = page === index;
										return (
											<button
												key={`${entry.id}-${index}`}
												type="button"
												data-current={atLevel ? "" : undefined}
												onClick={() => setPage(index)}
												title={atLevel ? t("battlepass.currentChapter") : undefined}
												className={`relative h-7 min-w-7 rounded-[6px] border px-2 text-[11px] tabular-nums transition-colors ${
													viewing
														? "border-(--accent-border) bg-(--accent-soft) text-(--accent-selected)"
														: "border-(--border) text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary)"
												}`}
											>
												{item.isEpilogue ? t("battlepass.epilogue") : index + 1}
												{atLevel && (
													<span
														aria-hidden="true"
														className="absolute -bottom-px left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full bg-(--signal-pos)"
													/>
												)}
											</button>
										);
									})}
								</div>
							)}

							<div className="flex flex-col gap-4 px-3 py-2">
								{views.free.length > 0 && (
									<div>
										<p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-(--text-muted)">
											{t("battlepass.freeTrack")}
										</p>
										<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
											{views.free.map((view) => (
												<RewardTile
													key={`free-${view.reward.uuid}`}
													view={view}
													asset={assets.get(`${view.reward.type}:${view.reward.uuid}`) ?? null}
													claimedLabel={t("battlepass.claimed")}
													lockedLabel={t("battlepass.locked")}
													premiumLabel={t("battlepass.premium")}
												/>
											))}
										</div>
									</div>
								)}
								<div>
									<p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-(--text-muted)">
										{entry.kind === "event"
											? t("battlepass.rewards")
											: chapter?.isEpilogue
												? t("battlepass.freeTrack")
												: t("battlepass.premiumTrack")}
									</p>
									<div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
										{views.premium.map((view) => (
											<RewardTile
												key={`premium-${view.tier}-${view.reward.uuid}`}
												view={view}
												asset={assets.get(`${view.reward.type}:${view.reward.uuid}`) ?? null}
												claimedLabel={t("battlepass.claimed")}
												lockedLabel={t("battlepass.locked")}
												premiumLabel={t("battlepass.premium")}
											/>
										))}
									</div>
								</div>
							</div>
						</SectionCard>
					</>
				)}
			</div>
		</div>
	);
};

export default BattlePass;
