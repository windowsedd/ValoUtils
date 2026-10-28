import { getAgents, type AgentAsset } from "@/util/valorant-assets";
import { useEffect, useState } from "react";

/** Stable effect key for a set of agent ids, ignoring order, case and blanks. */
export const agentIdsKey = (ids: Iterable<string | null | undefined>): string =>
	[...new Set([...ids].filter((id): id is string => !!id).map((id) => id.toLowerCase()))].sort().join(",");

/**
 * The agent asset map, looked up again whenever `ids` gains an agent, so one
 * released after the list was cached still gets its name and icon.
 */
export const useAgentAssets = (ids: Iterable<string | null | undefined> = []): Map<string, AgentAsset> => {
	const [agents, setAgents] = useState<Map<string, AgentAsset>>(new Map());
	const key = agentIdsKey(ids);
	useEffect(() => {
		let cancelled = false;
		getAgents(key ? key.split(",") : []).then((map) => {
			if (!cancelled) setAgents(map);
		});
		return () => {
			cancelled = true;
		};
	}, [key]);
	return agents;
};
