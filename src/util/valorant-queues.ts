/** Riot's raw queue ids -> the labels the game itself shows. */
export const QUEUE_LABELS: Record<string, string> = {
  competitive: "Competitive",
  unrated: "Unrated",
  swiftplay: "Swiftplay",
  spikerush: "Spike Rush",
  deathmatch: "Deathmatch",
  ggteam: "Escalation",
  hurm: "Team Deathmatch",
  onefa: "Replication",
  newmap: "New Map",
  snowball: "Snowball Fight",
  premier: "Premier",
  /** Custom games report an empty queue id. */
  "": "Custom",
};

export const queueLabel = (queueId: string | null | undefined) => {
  const id = (queueId ?? "").toLowerCase();
  // Skirmish queues carry their format: skirmish2v2 is "Skirmish 2v2".
  if (id.startsWith("skirmish")) return `Skirmish ${id.slice("skirmish".length)}`.trim();
  return QUEUE_LABELS[id] ?? queueId ?? "";
};

/**
 * Chip styling for a queue — ranked play is the only one that gets colour.
 *
 * Returns classes rather than a hex so the chip reads from the design tokens.
 * It used to hand back Riot red, which put every competitive match behind the
 * app's negative signal colour and made a routine mode label look like a
 * warning; the accent says "notable" without saying "bad".
 */
export const queueAccent = (queueId: string | null | undefined) =>
  (queueId ?? "").toLowerCase() === "competitive"
    ? "border-(--accent-border) bg-(--accent-soft) text-(--accent-selected)"
    : "border-(--border) bg-(--control) text-(--text-secondary)";
