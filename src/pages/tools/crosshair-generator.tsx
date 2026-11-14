import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuCopy, LuLink, LuSparkles } from "react-icons/lu";
import { CrosshairFromCode } from "@/components/crosshair-svg-generator";
import { Button } from "@/components/ui/button";
import { reportIpcError } from "@/util/ipc";
import { crosshairLink, onSharedCrosshair, takeSharedCrosshair } from "@/util/deep-links";

type GenerateReply =
	| { success: true; code: string; name?: string | null; settings: Record<string, unknown> }
	| { success: false; code?: string; error?: string };

export type GeneratedCrosshair = { prompt: string; code: string; name: string | null };

const EXAMPLES = ["dot", "classic", "plus", "pink"] as const;
const MAX_PROMPT = 500;
const HISTORY = 6;

/** Backgrounds the preview is shown on, so a color's contrast is visible. */
const BACKDROPS = ["#1f2a24", "#6b7c86", "#c9b48a"];

/**
 * Tools → Crosshair generator. The AI provider from Settings → AI turns a
 * description into crosshair settings; ValoUtils builds and clamps the share
 * code (`ai_crosshair_generate`), so every result is a valid code.
 */
export const CrosshairGenerator = () => {
	const { t } = useTranslation();
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [results, setResults] = useState<GeneratedCrosshair[]>([]);
	const [copied, setCopied] = useState<string | null>(null);

	// Crosshairs opened from valoutils:// links show up as the newest result.
	useEffect(() => {
		const take = () => {
			const shared = takeSharedCrosshair();
			if (!shared) return;
			setError(null);
			setResults((current) =>
				[{ prompt: t("tools.crosshairShared"), code: shared.code, name: shared.name }, ...current].slice(0, HISTORY),
			);
		};
		take();
		return onSharedCrosshair(take);
	}, [t]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(null), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	const generate = async (text = prompt) => {
		const description = text.trim();
		if (!description || busy) return;
		setBusy(true);
		setError(null);
		try {
			const reply = await invoke<GenerateReply>("ai_crosshair_generate", { args: [description] });
			if (reply.success) {
				setResults((current) => [{ prompt: description, code: reply.code, name: reply.name ?? null }, ...current].slice(0, HISTORY));
			} else {
				setError(t(`ai.errors.${reply.code}`, { defaultValue: reply.error || t("ai.errors.unavailable") }));
			}
			invoke("analytics_track", { args: ["tools:crosshair-generate", JSON.stringify({ ok: reply.success })] }).catch(reportIpcError);
		} catch (failure) {
			setError(String(failure));
		} finally {
			setBusy(false);
		}
	};

	const copy = (code: string) => {
		invoke("clipboard_set", { args: [code] }).catch(reportIpcError);
		invoke("analytics_track", { args: ["tools:crosshair-copy"] }).catch(reportIpcError);
		setCopied(code);
	};

	const copyLink = (item: GeneratedCrosshair) => {
		const link = crosshairLink(item.code, item.name);
		invoke("clipboard_set", { args: [link] }).catch(reportIpcError);
		invoke("analytics_track", { args: ["tools:crosshair-copy-link"] }).catch(reportIpcError);
		setCopied(link);
	};

	const [latest, ...older] = results;

	return (
		<div data-crosshair-generator="" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-6">
			<form
				className="flex flex-col gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void generate();
				}}
			>
				<textarea
					value={prompt}
					onChange={(event) => setPrompt(event.target.value.slice(0, MAX_PROMPT))}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void generate();
						}
					}}
					rows={3}
					placeholder={t("tools.crosshairPlaceholder")}
					aria-label={t("tools.crosshairPrompt")}
					className="w-full resize-none rounded-[6px] border border-(--border) bg-(--control) px-2.5 py-2 text-[12px] leading-5 text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent) focus:shadow-[0_0_0_2px_var(--accent-soft)]"
				/>
				<div className="flex flex-wrap items-center gap-1.5">
					{EXAMPLES.map((example) => (
						<button
							key={example}
							type="button"
							disabled={busy}
							onClick={() => {
								const text = t(`tools.crosshairExamples.${example}`);
								setPrompt(text);
								void generate(text);
							}}
							className="rounded-full border border-(--border) px-2.5 py-1 text-[11px] text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:opacity-40"
						>
							{t(`tools.crosshairExamples.${example}`)}
						</button>
					))}
					<Button type="submit" variant="accent" className="ml-auto" pending={busy} disabled={!prompt.trim()}>
						<LuSparkles />
						{t("tools.crosshairGenerate")}
					</Button>
				</div>
				<p className="text-[11px] text-(--text-muted)">{t("tools.crosshairHint")}</p>
			</form>

			{error && (
				<p role="alert" className="text-[12px] text-(--signal-neg)">
					{error}
				</p>
			)}

			{latest && (
				<section data-crosshair-result="" className="flex flex-col gap-3 rounded-[12px] border border-(--border) bg-(--surface) p-4">
					<div className="flex flex-wrap gap-2">
						{BACKDROPS.map((backdrop) => (
							<div key={backdrop} className="overflow-hidden rounded-[8px] border border-(--line)">
								<CrosshairFromCode code={latest.code} width={128} height={128} scale={2} backgroundColor={backdrop} />
							</div>
						))}
					</div>
					<div className="flex flex-col gap-1">
						<p className="text-[13px] font-semibold text-(--text-primary)">{latest.name || t("tools.crosshairUntitled")}</p>
						<p className="text-[11px] text-(--text-muted)">“{latest.prompt}”</p>
					</div>
					<div className="flex items-center gap-1.5">
						<code data-crosshair-code="" className="min-w-0 flex-1 truncate rounded-[6px] border border-(--border) bg-(--control) px-2 py-1.5 font-mono text-[12px] text-(--accent-selected)" title={latest.code}>
							{latest.code}
						</code>
						<Button variant="outline" onClick={() => copy(latest.code)}>
							{copied === latest.code ? <LuCheck className="text-(--signal-pos)" /> : <LuCopy />}
							{copied === latest.code ? t("settings.copied") : t("tools.crosshairCopy")}
						</Button>
						<Button variant="outline" onClick={() => copyLink(latest)} title={t("tools.crosshairLinkHint")}>
							{copied === crosshairLink(latest.code, latest.name) ? <LuCheck className="text-(--signal-pos)" /> : <LuLink />}
							{copied === crosshairLink(latest.code, latest.name) ? t("settings.copied") : t("tools.crosshairCopyLink")}
						</Button>
					</div>
					<p className="text-[11px] text-(--text-muted)">{t("tools.crosshairImport")}</p>
				</section>
			)}

			{older.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">{t("tools.crosshairRecent")}</h3>
					<div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))]">
						{older.map((item, index) => (
							<div key={`${item.code}-${index}`} className="flex items-center gap-2 rounded-[8px] border border-(--line) bg-(--panel-raised) p-2">
								<div className="shrink-0 overflow-hidden rounded-[6px]">
									<CrosshairFromCode code={item.code} width={48} height={48} scale={1} backgroundColor={BACKDROPS[0]} />
								</div>
								<div className="min-w-0 flex-1">
									<p className="truncate text-[11px] font-medium text-(--text-primary)">{item.name || item.prompt}</p>
									<p className="truncate font-mono text-[10px] text-(--text-muted)" title={item.code}>
										{item.code}
									</p>
								</div>
								<Button size="icon" variant="ghost" aria-label={t("tools.crosshairCopy")} title={t("tools.crosshairCopy")} onClick={() => copy(item.code)}>
									{copied === item.code ? <LuCheck className="text-(--signal-pos)" /> : <LuCopy />}
								</Button>
							</div>
						))}
					</div>
				</section>
			)}
		</div>
	);
};
