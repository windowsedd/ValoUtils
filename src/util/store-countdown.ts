/**
 * Countdown formatting for the store's rotation timers.
 *
 * The storefront hands back a remaining duration in seconds at fetch time, not
 * an expiry timestamp, so the page ticks it down locally. That means the value
 * can run past zero if the tab is left open — an expired timer reads as
 * "expired" rather than counting into negatives.
 */

/** Seconds remaining, given the value at fetch time and how long ago that was. */
export const remainingSeconds = (fetchedSeconds: number, elapsedSeconds: number): number =>
  Math.max(0, Math.floor(fetchedSeconds - elapsedSeconds));

/**
 * Seconds until the first shop section rotates, given each section's remaining
 * duration at fetch time; 0 once any of them has. Sections that are absent or
 * report no duration are ignored. Until then a saved shop is still the shop.
 */
export const secondsUntilRotation = (
  durations: readonly (number | null | undefined)[],
  elapsedSeconds: number,
): number => {
  const running = durations.filter((seconds): seconds is number => typeof seconds === "number" && seconds > 0);
  if (running.length === 0) return 0;
  return Math.max(0, Math.min(...running) - elapsedSeconds);
};

/**
 * `7:12:44` under a day, `6d 04:11` over one.
 *
 * Days get their own unit because a bundle runs for a week, and rendering that
 * as `164:11:03` is unreadable.
 */
export const formatCountdown = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";

  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}`;
  return `${hours}:${pad(minutes)}:${pad(secs)}`;
};
