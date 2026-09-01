import catalog from "@/shared/bot-template-variables.json";

export type BotTemplateGroup = "enemy" | "ally" | "me" | "match";
export type BotTemplateDataLevel = "roster" | "recent" | "content";
export type BotTemplateVariable = {
	id: string;
	group: BotTemplateGroup;
	descriptionKey: string;
	example: string;
	dataLevel: BotTemplateDataLevel;
};
export type ActiveTemplateRange = { start: number; end: number; query: string };
export type AutocompleteKey = "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape" | string;

export const BOT_TEMPLATE_VARIABLES = catalog as BotTemplateVariable[];

export const findActiveTemplateRange = (value: string, caret: number): ActiveTemplateRange | null => {
	const beforeCaret = value.slice(0, Math.max(0, caret));
	const start = beforeCaret.lastIndexOf("{{");
	if (start < 0 || beforeCaret.lastIndexOf("}}") > start) return null;
	const query = beforeCaret.slice(start + 2);
	if (!/^[a-z0-9_]*$/i.test(query)) return null;
	return { start, end: caret, query };
};

export const filterTemplateVariables = (
	query: string,
	descriptionOf: (item: BotTemplateVariable) => string,
) => {
	const wanted = query.trim().toLocaleLowerCase();
	if (!wanted) return BOT_TEMPLATE_VARIABLES;
	return BOT_TEMPLATE_VARIABLES.filter((item) =>
		item.id.includes(wanted) || descriptionOf(item).toLocaleLowerCase().includes(wanted),
	);
};

export const insertTemplateVariable = (value: string, caret: number, id: string) => {
	const range = findActiveTemplateRange(value, caret);
	const start = range?.start ?? caret;
	const end = range?.end ?? caret;
	const inserted = `{{${id}}}`;
	return {
		value: value.slice(0, start) + inserted + value.slice(end),
		caret: start + inserted.length,
	};
};

export const autocompleteKeyAction = (key: AutocompleteKey, activeIndex: number, count: number) => {
	if (key === "Escape") return { handled: true, activeIndex, commit: false, dismiss: true };
	if (key === "Enter" || key === "Tab") return { handled: count > 0, activeIndex, commit: count > 0, dismiss: false };
	if (key === "ArrowDown" && count > 0) return { handled: true, activeIndex: (activeIndex + 1) % count, commit: false, dismiss: false };
	if (key === "ArrowUp" && count > 0) return { handled: true, activeIndex: (activeIndex - 1 + count) % count, commit: false, dismiss: false };
	return { handled: false, activeIndex, commit: false, dismiss: false };
};
