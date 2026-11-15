import { expect, test } from "bun:test";
import { matchPartyNumbers } from "./match-parties";

test("numbers parties of two or more in roster order and skips solo players", () => {
	const numbers = matchPartyNumbers([
		{ subject: "a", partyId: "p2" },
		{ subject: "b", partyId: "solo" },
		{ subject: "c", partyId: "p1" },
		{ subject: "d", partyId: "p2" },
		{ subject: "e", partyId: "" },
		{ subject: "f", partyId: "p1" },
	]);
	expect([...numbers]).toEqual([["a", 1], ["c", 2], ["d", 1], ["f", 2]]);
});
