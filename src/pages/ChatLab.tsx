import { PageHeader, SectionCard } from "@/components/section-card";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaArrowLeft, FaComments, FaPaperPlane } from "react-icons/fa6";

type ChatLabProps = { onBack?: () => void };
type LabKind = "party" | "pregame" | "current" | "all";
type LabChannel = "party" | "pregame" | "team" | "all";
type LabResponse = { success: boolean; error?: string; data?: unknown; channel?: string; message?: string };

const INFO_PROBES: { kind: LabKind; labelKey: string; fallback: string }[] = [
	{ kind: "party", labelKey: "chatLab.partyInfo", fallback: "Party Chat Info" },
	{ kind: "pregame", labelKey: "chatLab.pregameInfo", fallback: "Pre-Game Chat Info" },
	{ kind: "current", labelKey: "chatLab.currentInfo", fallback: "Current Game Chat Info" },
	{ kind: "all", labelKey: "chatLab.allInfo", fallback: "All Chat Info" },
];

const SEND_CHANNELS: { channel: LabChannel; labelKey: string }[] = [
	{ channel: "party", labelKey: "chat.scopeParty" },
	{ channel: "pregame", labelKey: "chatLab.pregameChannel" },
	{ channel: "team", labelKey: "chat.matchTeam" },
	{ channel: "all", labelKey: "chat.matchAll" },
];

const parseLabResponse = (payload: string): LabResponse => {
	try {
		return JSON.parse(payload) as LabResponse;
	} catch {
		return { success: false, error: "Invalid response." };
	}
};

type ExtraHeader = { id: string; name: string; value: string };

