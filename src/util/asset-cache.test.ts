import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const realCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");

/** A fresh copy of the module, so its memoised cache handle starts empty. */
const load = async () => import(`./asset-cache.ts?case=${Math.random()}`);

const fakeCaches = () => {
	const stored = new Map<string, Response>();
	let deleted = 0;
	const cache = {
		match: async (url: string) => stored.get(url)?.clone(),
		put: async (url: string, response: Response) => {
			stored.set(url, response);
		},
	};
	Object.defineProperty(globalThis, "caches", {
		configurable: true,
		value: { open: async () => cache, delete: async () => ((deleted += 1), true) },
	});
	return { stored, deletions: () => deleted };
};

afterEach(() => {
	globalThis.fetch = realFetch;
	if (realCaches) Object.defineProperty(globalThis, "caches", realCaches);
	else Reflect.deleteProperty(globalThis, "caches");
});

describe("cachedFetch", () => {
	test("serves a stored response without going to the network", async () => {
		const { stored } = fakeCaches();
		stored.set("https://valorant-api.com/v1/maps", Response.json({ data: ["Ascent"] }));
		const asked: string[] = [];
		globalThis.fetch = (async (url: string) => {
			asked.push(String(url));
			return Response.json({ data: { manifestId: "1" } });
		}) as typeof fetch;

		const { cachedFetch } = await load();
		const body = await (await cachedFetch("https://valorant-api.com/v1/maps")).json();
		expect(body).toEqual({ data: ["Ascent"] });
		expect(asked.filter((url) => url.endsWith("/maps"))).toEqual([]);
	});

	test("keeps a successful network answer for next time, but not a failure", async () => {
		const { stored } = fakeCaches();
		globalThis.fetch = (async (url: string) =>
			String(url).includes("missing")
				? new Response("nope", { status: 404 })
				: Response.json({ data: { manifestId: "1" } })) as typeof fetch;

		const { cachedFetch } = await load();
		await cachedFetch("https://valorant-api.com/v1/agents");
		await cachedFetch("https://valorant-api.com/v1/missing");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(stored.has("https://valorant-api.com/v1/agents")).toBe(true);
		expect(stored.has("https://valorant-api.com/v1/missing")).toBe(false);
	});

	test("is a plain fetch where Cache Storage does not exist", async () => {
		Reflect.deleteProperty(globalThis, "caches");
		globalThis.fetch = (async () => Response.json({ ok: 1 })) as unknown as typeof fetch;
		const { cachedFetch } = await load();
		expect(await (await cachedFetch("https://valorant-api.com/v1/maps")).json()).toEqual({ ok: 1 });
	});
});

describe("assetVersionOf", () => {
	test("reads the game build valorant-api.com serves", async () => {
		const { assetVersionOf } = await load();
		expect(assetVersionOf({ data: { manifestId: "ABC", version: "11.07" } })).toBe("ABC");
		expect(assetVersionOf({ data: { version: "11.07" } })).toBe("11.07");
		expect(assetVersionOf({ data: {} })).toBeNull();
		expect(assetVersionOf(null)).toBeNull();
	});
});
