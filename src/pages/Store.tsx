import { PageHeader, SectionCard } from "@/components/section-card";
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
import { FaStore } from "react-icons/fa6";

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
	<span className="tabular-nums text-(--ink)">
		{formatAmount(price.amount)}
		{CURRENCY_LABEL[price.currency] && (
			<span className="ml-1 text-[11px] text-(--ink-faint)">{CURRENCY_LABEL[price.currency]}</span>
		)}
	</span>
);

/** A ticking timer. `seconds` is the value at fetch time; `since` anchors the tick. */
const Countdown = ({ seconds, since }: { seconds: number; since: number }) => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	const left = remainingSeconds(seconds, (now - since) / 1000);
	return <span className="tabular-nums text-xs text-(--ink-faint)">{formatCountdown(left)}</span>;
};

const ItemArt = ({ asset, className = "" }: { asset: SkinAsset | null; className?: string }) =>
	asset?.icon ? (
		<img src={asset.icon} alt={localize(asset.name)} className={`object-contain ${className}`} />
	) : (
		<div className={`flex items-center justify-center text-[10px] text-(--ink-faint) ${className}`}>
			{asset ? localize(asset.name) : "—"}
		</div>
	);

const Store = () => {
	const [data, setData] = useState<StoreData | null>(null);
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
	}, [t]);

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
			<PageHeader icon={<FaStore className="text-lg" />} title={t("store.title")}>
				{wallet && (
					<div className="flex shrink-0 items-center gap-4 text-sm">
						<span className="tabular-nums text-(--ink)">
							{formatAmount(wallet.valorantPoints)}
							<span className="ml-1 text-[11px] text-(--ink-faint)">VP</span>
						</span>
						<span className="tabular-nums text-(--ink)">
							{formatAmount(wallet.radianite)}
							<span className="ml-1 text-[11px] text-(--ink-faint)">RAD</span>
						</span>
						<span className="tabular-nums text-(--ink)">
							{formatAmount(wallet.kingdomCredits)}
							<span className="ml-1 text-[11px] text-(--ink-faint)">KC</span>
						</span>
					</div>
				)}
			</PageHeader>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
				{loading && (
					<div className="flex flex-1 items-center justify-center text-sm text-(--ink-faint)">
						{t("store.loading")}
					</div>
				)}

				{!loading && loginRequired && (
					<div className="flex flex-1 items-center justify-center">
						<div className="glass flex max-w-md flex-col items-center gap-2 p-6 text-center">
							<FaStore className="mb-1 text-3xl text-(--ink-faint)" />
							<p className="font-semibold text-(--ink)">{t("store.loginRequired")}</p>
							<p className="text-sm text-(--ink-faint)">{t("store.loginRequiredDesc")}</p>
						</div>
					</div>
				)}

				{!loading && error && !loginRequired && (
					<div className="glass rounded-lg px-4 py-3">
						<p className="text-sm font-semibold text-red-300">{t("store.failedToLoad")}</p>
						<p className="mt-0.5 text-xs text-(--ink-faint)">{error}</p>
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
											className="flex flex-col gap-2 rounded-lg border border-(--line) p-3"
										>
											<ItemArt asset={asset} className="h-16 w-full" />
											<div className="flex items-baseline justify-between gap-2">
												<span className="truncate text-sm text-(--ink)">
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
											className="h-32 w-full rounded-lg object-cover"
										/>
									) : null}
									<div className="flex items-baseline justify-between gap-3">
										<span className="truncate font-semibold text-(--ink)">
											{bundleArt ? localize(bundleArt.name) : t("store.featuredBundle")}
										</span>
										<span className="tabular-nums text-sm text-(--ink)">
											{data.featuredBundle.totalDiscounted < data.featuredBundle.totalBase && (
												<span className="mr-2 text-(--ink-faint) line-through">
													{formatAmount(data.featuredBundle.totalBase)}
												</span>
											)}
											{formatAmount(data.featuredBundle.totalDiscounted)}
											<span className="ml-1 text-[11px] text-(--ink-faint)">VP</span>
										</span>
									</div>
									<div className="flex flex-col gap-1">
										{data.featuredBundle.items.map((item) => {
											const asset = skins.get(item.itemId) ?? null;
											return (
												<div
													key={item.itemId}
													className="flex items-center gap-3 rounded border border-(--line) px-2 py-1.5"
												>
													<ItemArt asset={asset} className="h-8 w-16 shrink-0" />
													<span className="min-w-0 flex-1 truncate text-xs text-(--ink)">
														{asset ? localize(asset.name) : t("store.unknownItem")}
													</span>
													<span className="shrink-0 tabular-nums text-xs text-(--ink)">
														{item.discountedPrice < item.basePrice && (
															<span className="mr-1.5 text-(--ink-faint) line-through">
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
													className="flex h-28 flex-col items-center justify-center rounded-lg border border-dashed border-(--line) text-xs text-(--ink-faint)"
												>
													{t("store.hiddenCard")}
												</div>
											);
										}
										return (
											<div
												key={offer.offerId || offer.itemId}
												className="flex flex-col gap-2 rounded-lg border border-(--line) p-3"
											>
												<ItemArt asset={asset} className="h-12 w-full" />
												<span className="truncate text-xs text-(--ink)">
													{asset ? localize(asset.name) : t("store.unknownItem")}
												</span>
												<div className="flex items-baseline justify-between gap-2">
													<span className="tabular-nums text-xs text-(--ink)">
														<span className="mr-1.5 text-(--ink-faint) line-through">
															{formatAmount(offer.basePrice)}
														</span>
														{formatAmount(offer.discountedPrice)}
													</span>
													<span className="shrink-0 rounded bg-(--line) px-1.5 py-0.5 text-[10px] text-(--ink)">
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
												className="flex items-center gap-3 rounded border border-(--line) px-2 py-1.5"
											>
												<ItemArt asset={asset} className="h-8 w-8 shrink-0" />
												<span className="min-w-0 flex-1 truncate text-xs text-(--ink)">
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
