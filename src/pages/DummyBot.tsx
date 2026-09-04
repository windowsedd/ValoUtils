import { PageHeader, SectionCard, SectionRow, pageBodyClass } from "@/components/section-card";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuBot, LuPencil, LuPlay, LuPlus, LuTrash2, LuX } from "react-icons/lu";
import {
	CUSTOM_COMMAND_WHENS,
	channelsForCustomCommand,
	isLifecycleWhen,
	normalizeCustomBotCommand,
	normalizeCustomBotCommands,
	type CustomBotCommand,
	type CustomCommandWhen,
} from "./bot-custom-command";
import { BotCommandMessageEditor } from "./bot-command-message-editor";
import { BotLanguageCombobox } from "./bot-language-combobox";
import type { TranslationProvider } from "@/util/translation-languages";

type Message = { id: string; body: string; timestamp: string; isSelf: boolean };
type FakePlayerState = {
	success: boolean;
	displayName: string;
	messages: Message[];
	presence: { enabled: boolean; mode: string; connectToMuc: boolean; activeConnections: number };
};
type LaunchState = {
	success: boolean; running: boolean; url: string; riotClientRunning: boolean;
	relayRunning: boolean; relayPort: number | null; activeConnections: number;
	upstreamReady: boolean; presenceMode: string; lastWarning: string | null;
};

const fieldClass =
	"min-w-0 w-full rounded-[6px] border border-(--border) bg-(--control) px-2 py-1.5 text-[12px] text-(--text-primary) outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]";

/** Labelled wrapper so each builder control says what it sets. */
const Field = ({
	label,
	className = "",
	children,
}: {
	label: string;
	className?: string;
	children: ReactNode;
}) => (
	<label className={`flex min-w-0 flex-col gap-1 ${className}`}>
		<span className="text-[10px] uppercase tracking-widest text-(--text-muted)">{label}</span>
		{children}
	</label>
);

