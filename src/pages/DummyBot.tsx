import { PageHeader, SectionCard, SectionRow } from "@/components/section-card";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaPlay, FaRobot } from "react-icons/fa6";

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
	const transcriptRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const applyState = (message: string) => { try { setState(JSON.parse(message)); } catch { /* ignore */ } };
		const applyLaunch = (message: string) => { try { setLaunch(JSON.parse(message)); } catch { /* ignore */ } };
		const launched = (message: string) => {
			setLaunchBusy(false);
			try { const result = JSON.parse(message); setLaunchError(result.success ? null : result.error); }
			catch { setLaunchError(t("dummyBot.launchFailed")); }
		};
		window.Main.on("fake_player:state", applyState);
		window.Main.on("client:config-status", applyLaunch);
		window.Main.on("riot:launch-with-config", launched);
		window.Main.on("riot:launch-normal", launched);
		const poll = () => { window.Main.send("fake_player:state"); window.Main.send("client:config-status"); };
		poll();
		const timer = setInterval(poll, 2000);
		return () => {
			clearInterval(timer);
			window.Main.removeAllListeners("fake_player:state");
			window.Main.removeAllListeners("client:config-status");
			window.Main.removeAllListeners("riot:launch-with-config");
			window.Main.removeAllListeners("riot:launch-normal");
		};
	}, [t]);

	useEffect(() => { if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }, [state?.messages.length]);
	const messages = state?.messages ?? [];
	const presenceMode = state?.presence.enabled
		? t(`dummyBot.mode.${state.presence.mode}`, { defaultValue: state.presence.mode })
		: t("dummyBot.disabled");

	return <div className="flex h-full min-h-0 flex-col">
		<PageHeader icon={<FaRobot className="text-[#ff4655]" />} title={t("dummyBot.title")} subtitle={state?.displayName} />
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-5">
			<SectionCard title={t("dummyBot.relayTitle")} accent="#22d3ee" right={<span className={launch?.activeConnections ? "text-green-400" : "text-gray-500"}>{t(launch?.activeConnections ? "dummyBot.connected" : "dummyBot.waiting")}</span>}>
				<SectionRow><span className="flex-1 text-sm text-gray-400">{t("dummyBot.presenceMasking")}</span><span className="text-sm text-white">{presenceMode}</span></SectionRow>
				<SectionRow><span className="flex-1 text-sm text-gray-400">{t("dummyBot.lobbyForwarding")}</span><span className="text-sm text-white">{t(state?.presence.connectToMuc ? "dummyBot.enabled" : "dummyBot.disabled")}</span></SectionRow>
				<SectionRow>
					<div className="min-w-0 flex-1"><p className="text-sm text-gray-300">{t("dummyBot.launchWithRelay")}</p><p className="truncate font-mono text-[11px] text-gray-600">--client-config-url={launch?.url ?? "http://127.0.0.1:8000"}</p></div>
					<div className="flex shrink-0 items-center gap-2">
						<button onClick={() => { setLaunchBusy(true); setLaunchError(null); window.Main.send("riot:launch-normal", "valorant", "live"); }} disabled={launchBusy || launch?.riotClientRunning !== false} className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-gray-200 disabled:opacity-40"><FaPlay className="h-3 w-3" />{t("dummyBot.launchNormal")}</button>
						<button onClick={() => { setLaunchBusy(true); setLaunchError(null); window.Main.send("riot:launch-with-config", "valorant", "live"); }} disabled={launchBusy || launch?.riotClientRunning !== false} className="flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/15 px-3 py-2 text-xs font-semibold text-cyan-200 disabled:opacity-40"><FaPlay className="h-3 w-3" />{t("dummyBot.launch")}</button>
					</div>
				</SectionRow>
				{launchError && <p className="px-3 text-xs text-red-400">{launchError}</p>}
				{launch?.lastWarning && <p className="px-3 text-xs text-red-400">{launch.lastWarning}</p>}
			</SectionCard>

			<SectionCard title={t("dummyBot.conversationTitle")} accent="#ff4655" count={messages.length}>
				<p className="px-3 text-xs text-gray-500">{t("dummyBot.conversationDescription", { name: state?.displayName ?? t("dummyBot.fallbackName") })}</p>
				<div ref={transcriptRef} className="flex max-h-[48vh] flex-col gap-1.5 overflow-y-auto pr-1">
					{messages.length === 0 && <p className="px-3 py-6 text-center text-xs text-gray-600">{t("dummyBot.empty")}</p>}
					{messages.map(message => <div key={message.id} className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${message.isSelf ? "self-end bg-[#ff4655]/15 text-white" : "self-start bg-white/5 text-gray-200"}`}><p className="whitespace-pre-wrap break-words">{message.body}</p></div>)}
				</div>
			</SectionCard>
		</div>
	</div>;
};

export default DummyBot;
