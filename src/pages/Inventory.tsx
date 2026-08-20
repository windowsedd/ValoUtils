import { PageHeader, SectionCard, SectionRow } from "@/components/section-card";
import { groupAccessories, resolveOwnedAccessories } from "@/pages/inventory/inventory-accessories";
import {
	resolveOwnedSkins,
	summarizeSkins,
	type SkinSummary,
} from "@/pages/inventory/inventory-skins";
import {
	filterInventory,
	INVENTORY_KINDS,
	sumSpend,
	type InventoryItem,
	type InventoryKind,
} from "@/pages/inventory/inventory-state";
import { getInventoryIndex, localize, type InventoryIndex, type SkinAsset } from "@/util/valorant-assets";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaBoxesStacked } from "react-icons/fa6";

type InventoryResponse = {
	success: boolean;
	code?: string;
	error?: string;
	items?: InventoryItem[];
};

const formatAmount = (amount: number) => amount.toLocaleString();

const ItemArt = ({ asset, className = "" }: { asset: SkinAsset | null; className?: string }) =>
	asset?.icon ? (
		<img src={asset.icon} alt={localize(asset.name)} className={`object-contain ${className}`} />
	) : (
		<div className={`flex items-center justify-center px-1 text-center text-[10px] text-(--ink-faint) ${className}`}>
			{asset ? localize(asset.name) : "—"}
		</div>
	);

