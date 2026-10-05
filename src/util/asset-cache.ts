/**
 * A disk cache for valorant-api.com responses, so a launch does not download
 * agents, maps, tiers, skins and bundles (often every language at once) again.
 *
 * Responses live in the WebView's Cache Storage, which survives restarts. They
 * are served straight from disk; the data only changes with a game patch, so
 * one small `/version` request per session decides whether to keep them. That
 * check runs in the background and never delays a lookup: after a patch the
 * cache is cleared for the next launch, and anything new this session (a skin
 * released in the patch) is a cache miss that goes to the network anyway.
 *
 * Anywhere Cache Storage is missing or refuses (tests, a locked profile), this
 * is a plain `fetch`.
 */

const CACHE_NAME = "valorant-api-v1";
const VERSION_URL = "https://valorant-api.com/v1/version";
const VERSION_KEY = "valoutils.valorantApiVersion";

let cachePromise: Promise<Cache | null> | null = null;

const readStoredVersion = () => {
	try {
		return localStorage.getItem(VERSION_KEY);
	} catch {
		return null;
	}
};

const storeVersion = (version: string) => {
	try {
		localStorage.setItem(VERSION_KEY, version);
	} catch {
		/* Without storage the cache is simply checked again next launch. */
	}
};

/** The game build valorant-api.com serves, used as the cache's version. */
export const assetVersionOf = (body: unknown): string | null => {
	const data = (body as { data?: Record<string, unknown> } | null)?.data;
	const version = data?.manifestId ?? data?.riotClientBuild ?? data?.version;
	return typeof version === "string" && version ? version : null;
};

/** Drops the cache when valorant-api.com reports a different game build. */
const checkVersion = async () => {
	try {
		const response = await fetch(VERSION_URL);
		if (!response.ok) return;
		const version = assetVersionOf(await response.json());
		if (!version) return;
		const stored = readStoredVersion();
		if (stored && stored !== version) await caches.delete(CACHE_NAME);
		storeVersion(version);
	} catch {
		/* Offline: keep serving what is on disk. */
	}
};

const openCache = (): Promise<Cache | null> => {
	if (!cachePromise) {
		cachePromise =
			typeof caches === "undefined"
				? Promise.resolve(null)
				: caches.open(CACHE_NAME).then(
						(cache) => {
							void checkVersion();
							return cache;
						},
						() => null,
					);
	}
	return cachePromise;
};

/**
 * `fetch` for valorant-api.com data: a cached response when there is one,
 * otherwise the network, keeping successful answers for next time.
 */
export const cachedFetch = async (url: string): Promise<Response> => {
	const cache = await openCache();
	if (cache) {
		try {
			const hit = await cache.match(url);
			if (hit) return hit;
		} catch {
			/* Fall through to the network. */
		}
	}
	const response = await fetch(url);
	if (cache && response.ok) {
		cache.put(url, response.clone()).catch(() => {});
	}
	return response;
};
