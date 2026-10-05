import { reportIpcError } from "@/util/ipc";
import { invoke } from "@tauri-apps/api/core";
import CustomButton from "@/components/button";
import { PageHeader, pageBodyClass } from "@/components/section-card";
import { filterLogEntries, formatLogEntry, formatLogSize, LOG_LEVELS, parsePdBudget, pdBudgetHeadline, type LogEntry, type LogLevel, type PdBudgetDetails } from "@/pages/log-entries";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaMagnifyingGlass } from "react-icons/fa6";
import { LuChevronRight, LuCopy, LuFolderOpen, LuRotateCw, LuScrollText, LuTrash2 } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

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

const entryKey = (entry: LogEntry) => `${entry.timestamp ?? ""}|${entry.target ?? ""}|${entry.message}`;

/** The endpoint table under an expanded PD budget line. */
const PdBudgetBreakdown = ({ details, t }: { details: PdBudgetDetails; t: TFunction }) => {
	const busiest = Math.max(1, ...details.endpoints.map((row) => row.count));
	const perMinute = details.seconds > 0 ? (details.requests * 60) / details.seconds : details.requests;
	return (
		<div className="mt-2 mb-1 overflow-hidden rounded-[10px] border border-(--line) bg-(--background)" data-log-details="pd-budget">
			<div className="flex items-center justify-between gap-3 border-b border-(--line) px-3 py-1.5 text-[10px] font-medium tracking-[0.06em] text-(--text-muted) uppercase">
				<span>{t("logs.pdBudget.endpoint")}</span>
				<span className="flex items-center gap-3">
					<span className="normal-case tracking-normal tabular-nums">
						{t("logs.pdBudget.rate", { rate: perMinute.toFixed(perMinute < 10 ? 1 : 0) })}
					</span>
					<span>{t("logs.pdBudget.requests")}</span>
				</span>
			</div>
			{details.endpoints.map((row) => (
				<div key={row.endpoint} className="grid grid-cols-[minmax(0,1fr)_7rem_2.5rem] items-center gap-3 px-3 py-1.5">
					<span className="flex min-w-0 items-center gap-2">
						<code className="truncate font-mono text-[11px] text-(--text-primary)" title={row.endpoint}>{row.endpoint}</code>
						{row.endpoint === details.longestEndpoint && details.longestWaitMs > 0 && (
							<span className="shrink-0 rounded-full border border-(--signal-warn)/30 bg-(--signal-warn)/10 px-1.5 text-[10px] text-(--signal-warn)">
								{t("logs.pdBudget.waitedLongest")} · {details.longestWaitMs}ms
							</span>
						)}
					</span>
					<span className="h-1.5 overflow-hidden rounded-full bg-(--control)" aria-hidden="true">
						<span className="block h-full rounded-full bg-(--accent)" style={{ width: `${(row.count / busiest) * 100}%` }} />
					</span>
					<span className="text-right text-[11px] tabular-nums text-(--text-secondary)">{row.count}</span>
				</div>
			))}
		</div>
	);
};

/**
 * One log line. A PD budget summary that carries an endpoint breakdown opens
 * into a table; every other line stays a plain row.
 */
const LogRow = ({ entry, t }: { entry: LogEntry; t: TFunction }) => {
	const [open, setOpen] = useState(false);
	const budget = useMemo(() => parsePdBudget(entry.message), [entry.message]);
	const expandable = !!budget && budget.endpoints.length > 0;
	const message = expandable ? pdBudgetHeadline(budget) : entry.message;

	return (
		<div className="flex gap-3 px-3 py-1.5 hover:bg-(--surface-hover)">
			<span className="shrink-0 w-[132px] text-[11px] tabular-nums text-(--text-muted)">
				{entry.timestamp ?? ""}
			</span>
			<span
				className={`shrink-0 h-fit rounded-[4px] border px-1.5 py-px text-[10px] font-medium ${LEVEL_STYLE[entry.level] ?? LEVEL_STYLE.INFO}`}
			>
				{entry.level}
			</span>
			<div className="min-w-0 flex-1">
				{expandable ? (
					<button
						type="button"
						aria-expanded={open}
						onClick={() => setOpen((current) => !current)}
						className="press-flat -mx-1 flex w-[calc(100%+0.5rem)] items-start gap-1.5 rounded-[6px] px-1 text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
					>
						<LuChevronRight
							aria-hidden="true"
							className={`mt-[5px] h-3 w-3 shrink-0 text-(--text-muted) transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
						/>
						<pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-(--text-primary)">
							{message}
						</pre>
						<span className="mt-0.5 shrink-0 rounded-full border border-(--border) px-1.5 text-[10px] text-(--text-muted)">
							{t("logs.pdBudget.endpoints", { count: budget.endpoints.length })}
						</span>
					</button>
				) : (
					<pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-(--text-primary)">
						{message}
					</pre>
				)}
				{expandable && open && <PdBudgetBreakdown details={budget} t={t} />}
				{entry.target && <span className="text-[10px] text-(--text-muted)">{entry.target}</span>}
			</div>
		</div>
	);
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

	const onRead = useCallback((message: any) => {
			setLoading(false);
			let response: LogsResponse;
			try {
				response = message as LogsResponse;
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
		}, [t]);

const read = useCallback(() => {

		invoke<any>("logs_read").then(onRead).catch(error => onRead({ success: false, error: String(error) }));
	}, [onRead]);

	useEffect(() => {

		read();
		// The log only grows while the app is doing something, so a slow poll is
		// enough; a hidden window is not reading it at all.
		const timer = window.setInterval(() => {
			if (liveRef.current && !document.hidden) read();
		}, REFRESH_MS);
		return () => {
			window.clearInterval(timer);

		};
	}, [read, t]);

	// Newest first: the reason this page gets opened is always the last thing
	// that happened, and it should not need a scroll to reach.
	const visible = useMemo(() => filterLogEntries(entries, levels, search).reverse(), [entries, levels, search]);

	// Keyed by content, counted from the oldest line, so an expanded row stays
	// open on its own entry as new lines arrive above it.
	const rowKeys = useMemo(() => {
		const seen = new Map<string, number>();
		const keys = Array.from<string>({ length: visible.length });
		for (let index = visible.length - 1; index >= 0; index -= 1) {
			const key = entryKey(visible[index]);
			const occurrence = seen.get(key) ?? 0;
			seen.set(key, occurrence + 1);
			keys[index] = `${key}#${occurrence}`;
		}
		return keys;
	}, [visible]);

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
					onClick={() => invoke("clipboard_set", { args: [visible.map(formatLogEntry).join("\n")] }).catch(reportIpcError)}
					aria-label={t("logs.copy")}
				>
					<LuCopy />
				</CustomButton>
				<CustomButton size="sm" onClick={() => invoke("logs_open").catch(reportIpcError)} aria-label={t("logs.openFolder")}>
					<LuFolderOpen />
				</CustomButton>
				<CustomButton
					size="sm"
					color="danger"
					onClick={() => {
						invoke("logs_clear").catch(reportIpcError);
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
							<LogRow key={rowKeys[index]} entry={entry} t={t} />
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
