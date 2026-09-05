import { describe, expect, test } from "bun:test";
import { partyColor, rowAccentColor } from "./party-accent";

describe("live row party edge", () => {
  test("marks a partied row with that party's colour", () => {
    const first = rowAccentColor("Team 1");
    expect(first).toBe(partyColor("Team 1"));
    expect(first).not.toBe("transparent");
    expect(rowAccentColor("Team 2")).not.toBe(first);
  });

  test("leaves a solo player's edge blank", () => {
    // The edge means "queued together". A bar on every row said nothing, which
    // is what buried the party grouping in the first place.
    expect(rowAccentColor(null)).toBe("transparent");
  });

  test("gives each party a stable colour and wraps past the palette", () => {
    expect(partyColor("Team 1")).toBe(partyColor("Team 1"));
    expect(partyColor("Team 6")).toBe(partyColor("Team 1"));
    // A label with no number still resolves rather than going undefined.
    expect(partyColor("Party")).toBe(partyColor("Team 1"));
  });
});
