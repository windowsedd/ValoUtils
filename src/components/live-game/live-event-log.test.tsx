import { describe, expect, test } from "bun:test";
import i18n from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next";
import en from "@/i18n/locales/en.json";
import type { LiveGameEvent, LivePlayer } from "@/types/live-game";

// The app's asset helpers initialize i18n from browser storage at import time.
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!storage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null },
  });
}
const { LiveEventLog } = await import("./live-event-log");
if (!storage) Reflect.deleteProperty(globalThis, "localStorage");

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: en } },
  initImmediate: false,
});

const event: LiveGameEvent = {
  id: "match:player:agent",
  kind: "agent-lock",
  observedAt: 1_800_000_000_000,
  playerId: "player",
  agentId: "agent",
};
const player = {
  puuid: "PLAYER",
  gameName: "Oneki",
  tagLine: "TW",
  incognito: false,
  teamId: "Ally",
} as LivePlayer;
const agents = new Map([["agent", { name: "Jett", icon: "" }]]);

describe("LiveEventLog", () => {
  const lockFor = (playerId: string): LiveGameEvent => ({ ...event, id: playerId, playerId });
  const eventCount = (markup: string) => markup.match(/tabular-nums[^>]*>(\d+)<\/span>/)?.[1];

  test("excludes enemy and unknown locks from both pregame entries and count", () => {
    const players = [
      player,
      { ...player, puuid: "self", gameName: "Me", isSelf: true },
      { ...player, puuid: "enemy", gameName: "Opponent", teamId: "Enemy" },
      { ...player, puuid: "unknown", gameName: "Unknown", teamId: null },
    ];
    const markup = renderToStaticMarkup(<LiveEventLog events={[event, ...["self", "enemy", "unknown", "missing"].map(lockFor)]} players={players} agents={agents} />);
    expect(markup).toContain("Oneki#TW locked Jett");
    expect(markup).toContain("Me#TW locked Jett");
    expect(markup).not.toContain("Opponent");
    expect(markup).not.toContain("Unknown#TW");
    expect(markup).not.toContain("Hidden Player locked Jett");
    expect(eventCount(markup)).toBe("2");
  });

  for (const teamId of ["Red", "Blue"]) {
    test(`keeps allied locks after entering coregame on ${teamId}`, () => {
      const players = [
        { ...player, teamId },
        { ...player, puuid: "self", gameName: "Me", teamId, isSelf: true },
        { ...player, puuid: "enemy", gameName: "Opponent", teamId: teamId === "Red" ? "Blue" : "Red" },
      ];
      const markup = renderToStaticMarkup(<LiveEventLog events={[event, lockFor("self"), lockFor("enemy")]} players={players} agents={agents} />);
      expect(markup).toContain("Oneki#TW locked Jett");
      expect(markup).toContain("Me#TW locked Jett");
      expect(markup).not.toContain("Opponent");
      expect(eventCount(markup)).toBe("2");
    });
  }

  test("shows the empty state and zero count for enemy-only events", () => {
    const markup = renderToStaticMarkup(<LiveEventLog events={[event]} players={[{ ...player, teamId: "Enemy" }]} agents={agents} />);
    expect(markup).toContain("Agent locks will appear here.");
    expect(markup).not.toContain("locked Jett");
    expect(eventCount(markup)).toBe("0");
  });

  test("does not assume a coregame team is allied when the local player is missing", () => {
    const markup = renderToStaticMarkup(<LiveEventLog events={[event]} players={[{ ...player, teamId: "Blue" }]} agents={agents} />);
    expect(markup).not.toContain("locked Jett");
    expect(eventCount(markup)).toBe("0");
  });

  test("shows an agent lock with its original timestamp and player name", () => {
    const markup = renderToStaticMarkup(<LiveEventLog events={[event]} players={[player]} agents={agents} />);
    expect(markup).toContain("Oneki#TW locked Jett");
    expect(markup).toContain(new Date(event.observedAt).toISOString());
    expect(markup).toContain('role="log"');
    expect(markup).toContain('aria-expanded="true"');
  });

  test("keeps hidden players anonymous while allowing the local player", () => {
    const hidden = renderToStaticMarkup(<LiveEventLog events={[event]} players={[{ ...player, incognito: true }]} agents={agents} />);
    expect(hidden).toContain("Hidden Player locked Jett");
    expect(hidden).not.toContain("Oneki");
    const self = renderToStaticMarkup(<LiveEventLog events={[event]} players={[{ ...player, incognito: true, isSelf: true }]} agents={agents} />);
    expect(self).toContain("Oneki#TW locked Jett");
  });

  test("shows newest entries first without mutating snapshot history", () => {
    const events = [event, { ...event, id: "new", observedAt: event.observedAt + 5_000, agentId: "raze" }];
    const catalog = new Map([...agents, ["raze", { name: "Raze", icon: "" }]]);
    const markup = renderToStaticMarkup(<LiveEventLog events={events} players={[player]} agents={catalog} />);
    expect(markup.indexOf("locked Raze")).toBeLessThan(markup.indexOf("locked Jett"));
    expect(events[0]).toBe(event);
  });

  test("has a useful empty state before any locks are seen", () => {
    const markup = renderToStaticMarkup(<LiveEventLog events={[]} players={[]} agents={agents} />);
    expect(markup).toContain("Agent locks will appear here.");
  });
});
