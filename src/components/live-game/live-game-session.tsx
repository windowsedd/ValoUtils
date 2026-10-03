import { listenEvent } from "@/util/ipc";
import { invoke } from "@tauri-apps/api/core";
import {
  isCurrentStatsAttempt,
  livePlayerStatsKey,
  liveStatsRequestKey,
  playersNeedingLiveStats,
  shouldPauseForSnapshot,
  shouldRequestLiveStats,
  LIVE_POLL_MS,
  LIVE_PAUSED_HEARTBEAT_MS,
  nextLivePollDelay,
} from "@/components/live-game/live-game-events";
import type { LiveGameResponse, RecentStatsEvent, RecentStatsState } from "@/types/live-game";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

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
  const mounted = useRef(false);
  const rosterKeyRef = useRef<string | null>(null);
  const requestedStatsKeyRef = useRef<string | null>(null);
  const statsAttemptRef = useRef(0);
  const pollDelayRef = useRef(LIVE_POLL_MS);
  // Last successful reply, verbatim. A repeat means nothing on screen changed.
  const lastMessageRef = useRef<string | null>(null);
  const pausedForMatchRef = useRef(false);
  // Match the chat poller reported as over. Core-game can keep serving it for a
  // while afterwards, and that stale answer must not pause polling again.
  const endedMatchIdRef = useRef<string | null>(null);
  const lastFetchAtRef = useRef(0);
  const scheduleRef = useRef<() => void>(() => {});
  const snapshotRef = useRef<Snapshot | null>(null);
  const statsThrottledRef = useRef(false);
  const recentRef = useRef(recent);
  recentRef.current = recent;

  const onStatsCommand = useCallback((message: StatsCommandResponse) => {
    if (!mounted.current) return;
    try {
      const response = message as StatsCommandResponse;
      if (
        response.success ||
        response.rosterKey !== requestedStatsKeyRef.current ||
        !isCurrentStatsAttempt(response.attemptId, statsAttemptRef.current)
      )
        return;
      if (response.error === "rateLimited") statsThrottledRef.current = true;
      setRecent((current) =>
        Object.fromEntries(
          Object.entries(current).map(([puuid, state]) => [
            puuid,
            state.status === "loading" ? { status: "error", error: response.error } : state,
          ]),
        ),
      );
    } catch {
      // The per-player event listener remains authoritative for valid responses.
    }
  }, []);

  const onSnapshot = useCallback(
    (message: LiveGameResponse) => {
      if (!mounted.current) return;
      let response: LiveGameResponse;
      try {
        response = message as LiveGameResponse;
      } catch {
        lastMessageRef.current = null;
        setLoading(false);
        setRefreshing(false);
        setError(t("liveGame.failedToLoad"));
        return;
      }

      setLoading(false);
      setRefreshing(false);
      if (!response.success) {
        lastMessageRef.current = null;
        if ("code" in response && response.code === "loginRequired") {
          setLoginRequired(true);
          setError(null);
          return;
        }
        const responseError = ("error" in response && response.error) || "";
        setError(
          responseError === "rateLimited"
            ? t("liveGame.rateLimited")
            : responseError === "unavailable"
              ? t("liveGame.failedToLoad")
              : responseError || t("liveGame.failedToLoad"),
        );
        return;
      }

      // Same answer as last time: skip the redraw and wait longer before
      // asking again. Any change snaps the next poll back to 5s.
      const serialized = JSON.stringify(response);
      const unchanged = serialized === lastMessageRef.current;
      lastMessageRef.current = serialized;
      pollDelayRef.current = nextLivePollDelay(
        response.state,
        unchanged,
        pollDelayRef.current,
        response.match?.inQueue,
      );
      scheduleRef.current();
      if (unchanged) return;

      setLoginRequired(false);
      // A cooldown only concerns this page while it keeps something off screen:
      // a name or rank (the backend's warning) or a player's recent stats.
      const statsHeld =
        Boolean(response.retryInSeconds) &&
        response.state !== "idle" &&
        playersNeedingLiveStats(
          response.players.map((player) => player.puuid),
          recentRef.current,
        ).length > 0;
      setError(
        response.warning === "rateLimited" || statsHeld
          ? t("liveGame.rateLimited", { seconds: response.retryInSeconds ?? 60 })
          : response.warning === "unavailable"
            ? t("liveGame.failedToLoad")
            : null,
      );
      setSnapshot(response);
      snapshotRef.current = response;
      rosterKeyRef.current = response.state === "idle" ? null : response.rosterKey;
      // A running match is fetched once, then polling pauses. Its roster still
      // falls through so the other team's recent stats are requested.
      if (shouldPauseForSnapshot(response.state, response.match?.id, endedMatchIdRef.current)) {
        pausedForMatchRef.current = true;
      } else if (response.state === "party" || response.state === "idle") {
        // Back in a lobby or menus: whatever match paused polling is over.
        pausedForMatchRef.current = false;
      } else if (pausedForMatchRef.current) {
        return;
      }

      if (response.state === "idle") {
        requestedStatsKeyRef.current = null;
        setRecent({});
        return;
      }

      const queueId = response.match?.queueId ?? "";
      const statsKey = liveStatsRequestKey(
        response.players.map((player) => player.puuid),
        queueId,
      );
      // A throttled attempt would otherwise leave the column dead for the whole
      // match: stats are only re-requested when the roster key changes, and it
      // does not. Once Riot stops refusing, ask for the missing ones again.
      const canRequestStats = shouldRequestLiveStats(response.warning, response.retryInSeconds);
      if (statsThrottledRef.current && canRequestStats) {
        statsThrottledRef.current = false;
        requestedStatsKeyRef.current = null;
      }
      if (!canRequestStats) {
        statsThrottledRef.current = true;
      } else if (requestedStatsKeyRef.current !== statsKey) {
        const puuids = response.players.map((player) => player.puuid);
        const needed = playersNeedingLiveStats(puuids, recentRef.current);
        requestedStatsKeyRef.current = statsKey;
        setRecent((current) =>
          Object.fromEntries(
            response.players.map((player) => {
              const playerKey = livePlayerStatsKey(player.puuid);
              const existing = current[playerKey];
              return [playerKey, existing?.status === "ready" ? existing : { status: "loading" }];
            }),
          ),
        );
        if (needed.length === 0) return;
        const attemptId = ++statsAttemptRef.current;
        invoke<StatsCommandResponse>("live_game_stats", {
          args: [statsKey, needed, attemptId, queueId],
        })
          .then(onStatsCommand)
          .catch((error) =>
            onStatsCommand({
              success: false,
              rosterKey: statsKey,
              attemptId,
              error: String(error),
            }),
          );
      }
    },
    [t, onStatsCommand],
  );

  const requestSnapshot = useCallback(() => {
    pausedForMatchRef.current = false;
    if (rosterKeyRef.current) setRefreshing(true);
    else setLoading(true);
    lastFetchAtRef.current = Date.now();
    invoke<LiveGameResponse>("live_game_fetch")
      .then(onSnapshot)
      .catch((error) => onSnapshot({ success: false, error: String(error) }));
  }, [onSnapshot]);

  const refreshSnapshot = useCallback(() => {
    requestedStatsKeyRef.current = null;
    lastMessageRef.current = null;
    requestSnapshot();
  }, [requestSnapshot]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return;
      window.clearTimeout(timer);
      poll();
    };

    const onPhase = (phase: string) => {
      if (phase === "coregame" || phase === "ended" || phase === "pregame") {
        const current = snapshotRef.current;
        if (phase === "ended" && current?.state === "coregame")
          endedMatchIdRef.current = current.match?.id ?? null;
        pausedForMatchRef.current = false;
        window.clearTimeout(timer);
        poll();
      }
    };

    const onPlayerStats = (message: RecentStatsEvent) => {
      try {
        const event = message as RecentStatsEvent;
        if (
          event.rosterKey !== requestedStatsKeyRef.current ||
          !isCurrentStatsAttempt(event.attemptId, statsAttemptRef.current)
        )
          return;
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

    mounted.current = true;

    let active = true;

    // Watch pregame even on other pages, then pause once the match starts.
    // A hidden window has nobody reading the roster, so skip those ticks.
    let timer = 0;
    const poll = () => {
      const heartbeatDue = Date.now() - lastFetchAtRef.current >= LIVE_PAUSED_HEARTBEAT_MS;
      if (!document.hidden && (!pausedForMatchRef.current || heartbeatDue)) {
        lastFetchAtRef.current = Date.now();
        invoke<LiveGameResponse>("live_game_fetch")
          .then((reply) => {
            if (active) onSnapshot(reply);
          })
          .catch((error) => {
            if (active) onSnapshot({ success: false, error: String(error) });
          });
      }
      timer = window.setTimeout(poll, pollDelayRef.current);
    };

    scheduleRef.current = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(poll, pollDelayRef.current);
    };
    const stopSnapshot = listenEvent("live-game:fetch", onSnapshot);

    const stopPlayerStats = listenEvent("live-game:player-stats", onPlayerStats);
    const stopPhase = listenEvent("live-game:phase", onPhase);
    document.addEventListener("visibilitychange", onVisibility);
    poll();
    return () => {
      mounted.current = false;
      active = false;
      scheduleRef.current = () => {};

      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      stopSnapshot();

      stopPlayerStats();
      stopPhase();
    };
  }, [t, onSnapshot]);

  return useMemo(
    () => ({
      snapshot,
      recent,
      error,
      loginRequired,
      loading,
      refreshing,
      requestSnapshot,
      refreshSnapshot,
    }),
    [snapshot, recent, error, loginRequired, loading, refreshing, requestSnapshot, refreshSnapshot],
  );
};

export const LiveGameProvider = ({ children }: { children: ReactNode }) => {
  const value = useLiveGameSessionState();
  return (
    <LiveGameSessionContext.Provider value={value}>{children}</LiveGameSessionContext.Provider>
  );
};

export const useLiveGameSession = () => {
  const session = useContext(LiveGameSessionContext);
  if (!session) throw new Error("useLiveGameSession must be used within LiveGameProvider");
  return session;
};
