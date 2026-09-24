/**
 * A reply the backend refused because Riot's request budget is spent.
 *
 * The pd-backed commands used to pass the refusal through as `error`, so a
 * throttle reached the page as the rate gate's own JSON blob. They answer with
 * a `rateLimited` code now, and this turns it into something a page can say.
 */
export type RateLimitedReply = {
	code?: unknown;
	retryInSeconds?: unknown;
};

/** The gate's fallback wait, for a reply that carried no cooldown of its own. */
const DEFAULT_RETRY_SECONDS = 60;

/**
 * Seconds until the request is worth retrying, or `null` when the reply failed
 * for some other reason and the caller's own error message applies.
 */
export const rateLimitedSeconds = (response: unknown): number | null => {
	// `unknown` rather than the shape above: every caller holds a parsed reply
	// whose failure arms differ, and a parameter of only-optional properties is
	// one TypeScript refuses to accept anything with nothing in common.
	if (!response || typeof response !== "object") return null;
	const { code, retryInSeconds } = response as RateLimitedReply;
	if (code !== "rateLimited") return null;
	return typeof retryInSeconds === "number" && retryInSeconds > 0
		? Math.round(retryInSeconds)
		: DEFAULT_RETRY_SECONDS;
};
