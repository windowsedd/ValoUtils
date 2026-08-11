import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./use-chat-controller.ts", import.meta.url), "utf8");

describe("useChatController IPC lifecycle", () => {
	test("owns and removes exact callbacks", () => {
		expect(source).toContain('window.Main.on("chat:get", onSummary)');
		expect(source).toContain('window.Main.removeListener("chat:get", onSummary)');
		expect(source).toContain('window.Main.on("chat:history", onHistory)');
		expect(source).toContain('window.Main.removeListener("chat:history", onHistory)');
		expect(source).toContain('window.Main.on("chat:message", onRealtimeMessage)');
		expect(source).toContain('window.Main.removeListener("chat:message", onRealtimeMessage)');
		expect(source).toContain('window.Main.on("chat:presence", onPresence)');
		expect(source).toContain('window.Main.removeListener("chat:presence", onPresence)');
		expect(source).toContain('window.Main.on("chat:send", onSend)');
		expect(source).toContain('window.Main.removeListener("chat:send", onSend)');
		expect(source).not.toContain("removeAllListeners");
		expect(source).not.toContain('window.Main.send("chat:disconnect")');
	});

	test("presence snapshots update friends without waiting for summary polling", () => {
		expect(source).toContain("friends: applyPresenceSnapshot(current.friends, snapshot)");
		expect(source).not.toContain('window.Main.send("chat:get"); // presence');
	});

	test("requests history and sends with request ids", () => {
		expect(source).toContain('window.Main.send("chat:history", requestId, cid)');
		expect(source).toContain('window.Main.send("chat:send", requestId, selectedCid, text)');
	});

	test("realtime messages update cache without selecting a channel", () => {
		expect(source).toContain('dispatch({ type: "realtimeMessage", message })');
		expect(source).not.toContain('selectChannel(channelForCid(message.conversationId))');
	});
});
