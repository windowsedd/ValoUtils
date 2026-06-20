import { describe, it, expect } from "vitest";
import { registry } from "../unreal/registry.js";
import "./models.js";

describe("Valorant model registry population", () => {
  it("registers export groups", () => {
    // 23 group/sub-group classes carry [NetFieldExportGroup] in the C# source.
    expect(registry.groups.size).toBeGreaterThanOrEqual(20);
  });

  it("registers class net caches", () => {
    expect(registry.classNetCaches.size).toBe(4);
  });

  it("registers the player controller", () => {
    expect(registry.playerControllerPaths.has("BaseReplayController_C")).toBe(
      true,
    );
  });

  it("registers handle-based groups (AresAttributeSet, BombPlayerState)", () => {
    expect(
      registry.groups.get("/Script/ShooterGame.AresAttributeSet")?.usesHandles,
    ).toBe(true);
    expect(
      registry.groups.get(
        "/Game/Characters/_Core/BaseReplayController.BaseReplayController_C",
      )?.usesHandles,
    ).toBe(true);
  });

  it("merges sub-group properties into the parent", () => {
    const parent = registry.groups.get(
      "/Script/ShooterGame.OwnerExclusivePlayerInfo",
    );
    // Parent owns its own props plus the FAresTrackedReward sub-group props.
    expect(parent?.properties.some((p) => p.name === "RewardName")).toBe(true);
  });
});
