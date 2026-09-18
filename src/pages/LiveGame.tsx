import { LiveGameStatePanel } from "@/components/live-game/live-game-state-panel";
import { LiveEventLog } from "@/components/live-game/live-event-log";
import { isCurrentStatsAttempt, livePlayerStatsKey, liveStatsRequestKey, playersNeedingLiveStats, shouldRequestLiveStats } from "@/components/live-game/live-game-events";
import { LiveScoutTable } from "@/components/live-game/live-scout-table";
import { useLiveGameAssets } from "@/components/live-game/use-live-game-assets";
import { PageHeader } from "@/components/section-card";
import type { LiveGameResponse, LivePlayer, RecentStatsEvent, RecentStatsState } from "@/types/live-game";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuCrosshair } from "react-icons/lu";
import { useTranslation } from "react-i18next";

const POLL_MS = 5000;
// Idle means VALORANT is not running — the client puts you in a party of one the
// moment it is. Nothing can change until it launches, so stop asking so often.
const IDLE_POLL_MS = 15000;
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
	const pollDelayRef = useRef(POLL_MS);
	const statsThrottledRef = useRef(false);
	const recentRef = useRef(recent);
	recentRef.current = recent;

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
				const responseError = ("error" in response && response.error) || "";
				setError(responseError === "rateLimited"
					? t("liveGame.rateLimited")
					: responseError === "unavailable" ? t("liveGame.failedToLoad") : responseError || t("liveGame.failedToLoad"));
				return;
			}

			setLoginRequired(false);
			setError(response.warning === "rateLimited"
				? t("liveGame.rateLimited", { seconds: response.retryInSeconds ?? 60 })
				: response.warning === "unavailable" ? t("liveGame.failedToLoad") : null);
			setSnapshot(response);
			rosterKeyRef.current = response.state === "idle" ? null : response.rosterKey;
			pollDelayRef.current = response.state === "idle" ? IDLE_POLL_MS : POLL_MS;

			if (response.state === "idle") {
				requestedStatsKeyRef.current = null;
				setRecent({});
				return;
			}

			const queueId = response.match?.queueId ?? "";
			const statsKey = liveStatsRequestKey(response.players.map((player) => player.puuid), queueId);
			// A throttled attempt would otherwise leave the column dead for the whole
			// match: stats are only re-requested when the roster key changes, and it
			// does not. Once Riot stops refusing, ask for the missing ones again.
			if (statsThrottledRef.current && response.warning !== "rateLimited") {
				statsThrottledRef.current = false;
				requestedStatsKeyRef.current = null;
			}
			if (!shouldRequestLiveStats(response.warning)) {
				statsThrottledRef.current = true;
			} else if (requestedStatsKeyRef.current !== statsKey) {
				const puuids = response.players.map((player) => player.puuid);
				const needed = playersNeedingLiveStats(puuids, recentRef.current);
				requestedStatsKeyRef.current = statsKey;
				setRecent((current) => Object.fromEntries(response.players.map((player) => {
					const playerKey = livePlayerStatsKey(player.puuid);
					const existing = current[playerKey];
					return [
						playerKey,
						existing?.status === "ready" ? existing : { status: "loading" },
					];
				})));
				if (needed.length === 0) return;
				const attemptId = ++statsAttemptRef.current;
				window.Main.send("live-game:stats", statsKey, needed, attemptId, queueId);
			}
		};

		const onPlayerStats = (message: string) => {
			try {
				const event = JSON.parse(message) as RecentStatsEvent;
				if (event.rosterKey !== requestedStatsKeyRef.current || !isCurrentStatsAttempt(event.attemptId, statsAttemptRef.current)) return;
				if (!event.success && event.error === "rateLimited") statsThrottledRef.current = true;
				setRecent((current) => {
					const playerKey = livePlayerStatsKey(event.puuid);
					if (!event.success && current[playerKey]?.status === "ready") return current;
					return {
						...current,
						[playerKey]: event.success
							? { status: "ready", stats: event.stats }
							: { status: "error", error: event.error },
					};
				});
			} catch {
				// Ignore malformed or unrelated push events; the next roster refresh can retry.
			}
		};

		const onStatsCommand = (message: string) => {
			try {
				const response = JSON.parse(message) as StatsCommandResponse;
				if (response.success || response.rosterKey !== requestedStatsKeyRef.current || !isCurrentStatsAttempt(response.attemptId, statsAttemptRef.current)) return;
				if (response.error === "rateLimited") statsThrottledRef.current = true;
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

		// A hidden window has nobody reading the roster, and every poll it skips is
		// a round of Riot requests saved. Becoming visible again refreshes at once.
		let timer = 0;
		const poll = () => {
			if (!document.hidden) window.Main.send("live-game:fetch");
			timer = window.setTimeout(poll, pollDelayRef.current);
		};
		const onVisibility = () => {
			if (document.hidden) return;
			window.clearTimeout(timer);
			poll();
		};

		window.Main.on("live-game:fetch", onSnapshot);
		window.Main.on("live-game:stats", onStatsCommand);
		window.Main.on("live-game:player-stats", onPlayerStats);
		document.addEventListener("visibilitychange", onVisibility);
		poll();
		return () => {
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
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
		<div className="relative h-full min-h-0 flex flex-col animate-fade-in motion-reduce:animate-none">
			<PageHeader icon={<LuCrosshair className="text-lg" />} title={t("liveGame.title")} />

			{loading && !snapshot && <LiveGameStatePanel kind="loading" />}
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
				<LiveScoutTable
					snapshot={activeSnapshot}
					assets={assets}
					recent={recent}
					refreshing={refreshing}
					refreshError={error ?? undefined}
					onRefresh={refreshSnapshot}
				/>
			)}
			{!loginRequired && activeSnapshot && (activeSnapshot.state === "pregame" || activeSnapshot.state === "coregame") && (
				<LiveEventLog events={activeSnapshot.events ?? []} players={players} agents={assets.agents} />
			)}
		</div>
	);
};

export default LiveGame;
