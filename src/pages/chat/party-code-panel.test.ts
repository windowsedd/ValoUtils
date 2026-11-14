import { expect, test } from "bun:test";
import { cleanPartyCode, partyLink } from "./party-code-panel";

test("party codes keep only letters and digits, uppercased", () => {
  expect(cleanPartyCode(" tue-693 ")).toBe("TUE693");
  expect(cleanPartyCode('"ab c"')).toBe("ABC");
  expect(cleanPartyCode("x".repeat(80))).toHaveLength(64);
});

test("party links use Riot's gg.riotgames.com format and paste back to their code", () => {
  expect(partyLink("TUE693")).toBe("https://gg.riotgames.com/VAL?joinCode=TUE693");
  expect(cleanPartyCode("https://gg.riotgames.com/VAL?joinCode=tue693")).toBe("TUE693");
  expect(cleanPartyCode(partyLink("AB12"))).toBe("AB12");
});
