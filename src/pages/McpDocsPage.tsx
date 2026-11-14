import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaArrowLeft } from "react-icons/fa6";
import { LuPlug } from "react-icons/lu";
import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import { reportIpcError } from "@/util/ipc";
import type { McpStatus } from "@/components/mcp-settings";

type ToolProperty = { type?: string; description?: string; minimum?: number; maximum?: number };

export type McpTool = {
	name: string;
	title?: string;
	description: string;
	inputSchema?: { properties?: Record<string, ToolProperty>; required?: string[] };
	annotations?: { readOnlyHint?: boolean };
};

const EXAMPLES = ["rank", "lastGames", "scoreboard", "live", "store", "friends", "lookup", "settings", "launch"] as const;

/** In-app reference for the local MCP server: how to connect and what each tool does. */
const McpDocsPage = ({ onBack }: { onBack: () => void }) => {
	const { t } = useTranslation();
	const [tools, setTools] = useState<McpTool[] | null>(null);
	const [status, setStatus] = useState<McpStatus | null>(null);

	useEffect(() => {
		let active = true;
		invoke<{ success: boolean; tools: McpTool[] }>("mcp_tools")
			.then((reply) => {
				if (active) setTools(reply.tools ?? []);
			})
			.catch(reportIpcError);
		invoke<McpStatus>("mcp_status")
			.then((reply) => {
				if (active) setStatus(reply);
			})
			.catch(reportIpcError);
		return () => {
			active = false;
		};
	}, []);

	const running = status?.running && status.url;

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader icon={<LuPlug className="text-lg" />} title={t("mcpDocs.title")} subtitle={t("mcpDocs.subtitle")}>
				<button
					onClick={onBack}
					className="flex h-7 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[11px] font-medium text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
				>
					<FaArrowLeft className="h-3 w-3" />
					{t("settings.title")}
				</button>
			</PageHeader>

			<div className={pageBodyClass}>
				<SectionCard title={t("mcpDocs.connectTitle")} accent="#38bdf8">
					<div className="flex flex-col gap-2 px-3 py-2 text-[12px] leading-relaxed text-(--text-secondary)">
						<p>{t("mcpDocs.intro")}</p>
						<ol className="flex list-decimal flex-col gap-1 pl-5">
							<li>{t("mcpDocs.step1")}</li>
							<li>{t("mcpDocs.step2")}</li>
							<li>{t("mcpDocs.step3")}</li>
						</ol>
						<p className="text-[11px] text-(--text-muted)">
							{running ? (
								<>
									<span className="text-(--signal-pos)">●</span> {t("mcp.running")}{" "}
									<code className="text-(--accent-selected)">{status?.url}</code>
								</>
							) : (
								<>
									<span className="text-(--text-muted)">○</span> {t("mcpDocs.off")}
								</>
							)}
						</p>
						<p className="text-[11px] text-(--text-muted)">{t("mcpDocs.clients")}</p>
					</div>
				</SectionCard>

				<SectionCard title={t("mcpDocs.examplesTitle")} accent="#8064e9">
					<ul className="flex flex-col gap-1 px-3 py-2">
						{EXAMPLES.map((key) => (
							<li key={key} className="rounded-[6px] bg-(--control) px-2.5 py-1.5 text-[12px] text-(--text-secondary)">
								“{t(`mcpDocs.examples.${key}`)}”
							</li>
						))}
					</ul>
				</SectionCard>

				<SectionCard title={t("mcpDocs.toolsTitle")} accent="#4ade80" count={tools?.length}>
					<div className="flex flex-col px-1">
						{tools === null && <p className="px-2 py-3 text-[11px] text-(--text-muted)">{t("mcpDocs.loading")}</p>}
						{tools?.map((tool) => {
							const properties = Object.entries(tool.inputSchema?.properties ?? {});
							const required = new Set(tool.inputSchema?.required ?? []);
							const readOnly = tool.annotations?.readOnlyHint !== false;
							return (
								<div key={tool.name} data-mcp-tool={tool.name} className="flex flex-col gap-1 border-b border-(--line) px-2 py-2.5 last:border-0">
									<div className="flex flex-wrap items-center gap-2">
										<code className="text-[12px] font-semibold text-(--text-primary)">{tool.name}</code>
										{tool.title && <span className="text-[11px] text-(--text-muted)">{tool.title}</span>}
										<span
											className={`rounded-[4px] border px-1.5 text-[10px] font-medium ${
												readOnly
													? "border-(--signal-pos)/40 text-(--signal-pos)"
													: "border-(--signal-warn)/40 text-(--signal-warn)"
											}`}
										>
											{readOnly ? t("mcpDocs.readOnly") : t("mcpDocs.takesAction")}
										</span>
									</div>
									<p className="text-[12px] leading-relaxed text-(--text-secondary)">{tool.description}</p>
									{properties.length > 0 && (
										<ul className="flex flex-col gap-0.5 pt-0.5">
											{properties.map(([name, property]) => (
												<li key={name} className="text-[11px] text-(--text-muted)">
													<code className="text-(--accent-selected)">{name}</code>{" "}
													<span>
														({property.type}
														{required.has(name) ? `, ${t("mcpDocs.required")}` : `, ${t("mcpDocs.optional")}`})
													</span>{" "}
													{property.description}
												</li>
											))}
										</ul>
									)}
								</div>
							);
						})}
					</div>
				</SectionCard>

				<SectionCard title={t("mcpDocs.privacyTitle")} accent="#6b7280">
					<ul className="flex list-disc flex-col gap-1 px-3 py-2 pl-7 text-[12px] leading-relaxed text-(--text-secondary)">
						<li>{t("mcpDocs.privacyLocal")}</li>
						<li>{t("mcpDocs.privacyNames")}</li>
						<li>{t("mcpDocs.privacyRate")}</li>
					</ul>
				</SectionCard>
			</div>
		</div>
	);
};

export default McpDocsPage;
