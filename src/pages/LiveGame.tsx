import { LiveGameStatePanel } from "@/components/live-game/live-game-state-panel";
import { LiveEventLog } from "@/components/live-game/live-event-log";
import { useLiveGameSession } from "@/components/live-game/live-game-session";
import { LiveScoutTable } from "@/components/live-game/live-scout-table";
import { useLiveGameAssets } from "@/components/live-game/use-live-game-assets";
import { PageHeader } from "@/components/section-card";
import type { LivePlayer } from "@/types/live-game";
import { useMemo } from "react";
import { LuCrosshair } from "react-icons/lu";
import { useTranslation } from "react-i18next";

const EMPTY_PLAYERS: LivePlayer[] = [];

const LiveGame = () => {
	const { t } = useTranslation();
	const {
		snapshot,
		recent,
		error,
		loginRequired,
		loading,
		refreshing,
		requestSnapshot,
		refreshSnapshot,
	} = useLiveGameSession();

	const players = snapshot?.players ?? EMPTY_PLAYERS;
	const assets = useLiveGameAssets(players);
	const activeSnapshot = useMemo(
		() => snapshot && snapshot.state !== "idle" ? snapshot : null,
		[snapshot],
	);

	return (
		<div className="relative h-full min-h-0 flex flex-col animate-fade-in motion-reduce:animate-none">
			<PageHeader icon={<LuCrosshair className="text-lg" />} title={t("liveGame.title")} />

			{loading && (!snapshot || snapshot.state === "idle") && <LiveGameStatePanel kind="loading" />}
			{!loading && loginRequired && (
				<LiveGameStatePanel kind="login" onRetry={refreshSnapshot} />
			)}
			{!loading && !loginRequired && error && !snapshot && (
				<LiveGameStatePanel kind="error" detail={error} onRetry={requestSnapshot} />
			)}
			{!loading && !loginRequired && !error && snapshot?.state === "idle" && (
				<LiveGameStatePanel kind="idle" />
			)}
			{!loginRequired && activeSnapshot && (
				// One scroll for the summary and roster; the Events sidebar keeps its
				// own full-height column beside it instead of floating underneath.
				<div className="flex min-h-0 flex-1">
					<div className="min-w-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">
						<LiveScoutTable
							snapshot={activeSnapshot}
							assets={assets}
							recent={recent}
							refreshing={refreshing}
							refreshError={error ?? undefined}
							onRefresh={refreshSnapshot}
						/>
					</div>
					{(activeSnapshot.state === "pregame" || activeSnapshot.state === "coregame") && (
						<LiveEventLog events={activeSnapshot.events ?? []} players={players} agents={assets.agents} />
					)}
				</div>
			)}
		</div>
	);
};

export default LiveGame;