export const TestLabPanel = () => {
	const { t } = useTranslation();
	const [channel, setChannel] = useState<LabChannel>("party");
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<string>("");
	const [headerName, setHeaderName] = useState("");
	const [headerValue, setHeaderValue] = useState("");
	const [extraHeaders, setExtraHeaders] = useState<ExtraHeader[]>([]);

	useEffect(() => {
		if (!window.Main) return;
		const onInfo = (payload: string) => {
			setBusy(false);
			setResult(JSON.stringify(parseLabResponse(payload), null, 2));
		};
		const onSend = (payload: string) => {
			setBusy(false);
			setResult(JSON.stringify(parseLabResponse(payload), null, 2));
		};
		window.Main.on("chat:lab-info", onInfo);
		window.Main.on("chat:lab-send", onSend);
		return () => {
			window.Main.removeListener("chat:lab-info", onInfo);
			window.Main.removeListener("chat:lab-send", onSend);
		};
	}, []);

	const headerMap = () =>
		Object.fromEntries(
			extraHeaders
				.filter((item) => item.name.trim())
				.map((item) => [item.name.trim(), item.value]),
		);

	const addHeader = () => {
		const name = headerName.trim();
		if (!name) return;
		setExtraHeaders((current) => [
			...current,
			{ id: `${Date.now()}-${name}`, name, value: headerValue },
		]);
		setHeaderName("");
		setHeaderValue("");
	};

	const fetchInfo = (kind: LabKind) => {
		if (!window.Main || busy) return;
		setBusy(true);
		window.Main.send("chat:lab-info", kind, headerMap());
	};

	const sendChat = () => {
		const text = draft.trim();
		if (!window.Main || busy || !text) return;
		setBusy(true);
		window.Main.send("chat:lab-send", channel, text, headerMap());
	};

	return (
		<div className="flex flex-col gap-3 px-1 py-2">
			<p className="text-sm text-gray-400">
				{t("chatLab.sendDesc", {
					defaultValue: "POST /chat/v6/messages on the lockfile port.",
				})}
			</p>
			<div className="flex flex-wrap items-end gap-2">
				<label className="flex flex-col gap-1 text-xs text-gray-500">
					{t("chatLab.channel", { defaultValue: "Channel" })}
					<select
						value={channel}
						onChange={(event) => setChannel(event.target.value as LabChannel)}
						className="rounded border border-white/10 bg-[#0b0e13] px-2 py-1.5 text-sm text-white outline-none focus:border-[#22d3ee]/50"
					>
						{SEND_CHANNELS.map((item) => (
							<option key={item.channel} value={item.channel}>
								{t(item.labelKey)}
							</option>
						))}
					</select>
				</label>
				<input
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") sendChat();
					}}
					placeholder={t("chatLab.messagePlaceholder", {
						defaultValue: "Type a localhost chat message",
					})}
					className="min-w-56 flex-1 rounded border border-white/10 bg-[#0b0e13] px-3 py-1.5 text-sm text-white outline-none focus:border-[#22d3ee]/50"
				/>
				<button
					type="button"
					onClick={sendChat}
					disabled={busy || !draft.trim()}
					className="flex items-center gap-1.5 rounded border border-[#22d3ee]/30 bg-[#22d3ee]/10 px-3 py-1.5 text-xs font-semibold text-[#22d3ee] hover:bg-[#22d3ee]/20 disabled:opacity-40"
				>
					<FaPaperPlane className="h-3 w-3" />
					{busy
						? t("chatLab.working", { defaultValue: "Working…" })
						: t("chatLab.send", { defaultValue: "Send" })}
				</button>
			</div>
			<div className="flex flex-col gap-2">
				<p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
					{t("chatLab.headersTitle", { defaultValue: "Request headers" })}
				</p>
				<p className="text-xs text-gray-500">
					{t("chatLab.headersDesc", {
						defaultValue:
							"Authorization (Basic riot:<lockfile>) and rchat-blocking: true are always sent. Add extra headers below.",
					})}
				</p>
				{extraHeaders.map((item) => (
					<div key={item.id} className="flex flex-wrap items-center gap-2">
						<code className="text-xs text-gray-300">{item.name}: {item.value || "∅"}</code>
						<button
							type="button"
							onClick={() =>
								setExtraHeaders((current) => current.filter((header) => header.id !== item.id))
							}
							className="rounded border border-white/10 px-2 py-0.5 text-[10px] text-gray-400 hover:text-white"
						>
							{t("common.close")}
						</button>
					</div>
				))}
				<div className="flex flex-wrap items-end gap-2">
					<input
						value={headerName}
						onChange={(event) => setHeaderName(event.target.value)}
						placeholder={t("chatLab.headerName", { defaultValue: "Header name" })}
						className="w-40 rounded border border-white/10 bg-[#0b0e13] px-2 py-1.5 text-sm text-white outline-none focus:border-[#22d3ee]/50"
					/>
					<input
						value={headerValue}
						onChange={(event) => setHeaderValue(event.target.value)}
						placeholder={t("chatLab.headerValue", { defaultValue: "Value" })}
						className="min-w-40 flex-1 rounded border border-white/10 bg-[#0b0e13] px-2 py-1.5 text-sm text-white outline-none focus:border-[#22d3ee]/50"
					/>
					<button
						type="button"
						onClick={addHeader}
						disabled={!headerName.trim()}
						className="rounded border border-white/10 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:bg-white/5 disabled:opacity-40"
					>
						{t("chatLab.addHeader", { defaultValue: "Add header" })}
					</button>
				</div>
			</div>
			<div className="flex flex-wrap gap-2">
				{INFO_PROBES.map((probe) => (
					<button
						key={probe.kind}
						type="button"
						onClick={() => fetchInfo(probe.kind)}
						disabled={busy}
						className="rounded border border-white/10 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:bg-white/5 disabled:opacity-40"
					>
						{t(probe.labelKey, { defaultValue: probe.fallback })}
					</button>
				))}
			</div>
			<pre className="max-h-64 overflow-auto rounded border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-gray-300 whitespace-pre-wrap">
				{result || t("chatLab.resultEmpty", { defaultValue: "Run a probe to see the JSON here." })}
			</pre>
		</div>
	);
};

const ChatLab = ({ onBack }: ChatLabProps) => {
	const { t } = useTranslation();

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<FaComments className="text-[#22d3ee] text-lg" />}
				title={t("chatLab.title", { defaultValue: "Test Lab" })}
				subtitle={t("chatLab.subtitle", { defaultValue: "Probe local Riot Client APIs" })}
			>
				{onBack && (
					<button
						onClick={onBack}
						className="flex items-center gap-1.5 rounded border border-white/10 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:bg-white/5"
					>
						<FaArrowLeft className="h-3 w-3" />
						{t("settings.title")}
					</button>
				)}
			</PageHeader>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
				<SectionCard
					title={t("chatLab.title", { defaultValue: "Test Lab" })}
					accent="#22d3ee"
				>
					<TestLabPanel />
				</SectionCard>
			</div>
		</div>
	);
};

export default ChatLab;
