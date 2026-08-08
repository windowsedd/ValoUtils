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

export const queueLabel = (queueId: string | null | undefined) =>
	QUEUE_LABELS[(queueId ?? "").toLowerCase()] ?? queueId ?? "";

/** Accent for a queue chip — ranked play is the only one that gets colour. */
export const queueAccent = (queueId: string | null | undefined) =>
	(queueId ?? "").toLowerCase() === "competitive" ? "#ff4655" : "#6b7280";
