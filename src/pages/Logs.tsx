import CustomButton from "@/components/button";
import { PageHeader, pageBodyClass } from "@/components/section-card";
import { filterLogEntries, formatLogEntry, formatLogSize, LOG_LEVELS, type LogEntry, type LogLevel } from "@/pages/log-entries";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaMagnifyingGlass } from "react-icons/fa6";
import { LuCopy, LuFolderOpen, LuRotateCw, LuScrollText, LuTrash2 } from "react-icons/lu";
import { useTranslation } from "react-i18next";

const REFRESH_MS = 5000;

type LogsResponse =
	| { success: true; path: string; entries: LogEntry[]; bytes: number; truncated: boolean }
	| { success: false; path?: string; error: string };

/** Level colours are the one place colour carries meaning on this page. */
const LEVEL_STYLE: Record<LogLevel, string> = {
	ERROR: "text-red-400 border-red-400/30 bg-red-400/10",
	WARN: "text-amber-400 border-amber-400/30 bg-amber-400/10",
	INFO: "text-sky-400 border-sky-400/30 bg-sky-400/10",
	DEBUG: "text-(--text-muted) border-(--line) bg-(--surface-hover)",
	TRACE: "text-(--text-muted) border-(--line) bg-(--surface-hover)",
};

const Logs = () => {
	const { t } = useTranslation();
	const [entries, setEntries] = useState<LogEntry[]>([]);
	const [path, setPath] = useState<string | null>(null);
	const [bytes, setBytes] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [levels, setLevels] = useState<LogLevel[]>([]);
	const [search, setSearch] = useState("");
	const [live, setLive] = useState(true);
	const liveRef = useRef(live);
	liveRef.current = live;

	const read = useCallback(() => {
		if (!window.Main) return;
		window.Main.send("logs:read");
	}, []);

	useEffect(() => {
		if (!window.Main) return;

		const onRead = (message: string) => {
			setLoading(false);
			let response: LogsResponse;
			try {
				response = JSON.parse(message) as LogsResponse;
			} catch {
				setError(t("logs.failed"));
				return;
			}
			if (!response.success) {
				setError(response.error || t("logs.failed"));
				setPath(response.path ?? null);
				return;
			}
			setError(null);
			setEntries(response.entries);
			setPath(response.path);
			setBytes(response.bytes);
			setTruncated(response.truncated);
		};

		window.Main.on("logs:read", onRead);
		read();
		// The log only grows while the app is doing something, so a slow poll is
		// enough; a hidden window is not reading it at all.
		const timer = window.setInterval(() => {
			if (liveRef.current && !document.hidden) read();
		}, REFRESH_MS);
		return () => {
			window.clearInterval(timer);
			window.Main.removeListener("logs:read", onRead);
		};
	}, [read, t]);

	// Newest first: the reason this page gets opened is always the last thing
	// that happened, and it should not need a scroll to reach.
	const visible = useMemo(() => filterLogEntries(entries, levels, search).reverse(), [entries, levels, search]);

	const counts = useMemo(() => {
		const tally = { ERROR: 0, WARN: 0 } as Record<string, number>;
		for (const entry of entries) if (entry.level in tally) tally[entry.level] += 1;
		return tally;
	}, [entries]);

	const toggleLevel = (level: LogLevel) =>
		setLevels((current) =>
			current.includes(level) ? current.filter((value) => value !== level) : [...current, level],
		);

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<LuScrollText />}
				title={t("logs.title")}
				subtitle={t("logs.summary", { count: entries.length, size: formatLogSize(bytes) })}
			>
				<label className="flex items-center gap-1.5 text-[11px] text-(--text-muted)">
					<input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
					{t("logs.live")}
				</label>
				<CustomButton size="sm" onClick={read} aria-label={t("logs.refresh")}>
					<LuRotateCw />
				</CustomButton>
				<CustomButton
					size="sm"
					onClick={() => window.Main.send("clipboard:set", visible.map(formatLogEntry).join("\n"))}
					aria-label={t("logs.copy")}
				>
					<LuCopy />
				</CustomButton>
				<CustomButton size="sm" onClick={() => window.Main.send("logs:open")} aria-label={t("logs.openFolder")}>
					<LuFolderOpen />
				</CustomButton>
				<CustomButton
					size="sm"
					color="danger"
					onClick={() => {
						window.Main.send("logs:clear");
						setEntries([]);
						setBytes(0);
						read();
					}}
					aria-label={t("logs.clear")}
				>
					<LuTrash2 />
				</CustomButton>
			</PageHeader>

			<div className="shrink-0 flex items-center gap-3 px-6 pt-3">
				<div className="flex items-center gap-1.5">
					{LOG_LEVELS.map((level) => {
						const active = levels.includes(level);
						return (
							<button
								key={level}
								type="button"
								onClick={() => toggleLevel(level)}
								aria-pressed={active}
								className={`rounded-[6px] border px-2 py-1 text-[10px] font-medium tracking-wide transition-colors duration-150 motion-reduce:transition-none ${
									active ? LEVEL_STYLE[level] : "border-(--line) text-(--text-muted) hover:bg-(--surface-hover)"
								}`}
							>
								{level}
								{level in counts && counts[level] > 0 ? ` ${counts[level]}` : ""}
							</button>
						);
					})}
				</div>
				<div className="glass rounded-lg h-8 flex items-center gap-2 px-3 min-w-0 flex-1 max-w-xs">
					<FaMagnifyingGlass className="text-gray-600 text-xs shrink-0" />
					<input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={t("logs.search")}
						className="min-w-0 flex-1 bg-transparent text-sm outline-none text-gray-200 placeholder:text-gray-600"
					/>
				</div>
				<span className="shrink-0 text-[11px] tabular-nums text-(--text-muted)">
					{t("logs.showing", { count: visible.length })}
				</span>
			</div>

			<div className={pageBodyClass}>
				{loading && <div className="flex-1 flex items-center justify-center text-sm text-(--text-muted)">{t("logs.loading")}</div>}

				{!loading && error && (
					<div className="panel px-3 py-2 text-[12px] text-red-400">{error}</div>
				)}

				{!loading && !error && visible.length === 0 && (
					<div className="flex-1 flex flex-col items-center justify-center gap-1 text-center">
						<span className="text-sm text-(--text-secondary)">{t("logs.empty")}</span>
						<span className="text-[11px] text-(--text-muted)">{t("logs.emptyHint")}</span>
					</div>
				)}

				{visible.length > 0 && (
					<div className="panel divide-y divide-(--line)">
						{visible.map((entry, index) => (
							<div key={`${entry.timestamp ?? ""}-${index}`} className="flex gap-3 px-3 py-1.5 hover:bg-(--surface-hover)">
								<span className="shrink-0 w-[132px] text-[11px] tabular-nums text-(--text-muted)">
									{entry.timestamp ?? ""}
								</span>
								<span
									className={`shrink-0 h-fit rounded-[4px] border px-1.5 py-px text-[10px] font-medium ${LEVEL_STYLE[entry.level] ?? LEVEL_STYLE.INFO}`}
								>
									{entry.level}
								</span>
								<div className="min-w-0 flex-1">
									<pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-(--text-primary)">
										{entry.message}
									</pre>
									{entry.target && <span className="text-[10px] text-(--text-muted)">{entry.target}</span>}
								</div>
							</div>
						))}
					</div>
				)}

				{truncated && (
					<p className="text-[11px] text-(--text-muted)">{t("logs.truncated")}</p>
				)}
				{path && <p className="text-[10px] break-all text-(--text-muted)">{path}</p>}
			</div>
		</div>
	);
};

export default Logs;
