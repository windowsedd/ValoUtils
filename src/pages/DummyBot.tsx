import { PageHeader, SectionCard, SectionRow, pageBodyClass } from "@/components/section-card";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaPlay, FaPlus, FaRobot, FaTrash } from "react-icons/fa6";

type CustomBotCommand = {
	trigger: string;
	action: "send" | "tran";
	channel: string;
	language: string;
	message: string;
	count: number;
};

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

const DummyBot = () => {
	const { t } = useTranslation();
	const [state, setState] = useState<FakePlayerState | null>(null);
	const [launch, setLaunch] = useState<LaunchState | null>(null);
	const [launchError, setLaunchError] = useState<string | null>(null);
	const [launchBusy, setLaunchBusy] = useState(false);
	const [customCommands, setCustomCommands] = useState<CustomBotCommand[]>([]);
	const [draft, setDraft] = useState<CustomBotCommand>({
		trigger: "",
		action: "send",
		channel: "team",
		language: "zh_tw",
		message: "",
		count: 1,
	});
	const [customError, setCustomError] = useState<string | null>(null);
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
				const config = JSON.parse(message) as { botCustomCommands?: CustomBotCommand[] };
				setCustomCommands(normalizeCustomCommands(config.botCustomCommands));
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

	const saveCustomCommands = (next: CustomBotCommand[]) => {
		setCustomCommands(next);
		window.Main.send("config:set", "botCustomCommands", next);
	};

	const addCustomCommand = () => {
		const trigger = normalizeTrigger(draft.trigger);
		if (!trigger) {
			setCustomError(t("dummyBot.customTriggerRequired"));
			return;
		}
		if (RESERVED.has(trigger)) {
			setCustomError(t("dummyBot.customTriggerReserved"));
			return;
		}
		if (customCommands.some((item) => normalizeTrigger(item.trigger) === trigger)) {
			setCustomError(t("dummyBot.customTriggerExists"));
			return;
		}
		if (draft.action === "send" && !draft.message.trim()) {
			setCustomError(t("dummyBot.customMessageRequired"));
			return;
		}
		saveCustomCommands([
			...customCommands,
			{
				...draft,
				trigger,
				language: draft.language.trim() || "none",
				message: draft.message.trim(),
				count: Math.max(1, Number(draft.count) || 1),
			},
		]);
		setDraft((current) => ({ ...current, trigger: "", message: "" }));
		setCustomError(null);
	};

	useEffect(() => { if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }, [state?.messages.length]);
	const messages = state?.messages ?? [];
	const presenceMode = state?.presence.enabled
		? t(`dummyBot.mode.${state.presence.mode}`, { defaultValue: state.presence.mode })
		: t("dummyBot.disabled");

	return <div className="flex h-full min-h-0 flex-col">
		<PageHeader icon={<FaRobot className="text-[#ff4655]" />} title={t("dummyBot.title")} subtitle={state?.displayName} />
		<div className={pageBodyClass}>
			<SectionCard title={t("dummyBot.relayTitle")} accent="#8064e9" right={<span className={launch?.activeConnections ? "text-(--signal-pos)" : "text-(--text-muted)"}>{t(launch?.activeConnections ? "dummyBot.connected" : "dummyBot.waiting")}</span>}>
				<SectionRow><span className="flex-1 text-sm text-gray-400">{t("dummyBot.presenceMasking")}</span><span className="text-sm text-white">{presenceMode}</span></SectionRow>
				<SectionRow><span className="flex-1 text-sm text-gray-400">{t("dummyBot.lobbyForwarding")}</span><span className="text-sm text-white">{t(state?.presence.connectToMuc ? "dummyBot.enabled" : "dummyBot.disabled")}</span></SectionRow>
				<SectionRow>
					<div className="min-w-0 flex-1"><p className="text-sm text-gray-300">{t("dummyBot.launchWithRelay")}</p><p className="truncate font-mono text-[11px] text-gray-600">--client-config-url={launch?.url ?? "http://127.0.0.1:8000"}</p></div>
					<div className="flex shrink-0 items-center gap-2">
						<button onClick={() => { setLaunchBusy(true); setLaunchError(null); window.Main.send("riot:launch-normal", "valorant", "live"); }} disabled={launchBusy || launch?.riotClientRunning !== false} className="flex h-7 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[11px] font-medium text-(--text-primary) disabled:opacity-40"><FaPlay className="h-3 w-3" />{t("dummyBot.launchNormal")}</button>
						<button onClick={() => { setLaunchBusy(true); setLaunchError(null); window.Main.send("riot:launch-with-config", "valorant", "live"); }} disabled={launchBusy || launch?.riotClientRunning !== false} className="flex h-7 items-center gap-1.5 rounded-[6px] border border-(--accent-border) bg-(--accent-soft) px-3 text-[11px] font-medium text-(--accent-selected) disabled:opacity-40"><FaPlay className="h-3 w-3" />{t("dummyBot.launch")}</button>
					</div>
				</SectionRow>
				{launchError && <p className="px-3 text-xs text-red-400">{launchError}</p>}
				{launch?.lastWarning && <p className="px-3 text-xs text-red-400">{launch.lastWarning}</p>}
			</SectionCard>

			<SectionCard title={t("dummyBot.commandsTitle")} accent="#8064e9">
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
					<SectionRow key={syntax}>
						<span className="font-mono text-sm text-(--ink)">{syntax}</span>
						<span className="text-sm text-(--ink-dim)">{t(`dummyBot.command.${key}`)}</span>
					</SectionRow>
				))}
				<SectionRow leader={false}>
					<div className="min-w-0">
						<p className="font-mono text-sm text-(--ink)">{t("dummyBot.translateSyntax")}</p>
						<p className="mt-1 text-xs leading-5 text-(--ink-dim)">{t("dummyBot.translateDesc")}</p>
						<p className="mt-1 font-mono text-[11px] text-(--ink-faint)">{t("dummyBot.translateExample")}</p>
					</div>
				</SectionRow>
				<SectionRow leader={false}>
					<div className="min-w-0">
						<p className="font-mono text-sm text-(--ink)">{t("dummyBot.historySyntax")}</p>
						<p className="mt-1 text-xs leading-5 text-(--ink-dim)">{t("dummyBot.historyDesc")}</p>
						<p className="mt-1 font-mono text-[11px] text-(--ink-faint)">{t("dummyBot.historyExample")}</p>
					</div>
				</SectionRow>
				<SectionRow leader={false}>
					<div className="min-w-0">
						<p className="font-mono text-sm text-(--ink)">{t("dummyBot.dodgeSyntax")}</p>
						<p className="mt-1 text-xs leading-5 text-(--ink-dim)">{t("dummyBot.dodgeDesc")}</p>
					</div>
				</SectionRow>
			</SectionCard>

			<SectionCard title={t("dummyBot.customTitle")} accent="#e8a33d" count={customCommands.length}>
				<p className="px-3 pb-1 text-xs text-(--ink-faint)">{t("dummyBot.customDesc")}</p>
				{customCommands.map((item) => (
					<SectionRow key={item.trigger} leader={false}>
						<div className="flex min-w-0 flex-1 items-center gap-2">
							<span className="font-mono text-sm text-(--ink)">{item.trigger}</span>
							<span className="truncate text-xs text-(--ink-dim)">
								{item.action === "send"
									? `.send ${item.channel || "team"} ${item.language} ${item.message}`.trim()
									: `.tran ${item.channel} ${item.count || 1}`.trim()}
							</span>
						</div>
						<button
							type="button"
							className="shrink-0 rounded-sm p-1.5 text-(--ink-faint) hover:bg-white/8 hover:text-(--signal-neg)"
							onClick={() => saveCustomCommands(customCommands.filter((command) => command.trigger !== item.trigger))}
							aria-label={t("dummyBot.customRemove")}
						>
							<FaTrash className="h-3 w-3" />
						</button>
					</SectionRow>
				))}
				<div className="grid grid-cols-2 gap-2 px-2.5 py-2 sm:grid-cols-6">
					<input value={draft.trigger} onChange={(event) => setDraft((current) => ({ ...current, trigger: event.target.value }))} placeholder=".gg" className="min-w-0 rounded-sm border border-(--line) bg-(--panel-raised) px-2 py-1.5 font-mono text-xs text-(--ink)" />
					<select value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value as CustomBotCommand["action"] }))} className="min-w-0 rounded-sm border border-(--line) bg-(--panel-raised) px-2 py-1.5 text-xs text-(--ink)">
						<option value="send">{t("dummyBot.customActionSend")}</option>
						<option value="tran">{t("dummyBot.customActionTran")}</option>
					</select>
					<select value={draft.channel} onChange={(event) => setDraft((current) => ({ ...current, channel: event.target.value }))} className="min-w-0 rounded-sm border border-(--line) bg-(--panel-raised) px-2 py-1.5 text-xs text-(--ink)">
						<option value="party">party</option>
						<option value="team">team</option>
						<option value="all">all</option>
						<option value="pregame">pregame</option>
					</select>
					{draft.action === "send" ? (
						<>
							<input value={draft.language} onChange={(event) => setDraft((current) => ({ ...current, language: event.target.value }))} placeholder="ko-KR" className="min-w-0 rounded-sm border border-(--line) bg-(--panel-raised) px-2 py-1.5 font-mono text-xs text-(--ink)" />
							<input value={draft.message} onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))} placeholder={t("dummyBot.customMessagePlaceholder")} className="col-span-2 min-w-0 rounded-sm border border-(--line) bg-(--panel-raised) px-2 py-1.5 text-xs text-(--ink)" />
						</>
					) : (
						<input type="number" min={1} max={10} value={draft.count} onChange={(event) => setDraft((current) => ({ ...current, count: Number(event.target.value) }))} className="min-w-0 rounded-sm border border-(--line) bg-(--panel-raised) px-2 py-1.5 font-mono text-xs text-(--ink)" />
					)}
				</div>
				<div className="flex items-center justify-between gap-2 px-2.5 pb-2">
					{customError ? <p className="text-xs text-(--signal-neg)">{customError}</p> : <span />}
					<button type="button" onClick={addCustomCommand} className="flex items-center gap-1.5 rounded-sm border border-(--line-strong) bg-(--panel-raised) px-3 py-1.5 text-xs font-semibold text-(--ink) hover:bg-white/8">
						<FaPlus className="h-3 w-3" />
						{t("dummyBot.customAdd")}
					</button>
				</div>
			</SectionCard>

			<SectionCard title={t("dummyBot.conversationTitle")} accent="#ff4655" count={messages.length}>
				<p className="px-3 text-xs text-gray-500">{t("dummyBot.conversationDescription", { name: state?.displayName ?? t("dummyBot.fallbackName") })}</p>
				<div ref={transcriptRef} className="flex max-h-[48vh] flex-col gap-1.5 overflow-y-auto pr-1">
					{messages.length === 0 && <p className="px-3 py-6 text-center text-xs text-gray-600">{t("dummyBot.empty")}</p>}
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

const normalizeCustomCommands = (value: CustomBotCommand[] | undefined) =>
	Array.isArray(value)
		? value.filter((item) => item && typeof item.trigger === "string" && typeof item.action === "string")
		: [];

export default DummyBot;
