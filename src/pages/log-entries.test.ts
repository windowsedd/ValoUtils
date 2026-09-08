import { describe, expect, it } from "bun:test";
import { filterLogEntries, formatLogEntry, formatLogSize, type LogEntry } from "@/pages/log-entries";

const entry = (level: LogEntry["level"], message: string, target = "valoutils::commands::live"): LogEntry => ({
  timestamp: "2026-09-08 12:34:56",
  target,
  level,
  message,
});

const LOG: LogEntry[] = [
  entry("INFO", "PD budget: 34 requests in 60s, longest wait 180ms"),
  entry("WARN", "Riot throttled /mmr/v1/players/<id> (strike 1)", "valoutils::commands::live_party"),
  entry("DEBUG", "live: fetching coregame:abc"),
  entry("ERROR", "client config server stopped", "valoutils::client_config"),
];

describe("filterLogEntries", () => {
  it("treats an empty level selection as unfiltered", () => {
    expect(filterLogEntries(LOG, [], "")).toHaveLength(4);
  });

  it("keeps only the selected levels", () => {
    const serious = filterLogEntries(LOG, ["ERROR", "WARN"], "");

    expect(serious.map((row) => row.level)).toEqual(["WARN", "ERROR"]);
  });

  it("searches the message and the target, case-insensitively", () => {
    expect(filterLogEntries(LOG, [], "THROTTLED")).toHaveLength(1);
    expect(filterLogEntries(LOG, [], "client_config")).toHaveLength(1);
    expect(filterLogEntries(LOG, [], "nothing here")).toHaveLength(0);
  });

  it("applies the level and the search together", () => {
    expect(filterLogEntries(LOG, ["WARN"], "throttled")).toHaveLength(1);
    expect(filterLogEntries(LOG, ["INFO"], "throttled")).toHaveLength(0);
  });

  it("ignores surrounding whitespace in the search", () => {
    expect(filterLogEntries(LOG, [], "   ")).toHaveLength(4);
    expect(filterLogEntries(LOG, [], "  budget  ")).toHaveLength(1);
  });
});

describe("formatLogEntry", () => {
  it("round-trips into the shape the log file uses", () => {
    expect(formatLogEntry(LOG[1])).toBe(
      "[2026-09-08 12:34:56][valoutils::commands::live_party][WARN] Riot throttled /mmr/v1/players/<id> (strike 1)",
    );
  });

  it("leaves the fields empty for a line the format did not cover", () => {
    expect(formatLogEntry({ timestamp: null, target: null, level: "INFO", message: "bare" })).toBe(
      "[][][INFO] bare",
    );
  });
});

describe("formatLogSize", () => {
  it("scales the unit to the size", () => {
    expect(formatLogSize(0)).toBe("0 KB");
    expect(formatLogSize(512)).toBe("512 B");
    expect(formatLogSize(2048)).toBe("2 KB");
    expect(formatLogSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("does not render a negative or unreadable size", () => {
    expect(formatLogSize(-1)).toBe("0 KB");
    expect(formatLogSize(Number.NaN)).toBe("0 KB");
  });
});