const DummyBot = () => {
	const { t } = useTranslation();
	const [state, setState] = useState<FakePlayerState | null>(null);
	const [launch, setLaunch] = useState<LaunchState | null>(null);
	const [launchError, setLaunchError] = useState<string | null>(null);
	const [launchBusy, setLaunchBusy] = useState(false);
	const [customCommands, setCustomCommands] = useState<CustomBotCommand[]>([]);
	const [draft, setDraft] = useState<CustomBotCommand>({
		when: "command",
		trigger: "",
		action: "send",
		channel: "team",
		language: "zh_tw",
		message: "",
		count: 1,
	});
	const [customError, setCustomError] = useState<string | null>(null);
	/** Index being edited, or null while composing a new command. */
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	/** Drives the language list; the bot translates through whichever provider Settings picked. */
	const [provider, setProvider] = useState<TranslationProvider>("google");
	const transcriptRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const applyState = (message: string) => { try { setState(JSON.parse(message)); } catch { /* ignore */ } };
		const applyLaunch = (message: string) => { try { setLaunch(JSON.parse(message)); } catch { /* ignore */ } };
		const launched = (message: string) => {
			setLaunchBusy(false);
			try { const result = JSON.parse(message); setLaunchError(result.success ? null : result.error); }
			catch { setLaunchError(t("dummyBot.launchFailed")); }
		};
		const applyConfig = (message: string) => {
			try {
				const config = JSON.parse(message) as {
					botCustomCommands?: unknown;
					translatorProvider?: unknown;
				};
				setCustomCommands(normalizeCustomBotCommands(config.botCustomCommands));
				setProvider(config.translatorProvider === "deepl" ? "deepl" : "google");
			} catch { /* ignore */ }
		};
		window.Main.on("fake_player:state", applyState);
		window.Main.on("client:config-status", applyLaunch);
		window.Main.on("riot:launch-with-config", launched);
		window.Main.on("riot:launch-normal", launched);
		window.Main.on("config:get-all", applyConfig);
		const poll = () => { window.Main.send("fake_player:state"); window.Main.send("client:config-status"); window.Main.send("config:get-all"); };
		poll();
		const timer = setInterval(poll, 2000);
		return () => {
			clearInterval(timer);
			window.Main.removeAllListeners("fake_player:state");
			window.Main.removeAllListeners("client:config-status");
			window.Main.removeAllListeners("riot:launch-with-config");
			window.Main.removeAllListeners("riot:launch-normal");
			window.Main.removeAllListeners("config:get-all");
		};
	}, [t]);

	const removeCustomCommand = (index: number) => {
		// Indices shift on delete, so an open editor would silently retarget.
		if (editingIndex !== null) setEditingIndex(null);
		setDraft((current) => normalizeCustomBotCommand({ ...current, when: "command", trigger: "", message: "" }));
		setCustomError(null);
		saveCustomCommands(customCommands.filter((_, commandIndex) => commandIndex !== index));
	};

	const saveCustomCommands = (next: CustomBotCommand[]) => {
		const normalized = normalizeCustomBotCommands(next);
		setCustomCommands(normalized);
		window.Main.send("config:set", "botCustomCommands", normalized);
	};

	const blankDraft: CustomBotCommand = {
		when: "command",
		trigger: "",
		action: "send",
		channel: "team",
		language: draft.language,
		message: "",
		count: 1,
	};

	const cancelEdit = () => {
		setEditingIndex(null);
		setDraft(normalizeCustomBotCommand(blankDraft));
		setCustomError(null);
	};

	const startEdit = (index: number) => {
		const target = customCommands[index];
		if (!target) return;
		setEditingIndex(index);
		setDraft(normalizeCustomBotCommand({ ...target }));
		setCustomError(null);
	};

	const submitCustomCommand = () => {
		const lifecycle = isLifecycleWhen(draft.when);
		const trigger = lifecycle ? "" : normalizeTrigger(draft.trigger);
		// The row being edited must not collide with itself.
		const others = customCommands.filter((_, index) => index !== editingIndex);
		if (!lifecycle) {
			if (!trigger) {
				setCustomError(t("dummyBot.customTriggerRequired"));
				return;
			}
			if (RESERVED.has(trigger)) {
				setCustomError(t("dummyBot.customTriggerReserved"));
				return;
			}
			if (others.some((item) => item.when === "command" && normalizeTrigger(item.trigger) === trigger)) {
				setCustomError(t("dummyBot.customTriggerExists"));
				return;
			}
		} else if (others.some((item) => item.when === draft.when)) {
			setCustomError(t("dummyBot.customLifecycleExists"));
			return;
		}
		if (draft.action === "send" && !draft.message.trim()) {
			setCustomError(t("dummyBot.customMessageRequired"));
			return;
		}
		const entry = normalizeCustomBotCommand({
			...draft,
			trigger,
			language: draft.language.trim() || "none",
			message: draft.message.trim(),
			count: Math.max(1, Number(draft.count) || 1),
		});
		saveCustomCommands(
			editingIndex === null
				? [...customCommands, entry]
				: customCommands.map((item, index) => (index === editingIndex ? entry : item)),
		);
		setEditingIndex(null);
		setDraft(normalizeCustomBotCommand(blankDraft));
		setCustomError(null);
	};

	const selectWhen = (when: CustomCommandWhen) => {
		const others = customCommands.filter((_, index) => index !== editingIndex);
		if (isLifecycleWhen(when) && others.some((item) => item.when === when)) {
			setCustomError(t("dummyBot.customLifecycleExists"));
			return;
		}
		setDraft((current) => normalizeCustomBotCommand(when === "command"
			? { ...current, when, trigger: "", action: "send", channel: "team" }
			: { ...current, when }));
		setCustomError(null);
	};

	useEffect(() => { if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }, [state?.messages.length]);
	const messages = state?.messages ?? [];
	/*
	 * Three distinct conditions were collapsed into one "Connected / Waiting"
	 * word: a relay that isn't up at all reads the same as one that is up and
	 * simply has nobody attached yet.
	 */
	const relay = launch?.activeConnections
		? { key: "connected", tone: "text-(--signal-pos)", dot: "bg-(--signal-pos)" }
		: launch?.relayRunning
			? { key: "waiting", tone: "text-(--signal-warn)", dot: "bg-(--signal-warn)" }
			: { key: "relayStopped", tone: "text-(--text-muted)", dot: "bg-(--text-muted)" };
	// Status is null until the first poll lands, so treat unknown as "can't yet".
	const launchDisabled = launchBusy || launch?.riotClientRunning !== false;
	const presenceMode = state?.presence.enabled
		? t(`dummyBot.mode.${state.presence.mode}`, { defaultValue: state.presence.mode })
		: t("dummyBot.disabled");

	return <div className="flex h-full min-h-0 flex-col">
		<PageHeader icon={<LuBot className="text-lg" />} title={t("dummyBot.title")} subtitle={state?.displayName} />
		<div className={pageBodyClass}>
			<SectionCard
				title={t("dummyBot.relayTitle")}
				right={
					<span className="flex items-center gap-1.5">
						<span className={`h-1.5 w-1.5 rounded-full ${relay.dot}`} aria-hidden="true" />
						<span className={relay.tone}>{t(`dummyBot.${relay.key}`)}</span>
					</span>
				}
			>
				<SectionRow>
					<span className="text-[12px] text-(--text-secondary)">{t("dummyBot.clients")}</span>
					<span className="text-[12px] tabular-nums text-(--text-primary)">
						{launch?.activeConnections ?? 0}
					</span>
				</SectionRow>
				<SectionRow>
					<span className="text-[12px] text-(--text-secondary)">{t("dummyBot.presenceMasking")}</span>
					<span className="text-[12px] text-(--text-primary)">{presenceMode}</span>
				</SectionRow>
				<SectionRow>
					<span className="text-[12px] text-(--text-secondary)">{t("dummyBot.lobbyForwarding")}</span>
					<span className="text-[12px] text-(--text-primary)">
						{t(state?.presence.connectToMuc ? "dummyBot.enabled" : "dummyBot.disabled")}
					</span>
				</SectionRow>
				<SectionRow>
					<span className="text-[12px] text-(--text-secondary)">{t("dummyBot.endpoint")}</span>
					<span className="truncate font-mono text-[11px] text-(--text-muted)">
						{launch?.url ?? "http://127.0.0.1:8000"}
					</span>
				</SectionRow>
				<SectionRow leader={false}>
					<div className="min-w-0 flex-1">
						<p className="text-[12px] text-(--text-primary)">{t("dummyBot.launchWithRelay")}</p>
						{/*
						 * `--client-config-url` is only read at process start, so the backend
						 * refuses while a client is alive. Saying so beats a dead button.
						 */}
						<p className="mt-0.5 text-[11px] leading-4 text-(--text-muted)">
							{launch?.riotClientRunning === true
								? t("dummyBot.launchBlocked")
								: `--client-config-url=${launch?.url ?? "http://127.0.0.1:8000"}`}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<button
							type="button"
							onClick={() => { setLaunchBusy(true); setLaunchError(null); window.Main.send("riot:launch-normal", "valorant", "live"); }}
							disabled={launchDisabled}
							className="flex h-8 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[12px] font-medium text-(--text-primary) transition-colors hover:bg-(--surface-hover) disabled:cursor-not-allowed disabled:opacity-40"
						>
							<LuPlay className="h-3 w-3" />
							{t("dummyBot.launchNormal")}
						</button>
						<button
							type="button"
							onClick={() => { setLaunchBusy(true); setLaunchError(null); window.Main.send("riot:launch-with-config", "valorant", "live"); }}
							disabled={launchDisabled}
							className="flex h-8 items-center gap-1.5 rounded-[6px] border border-(--accent-border) bg-(--accent-soft) px-3 text-[12px] font-medium text-(--accent-selected) transition-colors hover:bg-(--accent-soft-hover) disabled:cursor-not-allowed disabled:opacity-40"
						>
							<LuPlay className="h-3 w-3" />
							{t("dummyBot.launch")}
						</button>
					</div>
				</SectionRow>
				{launchError && <p className="px-2.5 pb-1 text-[11px] text-(--signal-neg)">{launchError}</p>}
				{launch?.lastWarning && <p className="px-2.5 pb-1 text-[11px] text-(--signal-warn)">{launch.lastWarning}</p>}
			</SectionCard>

			<SectionCard title={t("dummyBot.commandsTitle")}>
				{/*
				 * The seven presence toggles are one word each — a full row apiece was
				 * seven lines of mostly whitespace. Paired into a grid they read as the
				 * lookup table they are, leaving the multi-line syntax blocks below to
				 * keep the room they actually need.
				 */}
				<div className="grid gap-x-6 gap-y-1 px-2.5 py-1.5 sm:grid-cols-2">
					{(
						[
							["$online", "online"],
							["$offline", "offline"],
							["$mobile", "mobile"],
							["$enable", "enable"],
							["$disable", "disable"],
							["$status", "status"],
							["$help", "help"],
						] as const
					).map(([syntax, key]) => (
						<div key={syntax} className="readout gap-3 py-1">
							<span className="font-mono text-[12px] text-(--accent-selected)">{syntax}</span>
							<span aria-hidden="true" className="readout-leader" />
							<span className="text-[11px] text-(--text-secondary)">{t(`dummyBot.command.${key}`)}</span>
						</div>
					))}
				</div>

				{/*
				 * Spelled out rather than looped over key names: a static `t("…")` is
				 * what i18n extraction tooling can actually see.
				 */}
				<div className="border-t border-(--line) px-2.5 py-2">
					<p className="font-mono text-[12px] text-(--accent-selected)">{t("dummyBot.translateSyntax")}</p>
					<p className="mt-1 text-[11px] leading-5 text-(--text-secondary)">{t("dummyBot.translateDesc")}</p>
					<p className="mt-1 font-mono text-[11px] text-(--text-muted)">{t("dummyBot.translateExample")}</p>
				</div>
				<div className="border-t border-(--line) px-2.5 py-2">
					<p className="font-mono text-[12px] text-(--accent-selected)">{t("dummyBot.historySyntax")}</p>
					<p className="mt-1 text-[11px] leading-5 text-(--text-secondary)">{t("dummyBot.historyDesc")}</p>
					<p className="mt-1 font-mono text-[11px] text-(--text-muted)">{t("dummyBot.historyExample")}</p>
				</div>
				<div className="border-t border-(--line) px-2.5 py-2">
					<p className="font-mono text-[12px] text-(--accent-selected)">{t("dummyBot.dodgeSyntax")}</p>
					<p className="mt-1 text-[11px] leading-5 text-(--text-secondary)">{t("dummyBot.dodgeDesc")}</p>
				</div>
			</SectionCard>

			<SectionCard title={t("dummyBot.customTitle")} count={customCommands.length}>
				<p className="px-2.5 pb-1.5 text-[11px] leading-4 text-(--text-muted)">{t("dummyBot.customDesc")}</p>

				{customCommands.length === 0 && (
					<p className="px-2.5 py-4 text-center text-[11px] text-(--text-muted)">
						{t("dummyBot.customEmpty")}
					</p>
				)}

				{customCommands.map((item, index) => {
					const lifecycle = isLifecycleWhen(item.when);
					const direct = lifecycle || item.channel === "direct";
					return (
						<SectionRow
						key={`${item.when}:${item.trigger}:${index}`}
						leader={false}
						className={editingIndex === index ? "bg-(--accent-soft)" : ""}
					>
							{/* Trigger or event name — the thing you'd scan the list for. */}
							<span
								className={`shrink-0 rounded-[5px] border px-1.5 py-0.5 text-[11px] ${
									lifecycle
										? "border-(--border) bg-(--control) text-(--text-secondary)"
										: "border-(--accent-border) bg-(--accent-soft) font-mono text-(--accent-selected)"
								}`}
							>
								{lifecycle ? t(`dummyBot.customWhen.${item.when}`) : item.trigger}
							</span>
							<div className="flex min-w-0 flex-1 items-center gap-1.5">
								<span className="shrink-0 text-[11px] text-(--text-muted)">
									{item.action === "tran"
										? t("dummyBot.customActionTran")
										: t("dummyBot.customActionSend")}
								</span>
								<span className="shrink-0 text-[11px] text-(--text-secondary)">
									{direct ? t("dummyBot.customTargetDirect") : item.channel || "team"}
								</span>
								{item.action === "send" && item.language && item.language !== "none" && (
									<span className="shrink-0 font-mono text-[10px] text-(--text-muted)">{item.language}</span>
								)}
								<span className="truncate text-[11px] text-(--text-primary)">
									{item.action === "send"
										? item.message
										: t("dummyBot.customLineCount", { count: item.count || 1 })}
								</span>
							</div>
							<div className="flex shrink-0 items-center gap-0.5">
								<button
									type="button"
									className="rounded-[5px] p-1.5 text-(--text-muted) transition-colors hover:bg-(--surface-hover) hover:text-(--accent-selected)"
									onClick={() => startEdit(index)}
									aria-label={t("dummyBot.customEdit")}
									title={t("dummyBot.customEdit")}
								>
									<LuPencil className="h-3 w-3" />
								</button>
								<button
									type="button"
									className="rounded-[5px] p-1.5 text-(--text-muted) transition-colors hover:bg-(--surface-hover) hover:text-(--signal-neg)"
									onClick={() => removeCustomCommand(index)}
									aria-label={t("dummyBot.customRemove")}
									title={t("dummyBot.customRemove")}
								>
									<LuTrash2 className="h-3 w-3" />
								</button>
							</div>
						</SectionRow>
					);
				})}

				{/*
				 * The builder used to be six bare controls in one row, two of them
				 * `readOnly` inputs standing in for static text. Labelled fields in
				 * their own panel say what each one sets, and the fixed fields are now
				 * prose rather than boxes you can click but not edit.
				 */}
				<div className="mt-1 border-t border-(--line) px-2.5 pt-2.5">
					<p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-(--text-muted)">
						{editingIndex === null ? t("dummyBot.customNew") : t("dummyBot.customEditing")}
					</p>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					<Field label={t("dummyBot.customWhenLabel")}>
						<select
							value={draft.when}
							onChange={(event) => selectWhen(event.target.value as CustomCommandWhen)}
							className={fieldClass}
						>
							{CUSTOM_COMMAND_WHENS.map((when) => (
								<option
									key={when}
									value={when}
									disabled={isLifecycleWhen(when) && customCommands.some((item) => item.when === when)}
								>
									{t(`dummyBot.customWhen.${when}`)}
								</option>
							))}
						</select>
					</Field>

					{isLifecycleWhen(draft.when) ? (
						/* Lifecycle events have no trigger and always whisper you — that is
						   a fact to state, not two disabled boxes to render. */
						<div className="col-span-2 flex items-end sm:col-span-3">
							<p className="pb-1.5 text-[11px] leading-4 text-(--text-muted)">
								{t("dummyBot.customLifecycleNote")}
							</p>
						</div>
					) : (
						<>
							<Field label={t("dummyBot.customTriggerLabel")}>
								<input
									value={draft.trigger}
									onChange={(event) => setDraft((current) => ({ ...current, trigger: event.target.value }))}
									placeholder=".gg"
									className={`${fieldClass} font-mono`}
								/>
							</Field>
							<Field label={t("dummyBot.customActionLabel")}>
								<select
									value={draft.action}
									onChange={(event) => setDraft((current) => normalizeCustomBotCommand({ ...current, action: event.target.value as CustomBotCommand["action"] }))}
									className={fieldClass}
								>
									<option value="send">{t("dummyBot.customActionSend")}</option>
									<option value="tran">{t("dummyBot.customActionTran")}</option>
								</select>
							</Field>
							<Field label={t("dummyBot.customTargetLabel")}>
								<select
									value={draft.channel}
									onChange={(event) => setDraft((current) => ({ ...current, channel: event.target.value as CustomBotCommand["channel"] }))}
									className={fieldClass}
								>
									{channelsForCustomCommand(draft.action).map((channel) => (
										<option key={channel} value={channel}>
											{channel === "direct" ? t("dummyBot.customTargetDirect") : channel}
										</option>
									))}
								</select>
							</Field>
						</>
					)}

					{draft.action === "send" ? (
						<>
							<Field label={t("dummyBot.customLanguageLabel")}>
								<BotLanguageCombobox
									value={draft.language}
									onChange={(language) => setDraft((current) => ({ ...current, language }))}
									provider={provider}
									placeholder="ko-KR"
									inputClassName={fieldClass}
								/>
							</Field>
							<Field label={t("dummyBot.customMessageLabel")} className="col-span-2 sm:col-span-3">
								<BotCommandMessageEditor
									value={draft.message}
									onChange={(message) => setDraft((current) => ({ ...current, message }))}
									placeholder={t("dummyBot.customMessagePlaceholder")}
								/>
							</Field>
						</>
					) : (
						<Field label={t("dummyBot.customCountLabel")}>
							<input
								type="number"
								min={1}
								max={10}
								value={draft.count}
								onChange={(event) => setDraft((current) => ({ ...current, count: Number(event.target.value) }))}
								className={`${fieldClass} font-mono`}
							/>
						</Field>
					)}
					</div>

					<div className="mt-2 flex items-center justify-between gap-3 pb-2">
						<div className="min-w-0">
							{customError && <p className="text-[11px] text-(--signal-neg)">{customError}</p>}
							{(isLifecycleWhen(draft.when) || draft.channel === "direct") && (
								<p className="text-[11px] leading-4 text-(--text-muted)">
									{t("dummyBot.customDirectRequiresRelay")}
								</p>
							)}
						</div>
						<div className="flex shrink-0 items-center gap-2">
							{editingIndex !== null && (
								<button
									type="button"
									onClick={cancelEdit}
									className="flex h-8 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[12px] font-medium text-(--text-primary) transition-colors hover:bg-(--surface-hover)"
								>
									<LuX className="h-3 w-3" />
									{t("common.cancel")}
								</button>
							)}
							<button
								type="button"
								onClick={submitCustomCommand}
								className="flex h-8 items-center gap-1.5 rounded-[6px] border border-(--accent-border) bg-(--accent-soft) px-3 text-[12px] font-medium text-(--accent-selected) transition-colors hover:bg-(--accent-soft-hover)"
							>
								{editingIndex === null ? <LuPlus className="h-3 w-3" /> : <LuPencil className="h-3 w-3" />}
								{editingIndex === null ? t("dummyBot.customAdd") : t("common.save")}
							</button>
						</div>
					</div>
				</div>
			</SectionCard>

			<SectionCard title={t("dummyBot.conversationTitle")} count={messages.length}>
				<p className="px-2.5 pb-1.5 text-[11px] text-(--text-muted)">{t("dummyBot.conversationDescription", { name: state?.displayName ?? t("dummyBot.fallbackName") })}</p>
				<div ref={transcriptRef} className="flex max-h-[48vh] flex-col gap-1.5 overflow-y-auto pr-1">
					{messages.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-(--text-muted)">{t("dummyBot.empty")}</p>}
					{messages.map(message => <div key={message.id} className={`max-w-[80%] rounded-[8px] px-3 py-2 text-[12px] ${message.isSelf ? "self-end bg-(--accent-soft) text-(--accent-selected)" : "self-start bg-(--control) text-(--text-primary)"}`}><p className="whitespace-pre-wrap break-words">{message.body}</p></div>)}
				</div>
			</SectionCard>
		</div>
	</div>;
};

const RESERVED = new Set([
	".send",
	".tran",
	".translate",
	".dodge",
	"$online",
	"$offline",
	"$mobile",
	"$enable",
	"$disable",
	"$status",
	"$help",
]);

const normalizeTrigger = (value: string) => {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return "";
	return trimmed.startsWith(".") || trimmed.startsWith("$") ? trimmed : `.${trimmed}`;
};

export default DummyBot;
