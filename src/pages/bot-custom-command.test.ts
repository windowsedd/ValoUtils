import { describe, expect, test } from "bun:test";
import {
  channelsForCustomCommand,
  normalizeCustomBotCommand,
  normalizeCustomBotCommands,
} from "./bot-custom-command";

describe("custom bot command normalization", () => {
  test("old persisted entries default to command without changing valid behavior", () => {
    expect(
      normalizeCustomBotCommand({
        trigger: "eco",
        action: "send",
        channel: "team",
        language: "none",
        message: "Save this round",
        count: 5,
      }),
    ).toEqual({
      when: "command",
      trigger: "eco",
      action: "send",
      channel: "team",
      language: "none",
      message: "Save this round",
      count: 5,
    });
  });

  test("lifecycle entries always send with no trigger but keep their target", () => {
    expect(
      normalizeCustomBotCommand({
        when: "onMatchStart",
        trigger: "ignored",
        action: "tran",
        channel: "all",
        language: "ja",
        message: "{{map}}",
        count: 3,
      }),
    ).toEqual({
      when: "onMatchStart",
      trigger: "",
      action: "send",
      channel: "all",
      language: "ja",
      message: "{{map}}",
      count: 3,
    });
  });

  test("a lifecycle entry saved before targets existed still whispers", () => {
    // Rows written by earlier builds carry no channel at all. Defaulting them
    // the way a manual command defaults would start posting them to party.
    expect(
      normalizeCustomBotCommand({ when: "onMatchEnd", message: "gg" }).channel,
    ).toBe("direct");
  });

  test("invalid manual values use safe defaults and bounded counts", () => {
    const input = {
      when: "later",
      action: "unknown",
      channel: "somewhere",
      language: " ",
      message: 42,
      count: 99,
    } as never;
    expect(normalizeCustomBotCommand(input)).toEqual({
      when: "command",
      trigger: "",
      action: "send",
      channel: "party",
      language: "none",
      message: "",
      count: 10,
    });
  });

  test("translate history cannot retain a direct target", () => {
    expect(
      normalizeCustomBotCommand({
        when: "command",
        action: "tran",
        channel: "direct",
      }),
    ).toMatchObject({ action: "tran", channel: "party" });
  });

  test("direct is available only for manual send", () => {
    expect(channelsForCustomCommand("send")).toEqual(["direct", "party", "pregame", "team", "all"]);
    expect(channelsForCustomCommand("tran")).toEqual(["party", "pregame", "team", "all"]);
  });

  test("one lifecycle event keeps every entry saved against it", () => {
    const commands = normalizeCustomBotCommands([
      { when: "onPregame", message: "first" },
      { when: "onPregame", message: "second" },
      { when: "command", trigger: ".one" },
      { when: "command", trigger: ".two" },
    ]);
    expect(commands.map((command) => command.message)).toEqual(["first", "second", "", ""]);
    expect(commands.map((command) => command.trigger)).toEqual(["", "", ".one", ".two"]);
  });

  test("non-array persisted values normalize to an empty list", () => {
    expect(normalizeCustomBotCommands(undefined)).toEqual([]);
    expect(normalizeCustomBotCommands({} as never)).toEqual([]);
  });
});
