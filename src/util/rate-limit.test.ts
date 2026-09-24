import { describe, expect, it } from "bun:test";
import { rateLimitedSeconds } from "./rate-limit";

describe("rateLimitedSeconds", () => {
	it("reads the cooldown the gate reported", () => {
		expect(rateLimitedSeconds({ code: "rateLimited", retryInSeconds: 47 })).toBe(47);
	});

	it("falls back to a minute when the reply carried no cooldown", () => {
		// `cooldown_seconds` is None once the hold has already lapsed, and a
		// page still needs a number to put in the message.
		expect(rateLimitedSeconds({ code: "rateLimited" })).toBe(60);
		expect(rateLimitedSeconds({ code: "rateLimited", retryInSeconds: null })).toBe(60);
		expect(rateLimitedSeconds({ code: "rateLimited", retryInSeconds: 0 })).toBe(60);
	});

	it("leaves every other failure to the caller", () => {
		expect(rateLimitedSeconds({ code: "loginRequired" })).toBeNull();
		expect(rateLimitedSeconds({})).toBeNull();
	});
});
