import { isCurrentStatsAttempt, livePlayerStatsKey, liveStatsRequestKey, playersNeedingLiveStats, shouldRequestLiveStats } from "@/components/live-game/live-game-events";
import type { LiveGameResponse, RecentStatsEvent, RecentStatsState } from "@/types/live-game";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

const POLL_MS = 5000;
// Idle means VALORANT is not running — the client puts you in a party of one the
// moment it is. Nothing can change until it launches, so stop asking so often.
const IDLE_POLL_MS = 15000;
type Snapshot = Extract<LiveGameResponse, { success: true }>;
type StatsCommandResponse =
	| { success: true; rosterKey: string; attemptId: number; count: number }
	| { success: false; rosterKey: string; attemptId: number; error: string };

export type LiveGameSession = {
	snapshot: Snapshot | null;
	recent: Record<string, RecentStatsState>;
	error: string | null;
	loginRequired: boolean;
	loading: boolean;
	refreshing: boolean;
	requestSnapshot: () => void;
	refreshSnapshot: () => void;
};

const LiveGameSessionContext = createContext<LiveGameSession | null>(null);

const useLiveGameSessionState = (): LiveGameSession => {
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

		// Keep polling while the app is open, including other pages. A hidden window
		// still has nobody reading the roster, so skip those ticks.
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

	return useMemo(
		() => ({ snapshot, recent, error, loginRequired, loading, refreshing, requestSnapshot, refreshSnapshot }),
		[snapshot, recent, error, loginRequired, loading, refreshing, requestSnapshot, refreshSnapshot],
	);
};

export const LiveGameProvider = ({ children }: { children: ReactNode }) => {
	const value = useLiveGameSessionState();
	return <LiveGameSessionContext.Provider value={value}>{children}</LiveGameSessionContext.Provider>;
};

export const useLiveGameSession = () => {
	const session = useContext(LiveGameSessionContext);
	if (!session) throw new Error("useLiveGameSession must be used within LiveGameProvider");
	return session;
};
