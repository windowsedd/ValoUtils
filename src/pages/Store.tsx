import { LoginRequiredPanel } from "@/components/login-required-panel";
import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import {
	getBundle,
	getSkinLevel,
	getStoreItem,
	localize,
	type BundleAsset,
	type SkinAsset,
} from "@/util/valorant-assets";
import { formatCountdown, remainingSeconds } from "@/util/store-countdown";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { LuStore } from "react-icons/lu";

type Currency = "valorantPoints" | "radianite" | "kingdomCredits" | "unknown";
type Price = { amount: number; currency: Currency };

type DailyOffer = { offerId: string; itemId: string; price: Price };
type BundleItem = {
	itemId: string;
	itemTypeId: string;
	amount: number;
	basePrice: number;
	discountedPrice: number;
	discountPercent: number;
	isPromo: boolean;
};
type FeaturedBundle = {
	bundleId: string;
	dataAssetId: string;
	remainingSeconds: number;
	items: BundleItem[];
	totalBase: number;
	totalDiscounted: number;
};
type NightMarketOffer = {
	offerId: string;
	itemId: string;
	basePrice: number;
	discountedPrice: number;
	discountPercent: number;
	isSeen: boolean;
};
type AccessoryOffer = {
	offerId: string;
	itemId: string;
	itemTypeId: string;
	amount: number;
	price: Price;
};

type StoreData = {
	wallet: { valorantPoints: number; radianite: number; kingdomCredits: number };
	daily: { remainingSeconds: number; offers: DailyOffer[] };
	featuredBundle: FeaturedBundle | null;
	nightMarket: { remainingSeconds: number; offers: NightMarketOffer[] } | null;
	accessory: { remainingSeconds: number; offers: AccessoryOffer[] } | null;
};

const CURRENCY_LABEL: Record<Currency, string> = {
	valorantPoints: "VP",
	radianite: "RAD",
	kingdomCredits: "KC",
	unknown: "",
};

const formatAmount = (amount: number) => amount.toLocaleString();

/** Keep already-resolved art. A later skin-level 404 must not wipe a buddy. */
const mergeAssets = (
	previous: Map<string, SkinAsset | null>,
	entries: ReadonlyArray<readonly [string, SkinAsset | null]>,
) => {
	const next = new Map(previous);
	for (const [id, asset] of entries) {
		if (asset) next.set(id, asset);
	}
	return next;
};

const PriceTag = ({ price }: { price: Price }) => (
	<span className="tabular-nums text-(--text-primary)">
		{formatAmount(price.amount)}
		{CURRENCY_LABEL[price.currency] && (
			<span className="ml-1 text-[11px] text-(--text-muted)">{CURRENCY_LABEL[price.currency]}</span>
		)}
	</span>
);

/*
 * One ticker for every clock on the page.
 *
 * Each Countdown used to own a `setInterval`, so a store with four shops ran
 * four timers — and because they started whenever their section mounted, they
 * ticked at four different moments and the page never rolled over as one.
 */
const secondListeners = new Set<() => void>();
let secondTimer: ReturnType<typeof setInterval> | null = null;

const useSharedSecond = () => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const tick = () => setNow(Date.now());
		secondListeners.add(tick);
		secondTimer ??= setInterval(() => {
			for (const listener of secondListeners) listener();
		}, 1000);
		return () => {
			secondListeners.delete(tick);
			if (secondListeners.size === 0 && secondTimer) {
				clearInterval(secondTimer);
				secondTimer = null;
			}
		};
	}, []);
	return now;
};

/** A ticking timer. `seconds` is the value at fetch time; `since` anchors the tick. */
const Countdown = ({ seconds, since }: { seconds: number; since: number }) => {
	const { t } = useTranslation();
	const now = useSharedSecond();
	const left = remainingSeconds(seconds, (now - since) / 1000);
	return (
		<span className="flex items-baseline gap-1.5">
			{/* Bare "14:22:07" reads as a duration with no subject. */}
			<span className="text-[10px] uppercase tracking-widest text-(--text-muted)">
				{t("store.resetsIn")}
			</span>
			<span className="tabular-nums text-[11px] text-(--text-secondary)">{formatCountdown(left)}</span>
		</span>
	);
};

