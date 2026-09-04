import { FriendProfile } from "@/components/friends/friend-profile";
import { PageHeader } from "@/components/section-card";
import Inventory from "@/pages/Inventory.tsx";
import type { Friend } from "@/types/friends";
import type { FriendProfileResponse } from "@/types/friend-profile";
import { acceptedFriendProfile } from "@/components/friends/friend-profile-state";
import { getTiers, type TierAsset } from "@/util/valorant-assets";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowLeft, LuBoxes, LuChevronRight, LuSearch, LuUserSearch, LuWrench } from "react-icons/lu";
import {
	applyToolsProfileError,
	applyToolsProfileSuccess,
	applyToolsResolveError,
	applyToolsResolveSuccess,
	beginToolsLookup,
	initialToolsLookupState,
	type ToolsLookupErrorCode,
	type ToolsResolvedPlayer,
} from "./tools/tools-lookup-state";

const resolveCodes = [
	"invalidInput",
	"playerNotFound",
	"loginRequired",
	"unavailable",
] as const;

const asLookupCode = (code: unknown): ToolsLookupErrorCode =>
	resolveCodes.includes(code as ToolsLookupErrorCode)
		? (code as ToolsLookupErrorCode)
		: "unavailable";

const asFriend = (player: ToolsResolvedPlayer): Friend => ({
	puuid: player.puuid,
	gameName: player.gameName,
	tagLine: player.tagLine,
	displayName: `${player.gameName}#${player.tagLine}`,
	region: "",
	note: "",
	lastOnline: null,
	state: "",
	product: "",
	isOnline: false,
	playing: false,
	valorant: null,
});

/**
 * Tools is a container, not a screen — the two things it holds share nothing but
 * a header. So it opens on an index of what's here and lets a tool take the whole
 * page once picked, which also leaves an obvious slot for the third tool rather
 * than a switch that has to grow a segment every time.
 */
type ToolId = "lookup" | "inventory";

