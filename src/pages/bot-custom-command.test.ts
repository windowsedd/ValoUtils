import { describe, expect, test } from "bun:test";
import {
	channelsForCustomCommand,
	normalizeCustomBotCommand,
	normalizeCustomBotCommands,
} from "./bot-custom-command";

describe("custom bot command normalization", () => {
	test("old persisted entries default to command without changing valid behavior", () => {
		expect(normalizeCustomBotCommand({
			trigger: "eco",
			action: "send",
			channel: "team",
			language: "none",
			message: "Save this round",
			count: 5,
		})).toEqual({
			when: "command",
			trigger: "eco",
			action: "send",
			channel: "team",
			language: "none",
			message: "Save this round",
			count: 5,
		});
	});

	test("lifecycle entries are always send/direct with no trigger", () => {
		expect(normalizeCustomBotCommand({
			when: "onMatchStart",
			trigger: "ignored",
			action: "tran",
			channel: "all",
			language: "ja",
			message: "{{map}}",
			count: 3,
		})).toEqual({
			when: "onMatchStart",
			trigger: "",
			action: "send",
			channel: "direct",
			language: "ja",
			message: "{{map}}",
			count: 3,
		});
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
		expect(normalizeCustomBotCommand({
			when: "command",
			action: "tran",
			channel: "direct",
		})).toMatchObject({ action: "tran", channel: "party" });
	});

	test("direct is available only for manual send", () => {
		expect(channelsForCustomCommand("send")).toEqual([
			"direct", "party", "pregame", "team", "all",
		]);
		expect(channelsForCustomCommand("tran")).toEqual([
			"party", "pregame", "team", "all",
		]);
	});

	test("only the first entry for each lifecycle event is retained", () => {
		const commands = normalizeCustomBotCommands([
			{ when: "onPregame", message: "first" },
			{ when: "onPregame", message: "second" },
			{ when: "command", trigger: ".one" },
			{ when: "command", trigger: ".two" },
		]);
		expect(commands.map((command) => command.message)).toEqual(["first", "", ""]);
		expect(commands.map((command) => command.trigger)).toEqual(["", ".one", ".two"]);
	});

	test("non-array persisted values normalize to an empty list", () => {
		expect(normalizeCustomBotCommands(undefined)).toEqual([]);
		expect(normalizeCustomBotCommands({} as never)).toEqual([]);
	});
});
