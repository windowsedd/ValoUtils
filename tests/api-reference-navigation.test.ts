import { describe, expect, test } from "bun:test";

const main = await Bun.file("src/main.tsx").text();
const settings = await Bun.file("src/pages/Settings.tsx").text();
const swagger = await Bun.file("src/pages/SwaggerPage.tsx").text();

describe("API Reference navigation ownership", () => {
	test("is not a primary navbar route", () => {
		expect(main).not.toContain('id: "swagger"');
	});

	test("is opened from the Developer settings section", () => {
		expect(settings).toContain('import SwaggerPage from "@/pages/SwaggerPage"');
		expect(settings).toContain('description={t("apiReference.subtitle")}');
		expect(settings).toContain("<SwaggerPage onBack=");
	});

	test("provides a back action to Settings", () => {
		expect(swagger).toContain("onBack?: () => void");
	});
});

describe("Test Lab", () => {
	test("is removed from navigation and settings", () => {
		expect(main).not.toContain('id: "test-lab"');
		expect(main).not.toContain('title: "nav.testLab"');
		expect(main).not.toContain("ChatLab");
		expect(settings).not.toContain('from "@/pages/ChatLab"');
		expect(settings).not.toContain("<TestLabPanel");
		expect(settings).not.toContain('setView("chat-lab")');
	});
});
