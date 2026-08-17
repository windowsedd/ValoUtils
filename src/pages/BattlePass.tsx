import { PageHeader, SectionCard } from "@/components/section-card";
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
import { FaCheck, FaLock, FaTicket } from "react-icons/fa6";

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
		<div className={`flex items-center justify-center px-1 text-center text-[10px] text-(--ink-faint) ${className}`}>
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
	return (
		<div
			data-battlepass-reward={view.reward.uuid}
			data-status={view.status}
			className={`relative flex flex-col gap-2 rounded-lg border p-2.5 ${
				view.isCurrent ? "border-[#ff4655]/70 bg-white/4" : "border-(--line)"
			} ${dimmed ? "opacity-55" : ""}`}
		>
			{view.tier !== null && (
				<span className="absolute left-2 top-2 text-[10px] tabular-nums text-(--ink-faint)">{view.tier}</span>
			)}
			<div className="absolute right-2 top-2 text-[10px] text-(--ink-faint)">
				{view.status === "claimed" && <FaCheck title={claimedLabel} />}
				{view.status === "premiumLocked" && <FaLock title={premiumLabel} />}
				{view.status === "locked" && <FaLock title={lockedLabel} />}
			</div>
			<RewardArt asset={asset} className="mt-4 h-14 w-full" />
			<div className="min-w-0">
				<p className="truncate text-xs text-(--ink)">{name}</p>
				{showAmount && (
					<p className="text-[10px] tabular-nums text-(--ink-faint)">
						×{amount}
						{view.reward.uuid.toLowerCase() === RADIANITE_UUID ? " RAD" : ""}
					</p>
				)}
			</div>
		</div>
	);
};

const BattlePass = () => {
	const { t } = useTranslation();
	const [catalog, setCatalog] = useState<BattlepassCatalogEntry[]>([]);
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
			setProgress(response.contracts ?? []);
			setPremiumIds(response.premiumContractIds ?? []);
			setLoading(false);
		};
		window.Main.on("battlepass:get", onResponse);
		window.Main.send("analytics:track", "battlepass:view", JSON.stringify({}));
		window.Main.send("battlepass:get");
		return () => window.Main.removeAllListeners("battlepass:get");
	}, [t]);

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
	const showPremiumBadge = Boolean(entry?.premiumRequired && premium);
	const waiting = loading || !catalogReady;

	return (
		<div className="flex h-full flex-col animate-fade-in">
			<PageHeader
				icon={<FaTicket className="text-lg" />}
				title={kind === "event" ? t("battlepass.kindEvent") : t("battlepass.title")}
				subtitle={entry ? localize(entry.name) : undefined}
			>
				<div className="flex items-center gap-2">
					<div data-battlepass-kind="" className="flex rounded-sm border border-(--line)">
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
								className={`h-8 px-2.5 text-xs ${
									kind === value ? "bg-white/8 text-(--ink)" : "text-(--ink-faint) hover:bg-white/6"
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
							className="h-8 max-w-56 rounded-sm border border-(--line) bg-(--panel-raised) px-2 text-xs text-(--ink)"
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

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
				{loginRequired && (
					<div className="flex flex-1 items-center justify-center">
						<div className="glass flex max-w-md flex-col items-center gap-2 p-6 text-center">
							<FaTicket className="mb-1 text-3xl text-(--ink-faint)" />
							<p className="font-semibold text-(--ink)">{t("battlepass.loginRequired")}</p>
							<p className="text-sm text-(--ink-faint)">{t("battlepass.loginRequiredDesc")}</p>
						</div>
					</div>
				)}

				{waiting && !loginRequired && !error && (
					<div className="flex flex-1 items-center justify-center text-sm text-(--ink-faint)">
						{t("battlepass.loading")}
					</div>
				)}

				{!waiting && error && !loginRequired && (
					<div className="glass rounded-lg px-4 py-3">
						<p className="text-sm font-semibold text-red-300">{t("battlepass.failedToLoad")}</p>
						<p className="mt-0.5 text-xs text-(--ink-faint)">{error}</p>
					</div>
				)}

				{!waiting && !error && !loginRequired && !entry && (
					<div className="flex flex-1 items-center justify-center">
						<div className="glass flex max-w-md flex-col items-center gap-2 p-6 text-center">
							<FaTicket className="mb-1 text-3xl text-(--ink-faint)" />
							<p className="font-semibold text-(--ink)">
								{kind === "event" ? t("battlepass.noEvent") : t("battlepass.noPass")}
							</p>
							<p className="text-sm text-(--ink-faint)">
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
										<span className="rounded-sm border border-[#ff4655]/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#ff4655]">
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
									<p className="text-sm font-semibold text-(--ink)">
										{t("battlepass.levelValue", { level: Math.min(level, levelsTotal), total: levelsTotal })}
									</p>
									<p className="text-xs tabular-nums text-(--ink-faint)">
										{complete
											? t("battlepass.complete")
											: contract
												? t("battlepass.xpToNext", { current: xpTowardNext, needed: xpNeeded })
												: t("battlepass.notStarted")}
									</p>
								</div>
								<div className="h-1.5 overflow-hidden rounded-full bg-white/8">
									<div className="h-full bg-[#ff4655]" style={{ width: `${xpPercent}%` }} />
								</div>
							</div>
						</SectionCard>

						{entry.chapters.length > 1 && (
						<div data-battlepass-pages="" className="flex shrink-0 flex-wrap gap-1.5">
							{entry.chapters.map((item, index) => {
								const currentPage = pageIndexForLevel(entry.chapters, level) === index;
								return (
									<button
										key={`${entry.id}-${index}`}
										type="button"
										data-current={currentPage ? "" : undefined}
										onClick={() => setPage(index)}
										className={`h-8 min-w-8 rounded-sm border px-2 text-xs ${
											page === index
												? "border-[#ff4655]/70 bg-white/8 text-(--ink)"
												: "border-(--line) text-(--ink-faint) hover:bg-white/6"
										}`}
									>
										{item.isEpilogue ? t("battlepass.epilogue") : index + 1}
									</button>
								);
							})}
						</div>
						)}

						<SectionCard
							title={
								entry.kind === "event"
									? t("battlepass.rewards")
									: chapter?.isEpilogue
										? t("battlepass.epilogue")
										: t("battlepass.page", { page: page + 1 })
							}
						>
							<div className="flex flex-col gap-4 px-3 py-2">
								{views.free.length > 0 && (
									<div>
										<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-(--ink-dim)">
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
									<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-(--ink-dim)">
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