const Inventory = ({ embedded = false }: { embedded?: boolean }) => {
	const [items, setItems] = useState<InventoryItem[]>([]);
	const [index, setIndex] = useState<InventoryIndex | null>(null);
	const [kind, setKind] = useState<"all" | InventoryKind>("all");
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const { t } = useTranslation();

	useEffect(() => {
		if (!window.Main) return;
		const onResponse = (message: string) => {
			window.Main.removeAllListeners("inventory:get");
			const response = JSON.parse(message) as InventoryResponse;
			if (!response.success) {
				if (response.code === "loginRequired") {
					setLoginRequired(true);
					setLoading(false);
					return;
				}
				setError(response.error ?? t("inventory.failedToLoad"));
				setLoading(false);
				return;
			}
			setItems(Array.isArray(response.items) ? response.items : []);
			setLoading(false);
		};
		window.Main.on("inventory:get", onResponse);
		window.Main.send("inventory:get");
		window.Main.send("analytics:track", "inventory:view");
		return () => window.Main.removeAllListeners("inventory:get");
	}, [t]);

	useEffect(() => {
		let cancelled = false;
		getInventoryIndex().then((next) => {
			if (!cancelled) setIndex(next);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const names = useMemo(() => {
		const map = new Map<string, string>();
		if (!index) return map;
		for (const [id, asset] of index.assets) {
			map.set(id, localize(asset.name));
		}
		return map;
	}, [index]);

	const skinSummary: SkinSummary | null = useMemo(() => {
		if (!index) return null;
		const owned = resolveOwnedSkins(items, index.skinsByItemId, index.passRewardIds);
		return summarizeSkins(owned, items, index.passRewardIds, index.themes);
	}, [index, items]);

	const accessoryGroups = useMemo(() => {
		if (!index) return [];
		return groupAccessories(resolveOwnedAccessories(items, index.accessoriesByItemId, index.passRewardIds));
	}, [index, items]);

	const visible = useMemo(
		() => filterInventory(items, kind, query, names),
		[items, kind, query, names],
	);
	const spend = useMemo(() => sumSpend(visible), [visible]);

	const filterLabel = (value: "all" | InventoryKind) =>
		value === "all" ? t("inventory.filterAll") : t(`inventory.filter.${value}`);

	const totals = skinSummary ? (
		<>
			<span className="tabular-nums text-(--ink)">
				{formatAmount(skinSummary.totalVp)}
				<span className="ml-1 text-[11px] text-(--ink-faint)">VP</span>
			</span>
			<span className="tabular-nums text-(--ink-faint)">
				{skinSummary.usd.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} USD
			</span>
		</>
	) : (
		<>
			<span className="tabular-nums text-(--ink)">
				{formatAmount(spend.valorantPoints)}
				<span className="ml-1 text-[11px] text-(--ink-faint)">VP</span>
			</span>
			<span className="tabular-nums text-(--ink)">
				{formatAmount(spend.kingdomCredits)}
				<span className="ml-1 text-[11px] text-(--ink-faint)">KC</span>
			</span>
		</>
	);

	return (
		<div className={`flex min-h-0 flex-1 flex-col ${embedded ? "" : "h-full animate-fade-in"}`}>
			{!embedded && (
				<PageHeader icon={<FaBoxesStacked className="text-lg" />} title={t("inventory.title")}>
					<div className="flex shrink-0 items-center gap-4 text-sm">{totals}</div>
				</PageHeader>
			)}

			<div className={`flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-6 ${embedded ? "" : "px-6"}`}>
				{loading && (
					<div className="flex flex-1 items-center justify-center text-sm text-(--ink-faint)">
						{t("inventory.loading")}
					</div>
				)}

				{!loading && loginRequired && (
					<div className="flex flex-1 items-center justify-center">
						<div className="glass flex max-w-md flex-col items-center gap-2 p-6 text-center">
							<FaBoxesStacked className="mb-1 text-3xl text-(--ink-faint)" />
							<p className="font-semibold text-(--ink)">{t("inventory.loginRequired")}</p>
							<p className="text-sm text-(--ink-faint)">{t("inventory.loginRequiredDesc")}</p>
						</div>
					</div>
				)}

				{!loading && error && !loginRequired && (
					<div className="glass rounded-lg px-4 py-3">
						<p className="text-sm font-semibold text-red-300">{t("inventory.failedToLoad")}</p>
						<p className="mt-0.5 text-xs text-(--ink-faint)">{error}</p>
					</div>
				)}

				{!loading && !error && !loginRequired && (
					<>
						{skinSummary && (
							<SectionCard title={t("inventory.skinList")} count={skinSummary.guns + skinSummary.knives}>
								<div className="flex flex-col px-1.5 py-1">
									<SectionRow>
										<span className="text-sm text-(--ink-dim)">{t("inventory.gunsKnives")}</span>
										<span className="tabular-nums text-sm text-(--ink)">
											{t("inventory.gunsKnivesValue", { guns: skinSummary.guns, knives: skinSummary.knives })}
										</span>
									</SectionRow>
									<SectionRow>
										<span className="text-sm text-(--ink-dim)">{t("inventory.totalValue")}</span>
										<span className="tabular-nums text-sm text-(--ink)">
											{formatAmount(skinSummary.totalVp)} VP
										</span>
									</SectionRow>
									<SectionRow>
										<span className="text-sm text-(--ink-dim)">{t("inventory.scope")}</span>
										<span className="text-sm text-(--ink)">{t("inventory.scopePurchased")}</span>
									</SectionRow>
									<SectionRow>
										<span className="text-sm text-(--ink-dim)">{t("inventory.breakdown")}</span>
										<span className="tabular-nums text-sm text-(--ink)">
											{t("inventory.breakdownValue", {
												total: skinSummary.inventoryCount,
												pass: skinSummary.passCount,
												bought: skinSummary.purchasedCount,
											})}
										</span>
									</SectionRow>
									<SectionRow>
										<span className="text-sm text-(--ink-dim)">{t("inventory.excludedRarity")}</span>
										<span className="text-sm text-(--ink)">{skinSummary.excludedRarity}</span>
									</SectionRow>
									<SectionRow>
										<span className="text-sm text-(--ink-dim)">{t("inventory.topUp")}</span>
										<span className="tabular-nums text-sm text-(--ink)">
											{skinSummary.usd.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} USD
											<span className="text-(--ink-faint)"> ｜ </span>
											{formatAmount(skinSummary.twd)} TWD
										</span>
									</SectionRow>
								</div>
								<p className="px-3 pb-2 text-[11px] text-(--ink-faint)">{t("inventory.listPriceNote")}</p>
							</SectionCard>
						)}

						{skinSummary && skinSummary.rarities.length > 0 && (
							<SectionCard title={t("inventory.rarity")}>
								{skinSummary.rarities.map((row) => (
									<SectionRow key={row.tier}>
										<span className="text-sm text-(--ink)">
											{row.tier}
											<span className="ml-2 text-(--ink-faint)">{row.count}</span>
										</span>
										<span className="tabular-nums text-sm text-(--ink)">{formatAmount(row.vp)} VP</span>
									</SectionRow>
								))}
							</SectionCard>
						)}

						{skinSummary && skinSummary.completeSets.length > 0 && (
							<SectionCard
								title={t("inventory.completeSets")}
								count={skinSummary.completeSets.length}
								right={
									<span className="tabular-nums">
										{formatAmount(skinSummary.completeSetsVp)} VP
									</span>
								}
							>
								{skinSummary.completeSets.map((set) => (
									<SectionRow key={set.id}>
										<span className="truncate text-sm text-(--ink)">{localize(set.name)}</span>
										<span className="shrink-0 tabular-nums text-sm text-(--ink)">
											{set.owned}/{set.total}
											<span className="ml-2 text-(--ink-faint)">{formatAmount(set.vp)} VP</span>
										</span>
									</SectionRow>
								))}
							</SectionCard>
						)}

						{skinSummary?.weaponGroups.map((group) => (
							<SectionCard
								key={group.weaponId}
								title={
									group.melee ? t("inventory.melee") : localize(group.weaponName)
								}
								count={group.skins.length}
								right={<span className="tabular-nums">{formatAmount(group.vp)} VP</span>}
							>
								{group.skins.map((skin) => (
									<SectionRow key={skin.skinId}>
										<span className="flex min-w-0 items-center gap-2">
											{skin.icon ? (
												<img src={skin.icon} alt="" className="h-6 w-10 shrink-0 object-contain" />
											) : null}
											<span className="truncate text-sm text-(--ink)">{localize(skin.name)}</span>
										</span>
										<span className="shrink-0 tabular-nums text-sm text-(--ink-faint)">
											{formatAmount(skin.vp)} VP
											{skin.tierName ? <span className="ml-2">{skin.tierName}</span> : null}
										</span>
									</SectionRow>
								))}
							</SectionCard>
						))}

						{accessoryGroups.map((group) => (
							<SectionCard
								key={group.kind}
								title={t(`inventory.filter.${group.kind}`)}
								count={group.items.length}
							>
								{group.items.map((row) => (
									<SectionRow key={row.parentId}>
										<span className="flex min-w-0 items-center gap-2">
											{row.icon ? (
												<img src={row.icon} alt="" className="h-6 w-6 shrink-0 object-contain" />
											) : null}
											<span className="truncate text-sm text-(--ink)">{localize(row.name)}</span>
										</span>
									</SectionRow>
								))}
							</SectionCard>
						))}

						<div className="flex flex-wrap items-center gap-2">
							<div data-inventory-filter="" className="flex flex-wrap rounded-sm border border-(--line)">
								{(["all", ...INVENTORY_KINDS] as const).map((value) => (
									<button
										key={value}
										type="button"
										data-kind={value}
										onClick={() => setKind(value)}
										className={`h-8 px-2.5 text-xs ${
											kind === value ? "bg-white/8 text-(--ink)" : "text-(--ink-faint) hover:bg-white/6"
										}`}
									>
										{filterLabel(value)}
									</button>
								))}
							</div>
							<label className="flex min-h-8 min-w-40 flex-1 items-center gap-2 rounded-sm border border-(--line) bg-(--ground) px-2.5 text-(--ink-faint) focus-within:border-(--signal-focus)/50">
								<input
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder={t("inventory.searchPlaceholder")}
									aria-label={t("inventory.search")}
									className="min-w-0 flex-1 bg-transparent text-sm text-(--ink) outline-none placeholder:text-(--ink-faint)"
								/>
							</label>
						</div>

						<SectionCard
							title={t("inventory.items")}
							count={visible.length}
							right={
								<span className="text-(--ink-faint)">
									{t("inventory.totalSpend")}
								</span>
							}
						>
							{visible.length === 0 ? (
								<div className="px-3 py-8 text-center text-sm text-(--ink-faint)">
									{t("inventory.empty")}
								</div>
							) : (
								<div className="grid grid-cols-2 gap-2 px-2 py-2 sm:grid-cols-3">
									{visible.map((item) => {
										const asset = index?.assets.get(item.itemId.toLowerCase()) ?? null;
										const name = asset ? localize(asset.name) : t("inventory.unknownItem");
										return (
											<div
												key={`${item.kind}:${item.itemId}`}
												data-inventory-item={item.itemId}
												data-kind={item.kind}
												className="flex flex-col gap-2 rounded-lg border border-(--line) p-2.5"
											>
												<ItemArt asset={asset} className="h-14 w-full" />
												<div className="flex items-baseline justify-between gap-2">
													<span className="truncate text-xs text-(--ink)">{name}</span>
													{item.price && item.price.amount > 0 ? (
														<span className="shrink-0 tabular-nums text-[11px] text-(--ink-faint)">
															{formatAmount(item.price.amount)}{" "}
															{item.price.currency === "kingdomCredits"
																? "KC"
																: item.price.currency === "radianite"
																	? "RAD"
																	: "VP"}
														</span>
													) : (
														<span className="shrink-0 text-[11px] text-(--ink-faint)">
															{t("inventory.unpriced")}
														</span>
													)}
												</div>
											</div>
										);
									})}
								</div>
							)}
						</SectionCard>
					</>
				)}
			</div>
		</div>
	);
};

export default Inventory;
