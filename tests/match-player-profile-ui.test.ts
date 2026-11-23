import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("clickable match player profiles", () => {
  test("View profile opens a page over the current one with Back, not a popup", () => {
    expect(existsSync(join(root, "src/components/match-player-profile-modal.tsx"))).toBe(false);
    expect(source("src/util/deep-links.ts")).toContain("export const openPlayerPage");
    const overlay = source("src/components/player-page-overlay.tsx");
    expect(overlay).toContain("onBack={back}");
    expect(source("src/components/router.tsx")).toContain("<PlayerPageOverlay key={selectedId} />");
  });

  test("wires profile selection into Matches, saved chat and shared friend match history", () => {
    expect(source("src/pages/Matches.tsx")).toContain("onPlayerSelect={openPlayerPage}");
    expect(source("src/pages/chat/saved-match-scoreboard.tsx")).toContain("onPlayerSelect={openPlayerPage}");
    expect(source("src/components/friends/friend-competitive-history.tsx")).toContain(
      "playerProfilesEnabled ? openPlayerPage : undefined",
    );
  });

  test("keeps nested modal match histories from opening another profile modal", () => {
    expect(source("src/components/friends/friend-competitive-history.tsx")).toContain(
      "playerProfilesEnabled = true",
    );
  });

  test("cleans up only its own match-detail listener when the modal closes", () => {
    const scoreboard = source("src/components/match-scoreboard.tsx");
    expect(scoreboard).toContain('listenEvent("match:details", onMatchDetails)');
    expect(scoreboard).not.toContain('removeAllListeners("match:details")');
  });
});
