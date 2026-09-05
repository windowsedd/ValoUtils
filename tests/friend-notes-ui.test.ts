import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const friendsPage = readFileSync(join(import.meta.dir, "..", "src/pages/Friends.tsx"), "utf8");

describe("Friends note wiring", () => {
  test("uses note-aware search only for accepted friends", () => {
    expect(friendsPage).toContain(
      "visibleFriends.filter((friend) => matchesFriendSearch(friend, search))",
    );
    expect(friendsPage).toContain("matchesFriendRequestSearch(request, search)");
  });

  test("shows notes for accepted rows and hides them for requests", () => {
    expect(friendsPage).toContain("<FriendIdentity person={friend} showNote />");
    expect(friendsPage).toContain('showNote={"isOnline" in person}');
  });
});
