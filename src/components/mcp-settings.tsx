import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaBook, FaCheck, FaCopy, FaEye, FaEyeSlash, FaPlug, FaRotate } from "react-icons/fa6";
import { gooeyToast as toast } from "goey-toast";
import { reportIpcError } from "@/util/ipc";
import { SectionCard } from "@/components/section-card";
import { Switch } from "@/components/ui/switch";

export type McpStatus = {
	success: boolean;
	enabled?: boolean;
	running?: boolean;
	url?: string | null;
	token?: string;
	error?: string;
};

const MASK = "••••••••••••";

/** Copy-ready setups for the common MCP clients. `token` may be masked for display. */
export const mcpSnippets = (url: string, token: string) => ({
	claudeCode: `claude mcp add --transport http valoutils ${url} --header "Authorization: Bearer ${token}"`,
	// Claude Desktop only launches local commands, so mcp-remote bridges to HTTP.
	// The header goes through env because Windows splits args on the space.
	claudeDesktop: JSON.stringify(
		{
			mcpServers: {
				valoutils: {
					command: "npx",
					args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}"],
					env: { AUTH_HEADER: `Bearer ${token}` },
				},
			},
		},
		null,
		2,
	),
	http: JSON.stringify(
		{ mcpServers: { valoutils: { url, headers: { Authorization: `Bearer ${token}` } } } },
		null,
		2,
	),
});

const buttonClass =
	"flex h-7 items-center gap-1.5 px-2.5 rounded-[6px] text-[11px] font-medium border border-(--border) bg-(--control) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--surface-hover) disabled:opacity-40 disabled:cursor-not-allowed transition-[background-color,border-color,color] duration-150";

export const McpSettings = ({ onOpenDocs }: { onOpenDocs: () => void }) => {
	const { t } = useTranslation();
	const [status, setStatus] = useState<McpStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [reveal, setReveal] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		invoke<McpStatus>("mcp_status")
			.then((reply) => {
				if (active) setStatus(reply);
			})
			.catch(reportIpcError);
		return () => {
			active = false;
		};
	}, []);

	const apply = (reply: McpStatus) => {
		if (!reply.success) {
			toast.error(reply.error || t("mcp.error"));
			return;
		}
		setStatus(reply);
	};

	const setEnabled = async (enabled: boolean) => {
		setBusy(true);
		try {
			apply(await invoke<McpStatus>("mcp_set_enabled", { args: [enabled] }));
			invoke("analytics_track", { args: ["mcp:toggle", JSON.stringify({ enabled })] }).catch(reportIpcError);
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy(false);
		}
	};

	const regenerate = async () => {
		try {
			apply(await invoke<McpStatus>("mcp_regenerate_token"));
			toast.success(t("mcp.tokenRegenerated"));
			invoke("analytics_track", { args: ["mcp:token-regenerate"] }).catch(reportIpcError);
		} catch (error) {
			toast.error(String(error));
		}
	};

	const copy = (key: string, text: string) => {
		invoke("clipboard_set", { args: [text] }).catch(reportIpcError);
		invoke("analytics_track", { args: ["mcp:copy", JSON.stringify({ what: key })] }).catch(reportIpcError);
		setCopied(key);
		setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
	};

	const enabled = status?.enabled === true;
	const url = status?.url ?? "";
	const token = status?.token ?? "";
	const real = url && token ? mcpSnippets(url, token) : null;
	const shown = url && token ? mcpSnippets(url, reveal ? token : MASK) : null;
	const prompt = (secret: string) => t("mcp.agentPrompt", { url, token: secret });

	const block = (key: string, title: string, hint: string, display: string, text: string) => (
		<div key={key} className="flex flex-col gap-1.5 py-2.5 border-b border-(--line) last:border-0">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-[12px] font-medium text-(--text-primary)">{title}</p>
					<p className="text-[11px] text-(--text-muted)">{hint}</p>
				</div>
				<button type="button" onClick={() => copy(key, text)} className={buttonClass}>
					{copied === key ? <FaCheck className="w-3 h-3 text-green-400" /> : <FaCopy className="w-3 h-3" />}
					{copied === key ? t("settings.copied") : t("common.copy")}
				</button>
			</div>
			<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[6px] border border-(--border) bg-(--control) px-2.5 py-2 font-mono text-[11px] leading-5 text-(--text-secondary)">
				{display}
			</pre>
		</div>
	);

	return (
		<SectionCard
			id="settings-mcp"
			title={t("mcp.section")}
			accent="#38bdf8"
			right={
				<button type="button" onClick={onOpenDocs} className={buttonClass}>
					<FaBook className="w-3 h-3" />
					{t("mcp.docs")}
				</button>
			}
		>
			<div className="flex flex-col px-1">
				<div className="flex items-center justify-between gap-4 py-2.5 border-b border-(--line)">
					<div className="flex items-start gap-3 min-w-0">
						<FaPlug className="text-(--text-muted) mt-0.5 shrink-0 text-[13px]" />
						<div className="min-w-0">
							<p className="text-[12px] font-medium text-(--text-primary)">{t("mcp.enable")}</p>
							<p className="text-[11px] text-(--text-muted) mt-0.5">{t("mcp.enableDesc")}</p>
						</div>
					</div>
					<Switch
						checked={enabled}
						onCheckedChange={setEnabled}
						disabled={busy || !status}
						aria-label={t("mcp.enable")}
					/>
				</div>

				{enabled && real && shown && (
					<>
						<div className="flex flex-wrap items-center justify-between gap-2 py-2.5 border-b border-(--line)">
							<p className="min-w-0 text-[11px] text-(--text-muted)">
								<span className="text-(--signal-pos)">●</span> {t("mcp.running")}{" "}
								<span className="font-mono text-(--text-secondary)">{url}</span>
							</p>
							<div className="flex gap-1.5">
								<button type="button" onClick={() => setReveal((value) => !value)} className={buttonClass}>
									{reveal ? <FaEyeSlash className="w-3 h-3" /> : <FaEye className="w-3 h-3" />}
									{reveal ? t("mcp.hideToken") : t("mcp.showToken")}
								</button>
								<button type="button" onClick={regenerate} className={buttonClass}>
									<FaRotate className="w-3 h-3" />
									{t("mcp.regenerate")}
								</button>
							</div>
						</div>
						{block("prompt", t("mcp.promptTitle"), t("mcp.promptHint"), prompt(reveal ? token : MASK), prompt(token))}
						{block("claudeCode", t("mcp.claudeCodeTitle"), t("mcp.claudeCodeHint"), shown.claudeCode, real.claudeCode)}
						{block("claudeDesktop", t("mcp.claudeDesktopTitle"), t("mcp.claudeDesktopHint"), shown.claudeDesktop, real.claudeDesktop)}
						{block("http", t("mcp.httpTitle"), t("mcp.httpHint"), shown.http, real.http)}
					</>
				)}
				{enabled && status && !status.running && (
					<p className="py-2 text-[11px] text-(--signal-neg)">{t("mcp.notRunning")}</p>
				)}
				<p className="py-2 text-[11px] text-(--text-muted)">{t("mcp.privacy")}</p>
			</div>
		</SectionCard>
	);
};
