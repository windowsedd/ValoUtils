import { expect, test } from "bun:test";
import { readPenalties, readInterventions } from "./player-career-status";

test("penalties keep reasons, effects, expiry and games remaining", () => {
  expect(readPenalties({Penalties: [{ID: "p", InfractionID: "i", Expiry: "2026-10-10T00:00:00Z", GamesRemaining: 3, QueueRestrictionEffect: {}, WarningEffect: null}],
    Infractions: [{ID: "i", Name: "Queue dodge"}]})).toEqual([
      {id: "p", reason: "Queue dodge", effects: ["QueueRestrictionEffect"], expiry: "2026-10-10T00:00:00Z", gamesRemaining: 3},
    ]);
});

test("empty responses differ from malformed or unavailable responses", () => {
  expect(readPenalties({Penalties: []})).toEqual([]);
  expect(readPenalties(null)).toBeNull();
  expect(readPenalties({})).toBeNull();
  expect(readPenalties({Penalties: [null]})).toBeNull();
  expect(readInterventions({InterventionsByCategory: []})).toEqual([]);
  expect(readInterventions({InterventionsByCategory: [{}]})).toBeNull();
});

test("interventions separate active restrictions from next escalation names", () => {
  expect(readInterventions({InterventionsByCategory: [{BehaviorCategory: "PARTICIPATION", BehaviorRatingName: "afk", ActiveInterventions: [{InterventionName: "Warning", Expiry: "2026-10-10T00:00:00Z", IssuingTime: "2026-10-09T00:00:00Z", OriginInfraction: "AFK"}], NextInterventionNames: ["QueueDelay"], AppliedInfractions: {}}]})).toEqual([
    {category: "PARTICIPATION", rating: "afk", active: [{name: "Warning", expiry: "2026-10-10T00:00:00Z", issuedAt: "2026-10-09T00:00:00Z", reason: "AFK"}], next: ["QueueDelay"]},
  ]);
});
