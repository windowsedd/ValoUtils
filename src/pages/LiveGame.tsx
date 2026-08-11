import { LiveGameStatePanel } from "@/components/live-game/live-game-state-panel";
import { isCurrentStatsAttempt, liveStatsRequestKey } from "@/components/live-game/live-game-events";
import { LiveScoutTable } from "@/components/live-game/live-scout-table";
import { useLiveGameAssets } from "@/components/live-game/use-live-game-assets";
import { PageHeader } from "@/components/section-card";
import type { LiveGameResponse, LivePlayer, RecentStatsEvent, RecentStatsState } from "@/types/live-game";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaCrosshairs } from "react-icons/fa6";
import { useTranslation } from "react-i18next";

const POLL_MS = 5000;
const EMPTY_PLAYERS: LivePlayer[] = [];
type Snapshot = Extract<LiveGameResponse, { success: true }>;
type StatsCommandResponse =
	| { success: true; rosterKey: string; attemptId: number; count: number }
	| { success: false; rosterKey: string; attemptId: number; error: string };

const LiveGame = () => {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [recent, setRecent] = useState<Record<string, RecentStatsState>>({});
	const [error, setError] = useState<string | null>(null);
	const [loginRequired, setLoginRequired] = useState(false);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const rosterKeyRef = useRef<string | null>(null);
	const requestedStatsKeyRef = useRef<string | null>(null);
	const statsAttemptRef = useRef(0);

	const requestSnapshot = useCallback(() => {
		if (!window.Main) return;
		if (rosterKeyRef.current) setRefreshing(true);
		else setLoading(true);
		window.Main.send("live-game:fetch");
	}, []);
	const refreshSnapshot = useCallback(() => {
		requestedStatsKeyRef.current = null;
		requestSnapshot();
	}, [requestSnapshot]);

	useEffect(() => {
		if (!window.Main) return;

		const onSnapshot = (message: string) => {
			let response: LiveGameResponse;
			try {
				response = JSON.parse(message) as LiveGameResponse;
			} catch {
				setLoading(false);
				setRefreshing(false);
				setError(t("liveGame.failedToLoad"));
				return;
			}

			setLoading(false);
			setRefreshing(false);
			if (!response.success) {
				if ("code" in response && response.code === "loginRequired") {
					setLoginRequired(true);
					setError(null);
					return;
				}
				setError(("error" in response && response.error) || t("liveGame.failedToLoad"));
				return;
			}

			setLoginRequired(false);
			setError(null);
			setSnapshot(response);
			rosterKeyRef.current = response.state === "idle" ? null : response.rosterKey;

			if (response.state === "idle") {
				requestedStatsKeyRef.current = null;
				setRecent({});
				return;
			}

			const queueId = response.match?.queueId ?? "";
			const statsKey = liveStatsRequestKey(response.rosterKey, queueId);
			if (requestedStatsKeyRef.current !== statsKey) {
				requestedStatsKeyRef.current = statsKey;
				const attemptId = ++statsAttemptRef.current;
				setRecent(Object.fromEntries(response.players.map((player) => [player.puuid, { status: "loading" }])));
				window.Main.send("live-game:stats", response.rosterKey, response.players.map((player) => player.puuid), attemptId, queueId);
			}
		};

		const onPlayerStats = (message: string) => {
			try {
				const event = JSON.parse(message) as RecentStatsEvent;
				if (event.rosterKey !== rosterKeyRef.current || !isCurrentStatsAttempt(event.attemptId, statsAttemptRef.current)) return;
				setRecent((current) => ({
					...current,
					[event.puuid]: event.success
						? { status: "ready", stats: event.stats }
						: { status: "error", error: event.error },
				}));
			} catch {
				// Ignore malformed or unrelated push events; the next roster refresh can retry.
			}
		};

		const onStatsCommand = (message: string) => {
			try {
				const response = JSON.parse(message) as StatsCommandResponse;
				if (response.success || response.rosterKey !== rosterKeyRef.current || !isCurrentStatsAttempt(response.attemptId, statsAttemptRef.current)) return;
				setRecent((current) => Object.fromEntries(
					Object.entries(current).map(([puuid, state]) => [
						puuid,
						state.status === "loading" ? { status: "error", error: response.error } : state,
					]),
				));
			} catch {
				// The per-player event listener remains authoritative for valid responses.
			}
		};

		window.Main.on("live-game:fetch", onSnapshot);
		window.Main.on("live-game:stats", onStatsCommand);
		window.Main.on("live-game:player-stats", onPlayerStats);
		window.Main.send("live-game:fetch");
		const interval = window.setInterval(() => window.Main.send("live-game:fetch"), POLL_MS);
		return () => {
			window.clearInterval(interval);
			window.Main.removeListener("live-game:fetch", onSnapshot);
			window.Main.removeListener("live-game:stats", onStatsCommand);
			window.Main.removeListener("live-game:player-stats", onPlayerStats);
		};
	}, [t]);

	const players = snapshot?.players ?? EMPTY_PLAYERS;
	const assets = useLiveGameAssets(players);
	const activeSnapshot = useMemo(
		() => snapshot && snapshot.state !== "idle" ? snapshot : null,
		[snapshot],
	);

	return (
		<div className="h-full min-h-0 flex flex-col animate-fade-in motion-reduce:animate-none">
			<PageHeader icon={<FaCrosshairs className="text-[#ff4655] text-lg" />} title={t("liveGame.title")} />

			{loading && !snapshot && <LiveGameStatePanel kind="loading" />}
			{!loading && loginRequired && <LiveGameStatePanel kind="login" />}
			{!loading && !loginRequired && error && !snapshot && (
				<LiveGameStatePanel kind="error" detail={error} onRetry={requestSnapshot} />
			)}
			{!loading && !loginRequired && !error && snapshot?.state === "idle" && (
				<LiveGameStatePanel kind="idle" />
			)}
			{!loginRequired && activeSnapshot && (
				<LiveScoutTable
					snapshot={activeSnapshot}
					assets={assets}
					recent={recent}
					refreshing={refreshing}
					refreshError={error ?? undefined}
					onRefresh={refreshSnapshot}
				/>
			)}
		</div>
	);
};

export default LiveGame;
