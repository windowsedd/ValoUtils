import { describe, expect, test } from "bun:test";
import { formatCountdown, remainingSeconds } from "./store-countdown";

describe("store countdown", () => {
  test("formats under a day as h:mm:ss", () => {
    expect(formatCountdown(7 * 3600 + 12 * 60 + 44)).toBe("7:12:44");
    expect(formatCountdown(61)).toBe("0:01:01");
    expect(formatCountdown(86_399)).toBe("23:59:59");
  });

  test("switches to days once a bundle-length window is left", () => {
    // A week of hours would render as "164:11:03", which nobody can read.
    expect(formatCountdown(6 * 86_400 + 4 * 3600 + 11 * 60)).toBe("6d 04:11");
    expect(formatCountdown(86_400)).toBe("1d 00:00");
  });

  test("an expired or nonsense timer reads as a dash, never negative", () => {
    expect(formatCountdown(0)).toBe("—");
    expect(formatCountdown(-5)).toBe("—");
    expect(formatCountdown(Number.NaN)).toBe("—");
  });

  test("ticking down never goes below zero", () => {
    expect(remainingSeconds(100, 40)).toBe(60);
    // The tab was left open past the rotation.
    expect(remainingSeconds(100, 500)).toBe(0);
    expect(remainingSeconds(100, 0)).toBe(100);
  });
});
