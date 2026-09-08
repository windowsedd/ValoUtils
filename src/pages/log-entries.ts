export const LOG_LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogEntry = {
  /** `null` for a line the log format did not cover. */
  timestamp: string | null;
  target: string | null;
  level: LogLevel;
  message: string;
};

/**
 * Narrow the log to what the reader asked for.
 *
 * An empty level selection means "no filter" rather than "nothing": the chips
 * start unset, and a page that opened onto an empty list would read as a broken
 * log rather than an unfiltered one.
 */
export const filterLogEntries = (
  entries: readonly LogEntry[],
  levels: readonly LogLevel[],
  search: string,
) => {
  const needle = search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (levels.length > 0 && !levels.includes(entry.level)) return false;
    if (!needle) return true;
    return (
      entry.message.toLowerCase().includes(needle) ||
      (entry.target ?? "").toLowerCase().includes(needle)
    );
  });
};

/** One line of a copied selection, in the shape the log file itself uses. */
export const formatLogEntry = (entry: LogEntry) =>
  `[${entry.timestamp ?? ""}][${entry.target ?? ""}][${entry.level}] ${entry.message}`;

export const formatLogSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
