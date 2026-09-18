import type { LiveGameEvent, LivePlayer } from "@/types/live-game";
import { localize, type AgentAsset } from "@/util/valorant-assets";
import { useId, useState } from "react";
import { LuChevronDown, LuLockKeyhole, LuScrollText } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { selfTeamId } from "./live-party-order";

type Props = {
  events: readonly LiveGameEvent[];
  players: readonly LivePlayer[];
  agents: Map<string, AgentAsset>;
};

export const LiveEventLog = ({ events, players, agents }: Props) => {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const logId = useId();
  const selfTeam = selfTeamId(players);
  // Pregame uses Ally/Enemy; coregame uses the local player's Red/Blue team.
  const allies = new Map(players
    .filter((player) => player.isSelf || player.teamId === "Ally" ||
      ((selfTeam === "Red" || selfTeam === "Blue") && player.teamId === selfTeam))
    .map((player) => [player.puuid.toLowerCase(), player]));
  const alliedEvents = events.filter((event) => allies.has(event.playerId.toLowerCase()));

  return (
    <aside className="mx-6 mb-5 w-80 max-w-[calc(100%_-_3rem)] shrink-0 self-end overflow-hidden rounded-xl border border-(--line) bg-(--surface) shadow-lg" aria-label={t("liveGame.eventLog")}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent)"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={logId}
        aria-label={t(expanded ? "liveGame.collapseEventLog" : "liveGame.expandEventLog")}
      >
        <LuScrollText aria-hidden="true" className="text-(--text-muted)" />
        <span className="font-medium text-(--text-primary)">{t("liveGame.eventLog")}</span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-(--text-muted)">{alliedEvents.length}</span>
        <LuChevronDown aria-hidden="true" className={`text-(--text-muted) transition-transform motion-reduce:transition-none ${expanded ? "" : "rotate-180"}`} />
      </button>
      <div id={logId} hidden={!expanded} className="border-t border-(--line)">
        {alliedEvents.length === 0 ? (
          <p className="px-3 py-4 text-xs text-(--text-muted)">{t("liveGame.eventLogEmpty")}</p>
        ) : (
          <ol role="log" aria-label={t("liveGame.eventLog")} aria-live="polite" aria-relevant="additions" className="max-h-44 overflow-y-auto overscroll-contain divide-y divide-(--line)">
            {[...alliedEvents].reverse().map((event) => {
              const player = allies.get(event.playerId.toLowerCase());
              const nameVisible = player && (!player.incognito || player.inMyParty || player.isSelf);
              const name = nameVisible && player.gameName
                ? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ""}`
                : t("liveGame.hidden");
              const agent = localize(agents.get(event.agentId.toLowerCase())?.name) || t("liveGame.hiddenAgent");
              const observed = new Date(event.observedAt);
              return (
                <li key={event.id} className="flex items-start gap-2 px-3 py-2.5">
                  <LuLockKeyhole aria-hidden="true" className="mt-0.5 shrink-0 text-xs text-(--accent-selected)" />
                  <p className="min-w-0 flex-1 break-words text-xs leading-relaxed text-(--text-secondary)">{t("liveGame.agentLocked", { player: name, agent })}</p>
                  <time dateTime={observed.toISOString()} title={observed.toLocaleString(i18n.language)} className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-(--text-muted)">
                    {observed.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
        <p className="border-t border-(--line) px-3 py-1.5 text-[10px] text-(--text-muted)">{t("liveGame.eventLogTimeHint")}</p>
      </div>
    </aside>
  );
};
