import { describe, expect, test } from "bun:test";
import en from "../i18n/locales/en.json";
import ko from "../i18n/locales/ko.json";
import zhTW from "../i18n/locales/zh-TW.json";

const required = [
  "customWhenLabel",
  "customWhen.command",
  "customWhen.onPregame",
  "customWhen.onMatchStart",
  "customWhen.onMatchEnd",
  "customTargetLabel",
  "customTargetDirect",
  "customLifecycleExists",
  "customDirectRequiresRelay",
  "customDirectSent",
  "variable.server",
] as const;

// The built-in command reference has to read in every shipped language, not
// just fall back to English for the newest command.
const commandReference = ["asciiSyntax", "asciiDesc", "asciiExample"] as const;

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );

describe("bot command locale contract", () => {
  for (const [name, locale] of [
    ["en", en],
    ["ko", ko],
    ["zh-TW", zhTW],
  ] as const) {
    test(`${name} defines every direct/lifecycle/server key`, () => {
      for (const key of required) {
        expect(at(locale.dummyBot, key), `${name}: dummyBot.${key}`).toBeTruthy();
      }
    });

    test(`${name} documents the built-in .ascii command`, () => {
      for (const key of commandReference) {
        expect(at(locale.dummyBot, key), `${name}: dummyBot.${key}`).toBeTruthy();
      }
      expect(locale.dummyBot.asciiSyntax).toBe(".ascii {team|all|party} <text>");
		expect(locale.dummyBot.asciiExample).toBe(".ascii hk gay");
    });
  }
});
