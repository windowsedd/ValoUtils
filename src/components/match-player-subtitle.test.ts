import { describe, expect, test } from "bun:test";
import { matchPlayerSubtitle } from "./match-player-subtitle";

describe("match player subtitle", () => {
	test("labels coaches instead of showing an agent", () => {
		expect(matchPlayerSubtitle({ role: "coach" }, "Viper", "Coach")).toBe("Coach");
	});

	test("keeps the localized agent name for players", () => {
		expect(matchPlayerSubtitle({ role: "player" }, "Viper", "Coach")).toBe("Viper");
	});
});
