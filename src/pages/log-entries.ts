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

export type PdBudgetDetails = {
  requests: number;
  seconds: number;
  longestWaitMs: number;
  /** The endpoint that waited longest, when the line names one. */
  longestEndpoint: string | null;
  /** Busiest first, as the backend writes them. Empty on lines from older builds. */
  endpoints: { endpoint: string; count: number }[];
};

const PD_BUDGET =
  /^PD budget: (\d+) requests in (\d+)s, longest wait (\d+)ms(?: \(([^)]+)\))?(?:; (.+))?$/;

/**
 * Reads the rate gate's window summary back into numbers, so the Logs page can
 * show the per-endpoint breakdown as a table instead of one long line.
 */
export const parsePdBudget = (message: string): PdBudgetDetails | null => {
  const match = PD_BUDGET.exec(message.trim());
  if (!match) return null;
  const endpoints = (match[5] ?? "")
    .split(", ")
    .map((part) => /^(.+) x(\d+)$/.exec(part))
    .filter((part): part is RegExpExecArray => part !== null)
    .map((part) => ({ endpoint: part[1], count: Number(part[2]) }));
  return {
    requests: Number(match[1]),
    seconds: Number(match[2]),
    longestWaitMs: Number(match[3]),
    longestEndpoint: match[4] ?? null,
    endpoints,
  };
};

/** The headline of a PD budget line, without the endpoint list. */
export const pdBudgetHeadline = (details: PdBudgetDetails) =>
  `PD budget: ${details.requests} requests in ${details.seconds}s, longest wait ${details.longestWaitMs}ms`;
