import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import catalog from "../src/shared/bot-template-variables.json";

const root = join(import.meta.dir, "..");
const page = readFileSync(join(root, "src/pages/DummyBot.tsx"), "utf8");
const settings = readFileSync(join(root, "src/pages/Settings.tsx"), "utf8");
const locales = ["en", "ko", "zh-TW"] as const;
const requiredKeys = [
	"title",
	"relayTitle",
	"connected",
	"waiting",
	"presenceMasking",
	"lobbyForwarding",
	"enabled",
	"disabled",
	"launchWithRelay",
	"launch",
	"launchFailed",
	"conversationTitle",
	"conversationDescription",
	"fallbackName",
	"empty",
	"commandsTitle",
	"command.online",
	"command.offline",
	"command.mobile",
	"command.enable",
	"command.disable",
	"command.status",
	"command.help",
	"translateSyntax",
	"translateDesc",
	"translateExample",
	"historySyntax",
	"historyDesc",
	"historyExample",
	"dodgeSyntax",
	"dodgeDesc",
	"customTitle",
	"customDesc",
	"customAdd",
	"customRemove",
	"customActionSend",
	"customActionTran",
	"customMessagePlaceholder",
	"customTriggerRequired",
	"customTriggerReserved",
	"customTriggerExists",
	"customMessageRequired",
	"mode.online",
	"mode.offline",
	"mode.mobile",
] as const;
const templateKeys = [
	"variablesButton",
	"variablesLabel",
	"variableGroup.enemy",
	"variableGroup.ally",
	"variableGroup.me",
	"variableGroup.match",
] as const;

const get = (value: Record<string, unknown>, path: string) =>
	path.split(".").reduce<unknown>((current, key) =>
		current && typeof current === "object"
			? (current as Record<string, unknown>)[key]
			: undefined,
	value);

describe("FakePlayer localization", () => {
	for (const locale of locales) {
		test(`${locale} contains the complete FakePlayer copy`, () => {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			).dummyBot as Record<string, unknown>;

			for (const key of requiredKeys) {
				expect(get(messages, key), `${locale}: dummyBot.${key}`).toBeString();
				expect((get(messages, key) as string).trim().length).toBeGreaterThan(0);
			}
			for (const key of templateKeys) {
				expect(get(messages, key), `${locale}: dummyBot.${key}`).toBeString();
				expect((get(messages, key) as string).trim().length).toBeGreaterThan(0);
			}
			for (const item of catalog) {
				const key = item.descriptionKey.replace("dummyBot.", "");
				expect(get(messages, key), `${locale}: ${item.descriptionKey}`).toBeString();
				expect((get(messages, key) as string).trim().length).toBeGreaterThan(0);
			}
		});
	}

	test("custom Send commands use the template autocomplete editor", () => {
		expect(page).toContain("BotCommandMessageEditor");
		expect(page).toContain("value={draft.message}");
		expect(page).toContain("onChange={(message)");
	});

	test("visible copy uses Bot terminology instead of FakePlayer", () => {
		for (const locale of locales) {
			const messages = JSON.parse(
				readFileSync(join(root, `src/i18n/locales/${locale}.json`), "utf8"),
			);
			const visibleCopy = JSON.stringify(messages);
			expect(visibleCopy).not.toMatch(/FakePlayer/i);
		}
		expect(settings).not.toMatch(/FakePlayer/i);
	});

	test("the page resolves visible copy through i18next", () => {
		expect(page).toContain("useTranslation");
		expect(page).toContain('t("dummyBot.title")');
		expect(page).toContain('t("dummyBot.commandsTitle")');
		expect(page).toContain('t("dummyBot.translateSyntax")');
		expect(page).toContain('t("dummyBot.translateExample")');
		expect(page).toContain('t("dummyBot.dodgeSyntax")');
		expect(page).toContain('t("dummyBot.customTitle")');
		expect(page).not.toContain('title="In-game FakePlayer"');
		expect(page).not.toContain(">Launch</button>");
		expect(page).not.toContain("No relay messages yet.");
	});

	test("blank custom-command language is saved as none", () => {
		expect(page).toContain('language: draft.language.trim() || "none"');
	});
});