const ItemArt = ({ asset, className = "" }: { asset: SkinAsset | null; className?: string }) =>
	asset?.icon ? (
		<img src={asset.icon} alt={localize(asset.name)} className={`object-contain ${className}`} />
	) : (
		<div className={`flex items-center justify-center text-[10px] text-(--text-muted) ${className}`}>
			{asset ? localize(asset.name) : "—"}
		</div>
	);

const Store = () => {
	const [data, setData] = useState<StoreData | null>(null);
	// Bumped when the login panel sees a Riot Client appear, so the fetch
	// below re-runs without the user having to leave and re-enter the page.
	const [reloadKey, setReloadKey] = useState(0);
	const [fetchedAt, setFetchedAt] = useState(() => Date.now());
	const [skins, setSkins] = useState<Map<string, SkinAsset | null>>(new Map());
	const [bundleArt, setBundleArt] = useState<BundleAsset | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const { t } = useTranslation();

	useEffect(() => {
		if (!window.Main) return;
		const onResponse = (message: string) => {
			window.Main.removeAllListeners("store:get");
			const response = JSON.parse(message);
			if (!response.success) {
				if (response.code === "loginRequired") {
					setLoginRequired(true);
					setLoading(false);
					return;
				}
				setError(response.error ?? t("store.failedToLoad"));
				setLoading(false);
				return;
			}
			// A retry got through — drop the signed-out state so the panel makes way
			// for the content instead of hiding a successful load behind it.
			setLoginRequired(false);
			setError(null);
			setData({
				wallet: response.wallet,
				daily: response.daily,
				featuredBundle: response.featuredBundle ?? null,
				nightMarket: response.nightMarket ?? null,
				accessory: response.accessory ?? null,
			});
			setFetchedAt(Date.now());
			setLoading(false);
		};
		window.Main.on("store:get", onResponse);
		window.Main.send("store:get");
		return () => window.Main.removeAllListeners("store:get");
	}, [t, reloadKey]);

	// Daily + Night Market rows are always weapon skin levels.
	const skinLevelIds = useMemo(() => {
		if (!data) return [] as string[];
		const ids = [
			...data.daily.offers.map((offer) => offer.itemId),
			...(data.nightMarket?.offers ?? []).map((offer) => offer.itemId),
		];
		return [...new Set(ids.filter(Boolean))];
	}, [data]);

	useEffect(() => {
		if (!skinLevelIds.length) return;
		let cancelled = false;
		Promise.all(skinLevelIds.map((id) => getSkinLevel(id).then((asset) => [id, asset] as const))).then(
			(entries) => {
				if (!cancelled) setSkins((previous) => mergeAssets(previous, entries));
			},
		);
		return () => {
			cancelled = true;
		};
	}, [skinLevelIds]);

	// Featured bundles and the kingdom shelf mix types (skins, buddies, cards,
	// flex). Resolve by itemTypeId so those uuids are not sent to /skinlevels.
	useEffect(() => {
		const jobs = [
			...(data?.accessory?.offers ?? []).map((offer) => ({
				itemTypeId: offer.itemTypeId,
				itemId: offer.itemId,
			})),
			...(data?.featuredBundle?.items ?? []).map((item) => ({
				itemTypeId: item.itemTypeId,
				itemId: item.itemId,
			})),
		].filter((job) => job.itemId);
		if (!jobs.length) return;
		let cancelled = false;
		Promise.all(
			jobs.map((job) =>
				getStoreItem(job.itemTypeId, job.itemId).then((asset) => [job.itemId, asset] as const),
			),
		).then((entries) => {
			if (!cancelled) setSkins((previous) => mergeAssets(previous, entries));
		});
		return () => {
			cancelled = true;
		};
	}, [data?.accessory, data?.featuredBundle]);

	useEffect(() => {
		const id = data?.featuredBundle?.dataAssetId;
		if (!id) return;
		let cancelled = false;
		getBundle(id).then((asset) => {
			if (!cancelled) setBundleArt(asset);
		});
		return () => {
			cancelled = true;
		};
	}, [data?.featuredBundle?.dataAssetId]);

	const wallet = data?.wallet;

	return (
		<div className="flex h-full flex-col animate-fade-in">
			<PageHeader icon={<LuStore className="text-lg" />} title={t("store.title")}>
				{wallet && (
					<div className="flex shrink-0 items-center gap-1.5">
						{(
							[
								[wallet.valorantPoints, "VP"],
								[wallet.radianite, "RAD"],
								[wallet.kingdomCredits, "KC"],
							] as const
						).map(([amount, label]) => (
							<span
								key={label}
								className="flex items-baseline gap-1 rounded-[5px] border border-(--border) bg-(--control) px-2 py-0.5"
							>
								<span className="text-[12px] font-medium tabular-nums text-(--text-primary)">
									{formatAmount(amount)}
								</span>
								<span className="text-[10px] tracking-wide text-(--text-muted)">{label}</span>
							</span>
						))}
					</div>
				)}
			</PageHeader>

			<div className={pageBodyClass}>
				{loading && (
					<div className="flex flex-1 items-center justify-center text-sm text-(--text-muted)">
						{t("store.loading")}
					</div>
				)}

				{!loading && loginRequired && (
					<LoginRequiredPanel
						onRetry={() => setReloadKey((key) => key + 1)}
						icon={<LuStore />}
						title={t("store.loginRequired")}
						description={t("store.loginRequiredDesc")}
					/>
				)}

				{!loading && error && !loginRequired && (
					<div className="panel px-4 py-3">
						<p className="text-[12px] font-semibold text-(--signal-neg)">{t("store.failedToLoad")}</p>
						<p className="mt-0.5 text-xs text-(--text-muted)">{error}</p>
					</div>
				)}

				{!loading && !error && !loginRequired && data && (
					<>
						<SectionCard
							title={t("store.dailyOffers")}
							count={data.daily.offers.length}
							right={<Countdown seconds={data.daily.remainingSeconds} since={fetchedAt} />}
						>
							<div className="grid grid-cols-2 gap-3 px-3 py-2">
								{data.daily.offers.map((offer) => {
									const asset = skins.get(offer.itemId) ?? null;
									return (
										<div
											key={offer.offerId || offer.itemId}
											className="flex flex-col gap-2 rounded-[8px] border border-(--line) bg-(--panel-raised) p-3"
										>
											<ItemArt asset={asset} className="h-20 w-full" />
											<div className="flex items-baseline justify-between gap-2 border-t border-(--line) pt-2">
												<span className="truncate text-[12px] text-(--text-primary)">
													{asset ? localize(asset.name) : t("store.unknownItem")}
												</span>
												<PriceTag price={offer.price} />
											</div>
										</div>
									);
								})}
							</div>
						</SectionCard>

						{data.featuredBundle && (
							<SectionCard
								title={t("store.featuredBundle")}
								right={<Countdown seconds={data.featuredBundle.remainingSeconds} since={fetchedAt} />}
							>
								<div className="flex flex-col gap-3 px-3 py-2">
									{bundleArt?.verticalPromo || bundleArt?.icon ? (
										<img
											src={bundleArt.verticalPromo ?? bundleArt.icon ?? ""}
											alt={localize(bundleArt.name)}
											className="h-40 w-full rounded-[8px] object-cover"
										/>
									) : null}
									<div className="flex items-baseline justify-between gap-3">
										<span className="truncate text-[13px] font-semibold text-(--text-primary)">
											{bundleArt ? localize(bundleArt.name) : t("store.featuredBundle")}
										</span>
										<span className="tabular-nums text-sm text-(--text-primary)">
											{data.featuredBundle.totalDiscounted < data.featuredBundle.totalBase && (
												<span className="mr-2 text-(--text-muted) line-through">
													{formatAmount(data.featuredBundle.totalBase)}
												</span>
											)}
											{formatAmount(data.featuredBundle.totalDiscounted)}
											<span className="ml-1 text-[11px] text-(--text-muted)">VP</span>
										</span>
									</div>
									<div className="flex flex-col gap-1">
										{data.featuredBundle.items.map((item) => {
											const asset = skins.get(item.itemId) ?? null;
											return (
												<div
													key={item.itemId}
													className="flex items-center gap-3 rounded-[6px] border border-(--line) bg-(--panel-raised) px-2 py-1.5"
												>
													<ItemArt asset={asset} className="h-8 w-16 shrink-0" />
													<span className="min-w-0 flex-1 truncate text-xs text-(--text-primary)">
														{asset ? localize(asset.name) : t("store.unknownItem")}
													</span>
													<span className="shrink-0 tabular-nums text-xs text-(--text-primary)">
														{item.discountedPrice < item.basePrice && (
															<span className="mr-1.5 text-(--text-muted) line-through">
																{formatAmount(item.basePrice)}
															</span>
														)}
														{formatAmount(item.discountedPrice)}
													</span>
												</div>
											);
										})}
									</div>
								</div>
							</SectionCard>
						)}

						{data.nightMarket && (
							<SectionCard
								title={t("store.nightMarket")}
								count={data.nightMarket.offers.length}
								right={<Countdown seconds={data.nightMarket.remainingSeconds} since={fetchedAt} />}
							>
								<div className="grid grid-cols-3 gap-3 px-3 py-2">
									{data.nightMarket.offers.map((offer) => {
										const asset = skins.get(offer.itemId) ?? null;
										// An unflipped card stays face-down here too — revealing it
										// in the app would spoil the in-game reveal.
										if (!offer.isSeen) {
											return (
												<div
													key={offer.offerId || offer.itemId}
													className="flex h-32 flex-col items-center justify-center rounded-[8px] border border-dashed border-(--line) text-[11px] text-(--text-muted)"
												>
													{t("store.hiddenCard")}
												</div>
											);
										}
										return (
											<div
												key={offer.offerId || offer.itemId}
												className="flex flex-col gap-2 rounded-[8px] border border-(--line) bg-(--panel-raised) p-3"
											>
												<ItemArt asset={asset} className="h-16 w-full" />
												<span className="truncate text-xs text-(--text-primary)">
													{asset ? localize(asset.name) : t("store.unknownItem")}
												</span>
												<div className="flex items-baseline justify-between gap-2">
													<span className="tabular-nums text-xs text-(--text-primary)">
														<span className="mr-1.5 text-(--text-muted) line-through">
															{formatAmount(offer.basePrice)}
														</span>
														{formatAmount(offer.discountedPrice)}
													</span>
													<span className="shrink-0 rounded-[5px] border border-(--signal-pos)/30 bg-(--signal-pos)/10 px-1.5 py-0.5 text-[10px] font-medium text-(--signal-pos)">
														−{offer.discountPercent}%
													</span>
												</div>
											</div>
										);
									})}
								</div>
							</SectionCard>
						)}

						{data.accessory && (
							<SectionCard
								title={t("store.accessoryStore")}
								count={data.accessory.offers.length}
								right={<Countdown seconds={data.accessory.remainingSeconds} since={fetchedAt} />}
							>
								<div className="flex flex-col gap-1 px-3 py-2">
									{data.accessory.offers.map((offer) => {
										const asset = skins.get(offer.itemId) ?? null;
										return (
											<div
												key={offer.offerId || offer.itemId}
												className="flex items-center gap-3 rounded-[6px] border border-(--line) bg-(--panel-raised) px-2 py-1.5"
											>
												<ItemArt asset={asset} className="h-8 w-8 shrink-0" />
												<span className="min-w-0 flex-1 truncate text-xs text-(--text-primary)">
													{asset ? localize(asset.name) : t("store.unknownItem")}
												</span>
												<PriceTag price={offer.price} />
											</div>
										);
									})}
								</div>
							</SectionCard>
						)}
					</>
				)}
			</div>
		</div>
	);
};

export default Store;
