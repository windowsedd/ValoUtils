import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "src/main.tsx"), "utf8");
const chat = readFileSync(join(root, "src/pages/Chat.tsx"), "utf8");

describe("Chat navigation and page shell", () => {
	test("restores a hideable Chat route immediately after Friends", () => {
		expect(main).toContain('import Chat from "@/pages/Chat.tsx"');
		expect(main).toContain('title: "nav.chat"');
		expect(main).toContain('id: "chat"');
		expect(main.indexOf('id: "friends"')).toBeLessThan(main.indexOf('id: "chat"'));
		expect(main.indexOf('id: "chat"')).toBeLessThan(main.indexOf('id: "replays"'));
	});

	test("uses the shared controller and the new four-part Chat UI", () => {
		expect(chat).toContain("useChatController()");
		expect(chat).toContain("<ChatChannelRail");
		expect(chat).toContain("<ChatConversationList");
		expect(chat).toContain("<ChatThread");
		expect(chat).toContain("<ChatComposer");
		expect(chat).toContain("<ChatFriendsPanel");
		expect(chat).not.toContain("removeAllListeners");
		expect(chat).not.toContain('send("chat:disconnect")');
	});
});
