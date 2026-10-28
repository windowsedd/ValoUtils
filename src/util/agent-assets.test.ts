import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/i18n/config", () => ({ default: { language: "en" } }));

const { agentIdsKey } = await import("./use-agent-assets");

const realFetch = globalThis.fetch;

/** A fresh copy of the module, so its memoised agent list starts empty. */
const load = async () => import(`./valorant-assets.ts?case=${Math.random()}`);

const agentsBody = (...ids: string[]) =>
	Response.json({ data: ids.map((uuid) => ({ uuid, displayName: uuid, displayIcon: `${uuid}.png` })) });

/** Serves each response in turn to `/agents` requests, recording them. */
const serveAgents = (...responses: (() => Response)[]) => {
	const asked: string[] = [];
	globalThis.fetch = (async (url: string) => {
		asked.push(String(url));
		const next = responses.shift();
		if (!next) throw new Error("unexpected request");
		return next();
	}) as typeof fetch;
	return asked;
};

// No Cache Storage under bun, so `cachedFetch` is a plain fetch here.
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("getAgents", () => {
	test("reuses the list while every requested agent is in it", async () => {
		const asked = serveAgents(() => agentsBody("jett", "sage"));
		const { getAgents } = await load();
		expect([...(await getAgents()).keys()]).toEqual(["jett", "sage"]);
		expect((await getAgents(["JETT", null, "sage"])).has("jett")).toBe(true);
		expect(asked).toHaveLength(1);
	});

	test("downloads the list again once when an agent is missing", async () => {
		const asked = serveAgents(
			() => agentsBody("jett"),
			() => agentsBody("jett", "newagent"),
		);
		const { getAgents } = await load();
		await getAgents();
		const [first, second] = await Promise.all([getAgents(["newagent"]), getAgents(["newagent"])]);
		expect(first.get("newagent")?.icon).toBe("newagent.png");
		expect(second).toBe(first);
		// A still-unknown agent does not refetch again this session.
		expect((await getAgents(["unknown"])).has("unknown")).toBe(false);
		expect(asked).toHaveLength(2);
	});

	test("a failed download is retried on the next call", async () => {
		const asked = serveAgents(
			() => new Response("down", { status: 503 }),
			() => agentsBody("jett"),
		);
		const { getAgents } = await load();
		expect((await getAgents()).size).toBe(0);
		expect((await getAgents()).has("jett")).toBe(true);
		expect(asked).toHaveLength(2);
	});
});

describe("agentIdsKey", () => {
	test("ignores order, case, duplicates and blanks", () => {
		expect(agentIdsKey(["B", null, "a", "b", undefined, ""])).toBe("a,b");
	});
});
