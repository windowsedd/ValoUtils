import { expect, test } from "bun:test";
import {
  crosshairLink,
  hasSharedCrosshair,
  isDeepLink,
  matchLink,
  playerLink,
  shareCrosshair,
  sharePlayer,
  takeSharedCrosshair,
  takeSharedPlayer,
} from "./deep-links";

test("links encode crosshairs, players and matches", () => {
  expect(crosshairLink("0;P;c;5;h;0", "Cyan dot")).toBe("valoutils://crosshair?code=0%3BP%3Bc%3B5%3Bh%3B0&name=Cyan%20dot");
  expect(crosshairLink("0")).toBe("valoutils://crosshair?code=0");
  expect(playerLink("Some Name#NA1")).toBe("valoutils://player?riotId=Some%20Name%23NA1");
  expect(playerLink("ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe(
    "valoutils://player?puuid=abcdef01-2345-6789-abcd-ef0123456789",
  );
  expect(matchLink("0B5C3F7E-1111-2222-3333-444455556666")).toBe("valoutils://match?id=0b5c3f7e-1111-2222-3333-444455556666");
});

test("parked links are taken once", () => {
  shareCrosshair({ code: "0;P;d;1", name: null });
  expect(hasSharedCrosshair()).toBe(true);
  expect(takeSharedCrosshair()).toEqual({ code: "0;P;d;1", name: null });
  expect(takeSharedCrosshair()).toBeNull();
  sharePlayer("Me#NA1");
  expect(takeSharedPlayer()).toBe("Me#NA1");
  expect(takeSharedPlayer()).toBeNull();
});

test("only well-formed link payloads are accepted", () => {
  expect(isDeepLink({ kind: "match", matchId: "x" })).toBe(true);
  expect(isDeepLink({ kind: "player", query: "Me#NA1" })).toBe(true);
  expect(isDeepLink({ kind: "crosshair" })).toBe(false);
  expect(isDeepLink(null)).toBe(false);
});