const Tools = () => {
	const { t } = useTranslation();
	/** null = the index grid. */
	const [tool, setTool] = useState<ToolId | null>(null);
	const [query, setQuery] = useState("");
	const [state, setState] = useState(initialToolsLookupState);
	const [tiers, setTiers] = useState<Map<number, TierAsset>>(new Map());

	useEffect(() => {
		let cancelled = false;
		getTiers().then((assets) => !cancelled && setTiers(assets));
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!window.Main) return;
		const onResolved = (message: string) => {
			let response: {
				success: boolean;
				code?: string;
				puuid?: string;
				gameName?: string;
				tagLine?: string;
			};
			try {
				response = JSON.parse(message);
			} catch {
				setState((current) => applyToolsResolveError(current, "unavailable"));
				return;
			}
			if (!response.success || !response.puuid || !response.gameName || !response.tagLine) {
				setState((current) => applyToolsResolveError(current, asLookupCode(response.code)));
				return;
			}
			setState((current) =>
				applyToolsResolveSuccess(current, {
					puuid: response.puuid!,
					gameName: response.gameName!,
					tagLine: response.tagLine!,
				}),
			);
			window.Main.send("friend:profile:get", response.puuid);
		};
		const onProfile = (message: string) => {
			setState((current) => {
				const target = current.pendingPlayer;
				if (!target) return current;
				let response: FriendProfileResponse;
				try {
					response = JSON.parse(message) as FriendProfileResponse;
				} catch {
					return applyToolsProfileError(current, "unavailable");
				}
				const accepted = acceptedFriendProfile(target.puuid, response);
				if (accepted) return applyToolsProfileSuccess(current, accepted);
				if (!response.success) {
					return applyToolsProfileError(
						current,
						response.code === "loginRequired" ? "loginRequired" : "unavailable",
					);
				}
				return current;
			});
		};
		window.Main.on("tools:player:resolve", onResolved);
		window.Main.on("friend:profile:get", onProfile);
		return () => {
			window.Main.removeListener("tools:player:resolve", onResolved);
			window.Main.removeListener("friend:profile:get", onProfile);
		};
	}, []);

	const onSearch = (event: FormEvent) => {
		event.preventDefault();
		const value = query.trim();
		setState((current) => beginToolsLookup(current));
		window.Main.send("analytics:track", "tools:player:lookup", JSON.stringify({}));
		window.Main.send("tools:player:resolve", value);
	};

	const errorMessage = state.error ? t(`tools.${state.error}`) : null;
	const searching = state.status === "resolving" || state.status === "loadingProfile";

	const catalog: Array<{ id: ToolId; icon: ReactNode; title: string; description: string }> = [
		{
			id: "lookup",
			icon: <LuUserSearch />,
			title: t("tools.lookup"),
			description: t("tools.lookupDesc"),
		},
		{
			id: "inventory",
			icon: <LuBoxes />,
			title: t("tools.inventory"),
			description: t("tools.inventoryDesc"),
		},
	];
	const openTool = catalog.find((entry) => entry.id === tool);

	return (
		<div className="flex h-full min-h-0 flex-col animate-fade-in">
			<PageHeader
				icon={openTool ? openTool.icon : <LuWrench className="text-lg" />}
				title={openTool ? openTool.title : t("tools.title")}
				subtitle={openTool ? undefined : t("tools.subtitle")}
			>
				{openTool && (
					<button
						type="button"
						data-tools-back=""
						onClick={() => setTool(null)}
						className="flex h-8 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[12px] font-medium text-(--text-primary) transition-colors hover:bg-(--surface-hover)"
					>
						<LuArrowLeft className="h-3 w-3" />
						{t("tools.allTools")}
					</button>
				)}
			</PageHeader>

			{!openTool && (
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
					<div
						data-tools-grid=""
						className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]"
					>
						{catalog.map((entry) => (
							<button
								key={entry.id}
								type="button"
								data-tool={entry.id}
								onClick={() => setTool(entry.id)}
								className="group flex flex-col items-start gap-2 rounded-[10px] border border-(--border) bg-(--surface) p-4 text-left transition-colors hover:border-(--accent-border) hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
							>
								<span className="grid h-9 w-9 place-items-center rounded-[10px] border border-(--accent-border) bg-(--accent-soft) text-[17px] text-(--accent-selected)">
									{entry.icon}
								</span>
								<span className="flex w-full items-center gap-1.5">
									<span className="text-[13px] font-semibold text-(--text-primary)">{entry.title}</span>
									<LuChevronRight className="ml-auto h-3 w-3 shrink-0 text-(--text-muted) transition-colors group-hover:text-(--accent-selected)" />
								</span>
								<span className="text-[11px] leading-4 text-(--text-muted)">{entry.description}</span>
							</button>
						))}
					</div>
				</div>
			)}

			{tool === "inventory" && (
				<div data-tools-inventory="" className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pt-4">
					<Inventory embedded />
				</div>
			)}

			{tool === "lookup" && (
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
				<form data-tools-search="" onSubmit={onSearch} className="flex shrink-0 items-center gap-2">
					<label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-(--border) bg-(--control) px-2.5 focus-within:border-(--accent) focus-within:shadow-[0_0_0_2px_var(--accent-soft)]">
						<LuSearch className="shrink-0 text-[13px] text-(--text-muted)" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("tools.searchPlaceholder")}
							aria-label={t("tools.searchPlaceholder")}
							className="min-w-0 flex-1 bg-transparent text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-muted)"
						/>
					</label>
					<button
						type="submit"
						disabled={searching}
						className="h-8 shrink-0 rounded-[6px] border border-(--accent-border) bg-(--accent-soft) px-3 text-[12px] font-medium text-(--accent-selected) transition-colors hover:bg-(--accent-soft-hover) disabled:cursor-not-allowed disabled:opacity-40"
					>
						{searching ? t("tools.searching") : t("tools.search")}
					</button>
				</form>
				{errorMessage && (
					<p className="shrink-0 text-[12px] text-(--signal-neg)" role="status">
						{errorMessage}
					</p>
				)}
				{state.player && state.profile && (
					<div data-tools-profile="" className="min-h-0 flex-1 overflow-y-auto">
						<FriendProfile
							key={state.player.puuid}
							embedded
							friend={asFriend(state.player)}
							tiers={tiers}
							presenceLabel=""
							cachedProfile={state.profile}
							onProfileLoaded={() => undefined}
						/>
					</div>
				)}
			</div>
			)}
		</div>
	);
};

export default Tools;
