import type { LiveGameEvent, LivePlayer } from "@/types/live-game";
import { localize, type AgentAsset } from "@/util/valorant-assets";
import { useId, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuLockKeyhole, LuScrollText } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { selfTeamId } from "./live-party-order";

type Props = {
  events: readonly LiveGameEvent[];
  players: readonly LivePlayer[];
  agents: Map<string, AgentAsset>;
};

/** Whether the viewer last collapsed the sidebar. Storage may be unavailable. */
const COLLAPSED_KEY = "valoutils.liveEvents.collapsed";
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};
const writeCollapsed = (collapsed: boolean) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* A remembered layout is a convenience; nothing breaks without it. */
  }
};

/**
 * Allied agent locks for the current match, as a sidebar beside the roster.
 *
 * It owns the full height of the page body rather than floating over it, so it
 * never covers a player's details toggle and never leaves an empty block under
 * the roster. Collapsed, it shrinks to a strip that still shows the count.
 */
export const LiveEventLog = ({ events, players, agents }: Props) => {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(() => !readCollapsed());
  const logId = useId();
  const selfTeam = selfTeamId(players);
  // Pregame uses Ally/Enemy; coregame uses the local player's Red/Blue team.
  const allies = new Map(players
    .filter((player) => player.isSelf || player.teamId === "Ally" ||
      ((selfTeam === "Red" || selfTeam === "Blue") && player.teamId === selfTeam))
    .map((player) => [player.puuid.toLowerCase(), player]));
  const alliedEvents = events.filter((event) => allies.has(event.playerId.toLowerCase()));

  const toggle = () =>
    setExpanded((current) => {
      writeCollapsed(current);
      return !current;
    });

  const count = (
    <span className="min-w-5 rounded-full border border-(--border) px-1.5 text-center font-mono text-[10px] tabular-nums text-(--text-secondary)">{alliedEvents.length}</span>
  );

  return (
    <aside
      className={`flex shrink-0 flex-col border-l border-(--line) bg-(--background) transition-[width] duration-150 motion-reduce:transition-none ${expanded ? "w-72" : "w-12"}`}
      aria-label={t("liveGame.eventLog")}
      data-live-events={expanded ? "expanded" : "collapsed"}
    >
      <button
        type="button"
        className={`flex shrink-0 items-center gap-2 border-b border-(--line) text-left text-xs transition-colors hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent-soft)] ${
          expanded ? "h-12 px-4" : "flex-col justify-center gap-1.5 px-0 py-3"
        }`}
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={logId}
        aria-label={t(expanded ? "liveGame.collapseEventLog" : "liveGame.expandEventLog")}
        title={t(expanded ? "liveGame.collapseEventLog" : "liveGame.expandEventLog")}
      >
        <LuScrollText aria-hidden="true" className="shrink-0 text-(--text-muted)" />
        {expanded && <span className="font-semibold text-(--text-primary)">{t("liveGame.eventLog")}</span>}
        {expanded ? <span className="ml-auto">{count}</span> : count}
        {expanded
          ? <LuChevronRight aria-hidden="true" className="shrink-0 text-(--text-muted)" />
          : <LuChevronLeft aria-hidden="true" className="shrink-0 text-(--text-muted)" />}
      </button>
      <div id={logId} hidden={!expanded} className="flex min-h-0 flex-1 flex-col">
        {alliedEvents.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <LuLockKeyhole aria-hidden="true" className="text-xl text-(--text-muted) opacity-60" />
            <p className="text-xs text-(--text-muted)">{t("liveGame.eventLogEmpty")}</p>
          </div>
        ) : (
          <ol role="log" aria-label={t("liveGame.eventLog")} aria-live="polite" aria-relevant="additions" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {[...alliedEvents].reverse().map((event) => {
              const player = allies.get(event.playerId.toLowerCase());
              const nameVisible = player && (!player.incognito || player.inMyParty || player.isSelf);
              const name = nameVisible && player.gameName
                ? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ""}`
                : t("liveGame.hidden");
              const asset = agents.get(event.agentId.toLowerCase());
              const agent = localize(asset?.name) || t("liveGame.hiddenAgent");
              const observed = new Date(event.observedAt);
              return (
                <li key={event.id} className="flex items-center gap-2.5 rounded-[8px] px-2 py-2 hover:bg-(--surface-hover)">
                  <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[8px] bg-(--control)">
                    {asset?.icon
                      ? <img src={asset.icon} alt="" className="h-full w-full object-cover" />
                      : <LuLockKeyhole aria-hidden="true" className="text-xs text-(--accent-selected)" />}
                  </span>
                  <p className="min-w-0 flex-1 break-words text-xs leading-snug text-(--text-secondary)">{t("liveGame.agentLocked", { player: name, agent })}</p>
                  <time dateTime={observed.toISOString()} title={observed.toLocaleString(i18n.language)} className="shrink-0 font-mono text-[10px] tabular-nums text-(--text-muted)">
                    {observed.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
        <p className="shrink-0 border-t border-(--line) px-4 py-2 text-[10px] text-(--text-muted)">{t("liveGame.eventLogTimeHint")}</p>
      </div>
    </aside>
  );
};
