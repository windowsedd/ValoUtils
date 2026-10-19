export type BloomlineStat = { numberId: string; moduleId: string | null; value: number };
export type BloomlineAgent = {
  agentId: string;
  level: number | null;
  longLevel: number | null;
  points: number | null;
  stats: BloomlineStat[] | null;
};
export type BloomlineResponse = {
  success: boolean;
  puuid?: string;
  agents?: BloomlineAgent[];
  code?: string;
  error?: string;
  retryInSeconds?: number;
};

export const bloomlineAgentRows = (
  agents: BloomlineAgent[],
  names: Map<string, string>,
  query: string,
) => {
  const wanted = query.trim().toLocaleLowerCase();
  return agents
    .filter(
      (agent) =>
        !wanted ||
        names.get(agent.agentId)?.toLocaleLowerCase().includes(wanted) ||
        agent.agentId.toLocaleLowerCase().includes(wanted),
    )
    .sort((a, b) =>
      (names.get(a.agentId) ?? a.agentId).localeCompare(names.get(b.agentId) ?? b.agentId),
    );
};

export const selectedBloomlineAgent = (agents: BloomlineAgent[], selected: string | null) =>
  agents.find((agent) => agent.agentId === selected)?.agentId ?? agents[0]?.agentId ?? null;

export const acceptedBloomlineDetail = (
  response: BloomlineResponse,
  owner: string,
  agentId: string,
) =>
  response.success && response.puuid === owner
    ? (response.agents?.find((agent) => agent.agentId === agentId) ?? null)
    : null;
