import type { MatchPlayer } from "@/types/matches";

export const matchPlayerSubtitle = (
  player: Pick<MatchPlayer, "role">,
  agentName: string,
  coachLabel: string,
) => (player.role === "coach" ? coachLabel : agentName);
