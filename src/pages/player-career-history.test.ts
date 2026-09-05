import { describe, expect, test } from "bun:test";
import { normalizeCareerMatches } from "./player-career-history";

describe("Career match history", () => {
  test("keeps every queue and joins rank updates onto competitive matches", () => {
    const history = {
      History: [
        { MatchID: "u1", GameStartTime: 300, QueueID: "unrated" },
        { MatchID: "c1", GameStartTime: 200, QueueID: "competitive" },
        { MatchID: "d1", GameStartTime: 100, QueueID: "deathmatch" },
      ],
    };
    const updates = {
      Matches: [
        {
          MatchID: "c1",
          TierBeforeUpdate: 20,
          TierAfterUpdate: 21,
          RankedRatingAfterUpdate: 44,
          RankedRatingEarned: 18,
        },
      ],
    };

    const matches = normalizeCareerMatches(history, updates);

    expect(matches.map((match) => match.queueId)).toEqual(["unrated", "competitive", "deathmatch"]);
    expect(matches[1].rrEarned).toBe(18);
    expect(matches[0].rrEarned).toBeNull();
  });
});
