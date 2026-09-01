export const CUSTOM_COMMAND_WHENS = [
	"command",
	"onPregame",
	"onMatchStart",
	"onMatchEnd",
] as const;

export type CustomCommandWhen = typeof CUSTOM_COMMAND_WHENS[number];
export type CustomCommandAction = "send" | "tran";
export type CustomCommandChannel = "direct" | "party" | "pregame" | "team" | "all";

export interface CustomBotCommand {
	when: CustomCommandWhen;
	trigger: string;
	action: CustomCommandAction;
	channel: CustomCommandChannel;
	language: string;
	message: string;
	count: number;
}

const ACTIONS: readonly CustomCommandAction[] = ["send", "tran"];
const CHANNELS: readonly CustomCommandChannel[] = ["direct", "party", "pregame", "team", "all"];

export const isLifecycleWhen = (
	when: CustomCommandWhen,
): when is Exclude<CustomCommandWhen, "command"> => when !== "command";

const isWhen = (value: unknown): value is CustomCommandWhen =>
	typeof value === "string" && CUSTOM_COMMAND_WHENS.includes(value as CustomCommandWhen);

const isAction = (value: unknown): value is CustomCommandAction =>
	typeof value === "string" && ACTIONS.includes(value as CustomCommandAction);

const isChannel = (value: unknown): value is CustomCommandChannel =>
	typeof value === "string" && CHANNELS.includes(value as CustomCommandChannel);

export const normalizeCustomBotCommand = (
	value: Partial<CustomBotCommand> | null | undefined,
): CustomBotCommand => {
	const when = isWhen(value?.when) ? value.when : "command";
	const action = isAction(value?.action) ? value.action : "send";
	const rawChannel = isChannel(value?.channel) ? value.channel : "party";
	const count = Math.min(10, Math.max(1, Math.trunc(Number(value?.count) || 1)));
	const normalized = {
		when,
		trigger: typeof value?.trigger === "string" ? value.trigger : "",
		action,
		channel: action === "tran" && rawChannel === "direct" ? "party" : rawChannel,
		language: typeof value?.language === "string" && value.language.trim()
			? value.language.trim()
			: "none",
		message: typeof value?.message === "string" ? value.message : "",
		count,
	} satisfies CustomBotCommand;

	return isLifecycleWhen(when)
		? { ...normalized, trigger: "", action: "send", channel: "direct" }
		: normalized;
};

export const normalizeCustomBotCommands = (value: unknown): CustomBotCommand[] => {
	if (!Array.isArray(value)) return [];
	const lifecycle = new Set<CustomCommandWhen>();
	const commands: CustomBotCommand[] = [];
	for (const item of value) {
		const command = normalizeCustomBotCommand(
			item && typeof item === "object" ? item as Partial<CustomBotCommand> : undefined,
		);
		if (isLifecycleWhen(command.when)) {
			if (lifecycle.has(command.when)) continue;
			lifecycle.add(command.when);
		}
		commands.push(command);
	}
	return commands;
};
