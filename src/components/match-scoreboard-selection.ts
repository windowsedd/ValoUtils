import type { MatchPlayer } from "@/types/matches";

export const scoreboardPlayerInteraction = (
  player: MatchPlayer,
  onPlayerSelect?: (player: MatchPlayer) => void,
) => {
  const riotId = player.gameName
    ? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ""}`
    : "Player";
  const selectable = Boolean(player.subject.trim() && onPlayerSelect);
  return {
    selectable,
    label: riotId,
    activate: selectable ? () => onPlayerSelect?.(player) : undefined,
  };
};
