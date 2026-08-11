import { expect, test } from "bun:test";
import { isMatchPlayerHighlighted } from "./match-player-highlight";

test("uses the supplied friend PUUID instead of the signed-in player flag", () => {
	expect(isMatchPlayerHighlighted({ subject: "friend-a", isSelf: false }, "FRIEND-A")).toBe(true);
	expect(isMatchPlayerHighlighted({ subject: "self", isSelf: true }, "friend-a")).toBe(false);
	expect(isMatchPlayerHighlighted({ subject: "self", isSelf: true })).toBe(true);
});
