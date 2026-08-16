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
	test("is owned by its primary navbar route", async () => {
		const lab = await Bun.file("src/pages/ChatLab.tsx").text();
		expect(main).toContain('id: "test-lab"');
		expect(main).toContain('title: "nav.testLab"');
		expect(settings).not.toContain('from "@/pages/ChatLab"');
		expect(settings).not.toContain("<TestLabPanel");
		expect(settings).not.toContain('setView("chat-lab")');
		expect(lab).toContain("chat:lab-info");
		expect(lab).toContain("chat:lab-send");
		expect(lab).toContain("chatLab.partyInfo");
		expect(lab).toContain("chatLab.pregameInfo");
		expect(lab).toContain("chatLab.currentInfo");
		expect(lab).toContain("chatLab.allInfo");
	});
});
