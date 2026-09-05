import { describe, expect, test } from "bun:test";
import {
  BOT_TEMPLATE_VARIABLES,
  autocompleteKeyAction,
  filterTemplateVariables,
  findActiveTemplateRange,
  insertTemplateVariable,
} from "./bot-command-autocomplete";

describe("bot command template autocomplete", () => {
  test("catalog exposes every approved variable exactly once", () => {
    const ids = BOT_TEMPLATE_VARIABLES.map((item) => item.id);
    expect(ids).toHaveLength(35);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("enemy_team_kda");
    expect(ids).toContain("ally_team_agents");
    expect(ids).toContain("my_win_rate");
    expect(ids).toContain("roster_count");
    expect(BOT_TEMPLATE_VARIABLES.find((item) => item.id === "server")).toEqual({
      id: "server",
      group: "match",
      descriptionKey: "dummyBot.variable.server",
      example: "ap-gp-hongkong-1",
      dataLevel: "roster",
    });
    // server_name is the human label; server stays the raw pod id beside it.
    expect(BOT_TEMPLATE_VARIABLES.find((item) => item.id === "server_name")).toEqual({
      id: "server_name",
      group: "match",
      descriptionKey: "dummyBot.variable.server_name",
      example: "Hong Kong",
      dataLevel: "roster",
    });
  });

  test("finds only the unmatched placeholder at the caret", () => {
    expect(findActiveTemplateRange("KD {{enemy_te", 13)).toEqual({
      start: 3,
      end: 13,
      query: "enemy_te",
    });
    expect(findActiveTemplateRange("{{enemy_team_kd}} ", 18)).toBeNull();
    expect(findActiveTemplateRange("text { enemy", 12)).toBeNull();
  });

  test("filters identifiers and localized descriptions case-insensitively", () => {
    const byId = filterTemplateVariables("ENEMY_TEAM_KD", () => "");
    expect(byId.map((item) => item.id)).toEqual(["enemy_team_kd", "enemy_team_kda"]);
    const byDescription = filterTemplateVariables("勝率", (item) =>
      item.id.endsWith("win_rate") ? "近期勝率" : "其他",
    );
    expect(byDescription.map((item) => item.id)).toEqual([
      "enemy_team_win_rate",
      "ally_team_win_rate",
      "my_win_rate",
    ]);
  });

  test("replaces a partial placeholder and preserves surrounding text", () => {
    expect(insertTemplateVariable("push {{enemy_te now", 15, "enemy_team_kd")).toEqual({
      value: "push {{enemy_team_kd}} now",
      caret: 22,
    });
    expect(insertTemplateVariable("hello world", 5, "map")).toEqual({
      value: "hello{{map}} world",
      caret: 12,
    });
  });

  test("maps navigation, commit, and dismissal keys", () => {
    expect(autocompleteKeyAction("ArrowDown", 0, 3)).toEqual({
      handled: true,
      activeIndex: 1,
      commit: false,
      dismiss: false,
    });
    expect(autocompleteKeyAction("ArrowUp", 0, 3)).toEqual({
      handled: true,
      activeIndex: 2,
      commit: false,
      dismiss: false,
    });
    expect(autocompleteKeyAction("Tab", 1, 3).commit).toBe(true);
    expect(autocompleteKeyAction("Enter", 1, 3).commit).toBe(true);
    expect(autocompleteKeyAction("Escape", 1, 3).dismiss).toBe(true);
  });
});
