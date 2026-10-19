import { describe, expect, test } from "bun:test";
import {
  bloomlineAgentRows,
  selectedBloomlineAgent,
  acceptedBloomlineDetail,
  type BloomlineAgent,
} from "./bloomline-state";

const agent = (agentId: string, level: number | null): BloomlineAgent => ({
  agentId,
  level,
  longLevel: null,
  points: null,
  stats: null,
});

describe("Bloomline agent selection", () => {
  const agents = [agent("jett", 0), agent("sage", null)];
  const names = new Map([
    ["jett", "Jett"],
    ["sage", "Sage"],
  ]);
  test("filters by localized names without dropping zero or missing progress", () => {
    expect(bloomlineAgentRows(agents, names, " JE ").map((row) => row.agentId)).toEqual(["jett"]);
    expect(bloomlineAgentRows(agents, names, "")).toHaveLength(2);
    expect(bloomlineAgentRows(agents, new Map(), "JETT").map((row) => row.agentId)).toEqual([
      "jett",
    ]);
  });
  test("keeps a valid selection and falls back when it leaves the roster", () => {
    expect(selectedBloomlineAgent(agents, "sage")).toBe("sage");
    expect(selectedBloomlineAgent(agents, "missing")).toBe("jett");
    expect(selectedBloomlineAgent([], "jett")).toBeNull();
  });
  test("rejects details for another account or a superseded selection", () => {
    const response = { success: true, puuid: "me", agents: [agent("jett", 0)] };
    expect(acceptedBloomlineDetail(response, "me", "jett")?.level).toBe(0);
    expect(acceptedBloomlineDetail(response, "other", "jett")).toBeNull();
    expect(acceptedBloomlineDetail(response, "me", "sage")).toBeNull();
    expect(acceptedBloomlineDetail({ ...response, success: false }, "me", "jett")).toBeNull();
  });
});
