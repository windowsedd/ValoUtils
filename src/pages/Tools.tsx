import { reportIpcError } from "@/util/ipc";
import { invoke } from "@tauri-apps/api/core";
import { FriendProfile } from "@/components/friends/friend-profile";
import { PageHeader, PageTabs } from "@/components/section-card";
import Inventory from "@/pages/Inventory.tsx";
import type { Friend } from "@/types/friends";
import type { FriendProfileResponse } from "@/types/friend-profile";
import { acceptedFriendProfile } from "@/components/friends/friend-profile-state";
import { getTiers, type TierAsset } from "@/util/valorant-assets";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuBoxes, LuCheck, LuCrosshair, LuLayoutGrid, LuLink, LuChevronRight, LuSearch, LuUserSearch, LuWrench } from "react-icons/lu";
import { CrosshairGenerator } from "./tools/crosshair-generator";
import { Button } from "@/components/ui/button";
import { hasSharedCrosshair, hasSharedPlayer, onSharedPlayer, playerLink, takeSharedPlayer } from "@/util/deep-links";
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
type ToolId = "lookup" | "inventory" | "crosshair";

const Tools = () => {
	const { t } = useTranslation();
	/** null = the index grid. valoutils:// links open a tool directly. */
	const [tool, setTool] = useState<ToolId | null>(() =>
		hasSharedCrosshair() ? "crosshair" : hasSharedPlayer() ? "lookup" : null,
	);
	useEffect(() => {
		const onOpen = (event: Event) => {
			const requested = (event as CustomEvent<{ tool?: ToolId }>).detail?.tool;
			if (requested) setTool(requested);
		};
		window.addEventListener("valoutils:tools-open", onOpen);
		return () => window.removeEventListener("valoutils:tools-open", onOpen);
	}, []);
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

	const onProfile = useCallback((message: any) => {
			setState((current) => {
				const target = current.pendingPlayer;
				if (!target) return current;
				let response: FriendProfileResponse;
				try {
					response = message as FriendProfileResponse;
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
		}, []);

const onResolved = useCallback((message: any) => {
			let response: {
				success: boolean;
				code?: string;
				puuid?: string;
				gameName?: string;
				tagLine?: string;
			};
			try {
				response = message;
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
			invoke<any>("friend_profile_get", { args: [response.puuid] }).then(onProfile).catch(error => onProfile({ success: false, error: String(error) }));
		}, [onProfile]);

	useEffect(() => {
	}, []);

	const lookup = (value: string) => {
		setState((current) => beginToolsLookup(current));
		invoke("analytics_track", { args: ["tools:player:lookup", JSON.stringify({})] }).catch(reportIpcError);
		invoke<any>("tools_player_resolve", { args: [value] }).then(onResolved).catch(error => onResolved({ success: false, error: String(error) }));
	};

	const onSearch = (event: FormEvent) => {
		event.preventDefault();
		lookup(query.trim());
	};

	// A valoutils://player link fills the search and runs it.
	const lookupRef = useRef(lookup);
	lookupRef.current = lookup;
	useEffect(() => {
		const run = () => {
			const shared = takeSharedPlayer();
			if (!shared) return;
			setTool("lookup");
			setQuery(shared);
			lookupRef.current(shared);
		};
		run();
		return onSharedPlayer(run);
	}, []);

	const [linkCopied, setLinkCopied] = useState(false);
	useEffect(() => {
		if (!linkCopied) return;
		const timer = setTimeout(() => setLinkCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [linkCopied]);

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
		{
			id: "crosshair",
			icon: <LuCrosshair />,
			title: t("tools.crosshair"),
			description: t("tools.crosshairDesc"),
		},
	];
	const openTool = catalog.find((entry) => entry.id === tool);

	return (
		<div className="flex h-full min-h-0 flex-col animate-fade-in">
			<PageHeader
				icon={openTool ? openTool.icon : <LuWrench className="text-lg" />}
				title={openTool ? openTool.title : t("tools.title")}
				subtitle={openTool ? openTool.description : t("tools.subtitle")}
				tabs={
					<PageTabs
						label={t("tools.title")}
						tabs={[
							{ id: "all" as const, label: t("tools.allTools"), icon: <LuLayoutGrid /> },
							...catalog.map((entry) => ({ id: entry.id, label: entry.title, icon: entry.icon })),
						]}
						value={tool ?? "all"}
						onChange={(id) => setTool(id === "all" ? null : id)}
					/>
				}
			/>

			{!openTool && (
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-6">
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
								className="group flex flex-col items-start gap-2 rounded-[12px] border border-(--border) bg-(--surface) p-4 text-left transition-colors hover:border-(--accent-border) hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
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

			{tool === "crosshair" && <CrosshairGenerator />}

			{tool === "inventory" && (
				<div data-tools-inventory="" className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pt-5">
					<Inventory embedded />
				</div>
			)}

			{tool === "lookup" && (
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pt-5 pb-6">
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
						<div className="mb-2 flex justify-end">
							<Button
								size="sm"
								variant="outline"
								title={t("tools.playerLinkHint")}
								onClick={() => {
									const player = state.player!;
									invoke("clipboard_set", { args: [playerLink(`${player.gameName}#${player.tagLine}`)] }).catch(reportIpcError);
									invoke("analytics_track", { args: ["tools:player-link"] }).catch(reportIpcError);
									setLinkCopied(true);
								}}
							>
								{linkCopied ? <LuCheck className="text-(--signal-pos)" /> : <LuLink />}
								{linkCopied ? t("settings.copied") : t("tools.copyPlayerLink")}
							</Button>
						</div>
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
