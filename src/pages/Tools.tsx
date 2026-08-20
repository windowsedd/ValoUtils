import { FriendProfile } from "@/components/friends/friend-profile";
import { PageHeader } from "@/components/section-card";
import Inventory from "@/pages/Inventory.tsx";
import type { Friend } from "@/types/friends";
import type { FriendProfileResponse } from "@/types/friend-profile";
import { acceptedFriendProfile } from "@/components/friends/friend-profile-state";
import { getTiers, type TierAsset } from "@/util/valorant-assets";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { FaMagnifyingGlass, FaWrench } from "react-icons/fa6";
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

const Tools = () => {
	const { t } = useTranslation();
	const [tool, setTool] = useState<"lookup" | "inventory">("lookup");
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

	return (
		<div className="flex h-full min-h-0 flex-col animate-fade-in">
			<PageHeader
				icon={<FaWrench />}
				title={t("tools.title")}
				subtitle={tool === "inventory" ? t("tools.inventory") : t("tools.subtitle")}
			>
				<div data-tools-switch="" className="flex rounded-sm border border-(--line)">
					{(
						[
							["lookup", t("tools.lookup")],
							["inventory", t("tools.inventory")],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							data-tool={value}
							onClick={() => setTool(value)}
							className={`h-8 px-2.5 text-xs ${
								tool === value ? "bg-white/8 text-(--ink)" : "text-(--ink-faint) hover:bg-white/6"
							}`}
						>
							{label}
						</button>
					))}
				</div>
			</PageHeader>
			{tool === "inventory" ? (
				<div data-tools-inventory="" className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pt-4">
					<Inventory embedded />
				</div>
			) : (
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
				<form data-tools-search="" onSubmit={onSearch} className="flex shrink-0 items-center gap-2">
					<label className="glass flex h-10 min-w-0 flex-1 items-center gap-2 px-3">
						<FaMagnifyingGlass className="shrink-0 text-xs text-gray-600" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("tools.searchPlaceholder")}
							aria-label={t("tools.searchPlaceholder")}
							className="min-w-0 flex-1 bg-transparent text-sm text-gray-200 outline-none placeholder:text-gray-600"
						/>
					</label>
					<button
						type="submit"
						disabled={searching}
						className="h-10 shrink-0 rounded-sm border border-(--line) px-3 text-sm text-gray-200 hover:bg-white/6 disabled:opacity-40"
					>
						{searching ? t("tools.searching") : t("tools.search")}
					</button>
				</form>
				{errorMessage && (
					<p className="shrink-0 text-sm text-red-300" role="status">
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
