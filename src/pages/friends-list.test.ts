import { describe, expect, test } from "bun:test";
import type { Friend } from "@/types/friends";

describe("Friends visible roster", () => {
  test("hides only ValoUtils Bot#BOT", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => undefined,
      },
    });
    const friendsPage = await import("./Friends");
    const page = friendsPage as typeof friendsPage & {
      isVisibleFriend?: (friend: Pick<Friend, "gameName" | "tagLine">) => boolean;
    };
    expect(page.isVisibleFriend).toBeDefined();
    if (!page.isVisibleFriend) return;
    const isVisibleFriend = page.isVisibleFriend;
    expect(isVisibleFriend({ gameName: "ValoUtils Bot", tagLine: "BOT" })).toBe(false);
    expect(isVisibleFriend({ gameName: " valoutils bot ", tagLine: " bot " })).toBe(false);
    expect(isVisibleFriend({ gameName: "ValoUtils Bot", tagLine: "PLAYER" })).toBe(true);
    expect(isVisibleFriend({ gameName: "Another", tagLine: "BOT" })).toBe(true);
  });
});
