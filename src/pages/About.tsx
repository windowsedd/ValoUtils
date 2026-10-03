import { listenEvent, reportIpcError } from "@/util/ipc";
import { invoke } from "@tauri-apps/api/core";
import { PageHeader, SectionCard, SectionRow, pageBodyClass } from "@/components/section-card";
import { openUrl } from "@/util";
import { useEffect, useState } from "react";
import { FaDiscord, FaGithub, FaTwitter } from "react-icons/fa6";
import { LuInfo, LuRotateCw } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import valoUtilsIcon from "../../src-tauri/icons/icon.png";

const LINKS = [
	{ icon: FaGithub, url: "https://github.com/windowsedd/ValoUtils", label: "GitHub" },
	{ icon: FaTwitter, url: "https://x.com/windowsedd/", label: "X" },
	{ icon: FaDiscord, url: "https://discord.gg/valoutils", label: "Discord" },
];

/**
 * Where the update check has got to.
 *
 * The backend drives this through `update:*` events and then restarts the app
 * itself, so `downloaded` is a terminal state on this side — there is no "done"
 * to return to.
 */
type UpdateStage = "idle" | "checking" | "downloading" | "downloaded" | "upToDate" | "error";

const BUSY: ReadonlySet<UpdateStage> = new Set<UpdateStage>(["checking", "downloading", "downloaded"]);

const About = () => {
	const [version, setVersion] = useState<string | null>(null);
	const [stage, setStage] = useState<UpdateStage>("idle");
	const [nextVersion, setNextVersion] = useState<string | null>(null);
	const [updateError, setUpdateError] = useState<string | null>(null);
	const { t } = useTranslation();

	useEffect(() => {
const applyVersion = (value: string) => setVersion(value);

		let active = true;

		invoke<any>("version").then(reply => { if (active) applyVersion(reply); }).catch(error => { if (active) return (reportIpcError)(error); });

		return () => { active = false; };
}, []);

	useEffect(() => {
const onError = (message: any) => {
			setUpdateError(message || null);
			setStage("error");
		};

const onNotAvailable = () => setStage("upToDate");

const onDownloaded = () => setStage("downloaded");

const onProgress = () => setStage("downloading");

const onAvailable = (message: any) => {
			try {
				setNextVersion(message?.version ?? null);
			} catch {
				setNextVersion(null);
			}
			setStage("downloading");
		};

const onChecking = () => {
			setUpdateError(null);
			setNextVersion(null);
			setStage("checking");
		};

		// Progress arrives as a bare tick with no byte counts, so it only confirms
		// the download is alive — the bar it drives has to stay indeterminate.

		const stopChecking = listenEvent("update:checking", onChecking);
		const stopAvailable = listenEvent("update:available", onAvailable);
		const stopProgress = listenEvent("update:download-progress", onProgress);
		const stopDownloaded = listenEvent("update:downloaded", onDownloaded);
		const stopNotAvailable = listenEvent("update:not-available", onNotAvailable);
		const stopError = listenEvent("update:error", onError);
		return () => {
            stopChecking(); stopAvailable(); stopProgress();
            stopDownloaded(); stopNotAvailable(); stopError();
        };
	}, []);

	const busy = BUSY.has(stage);
	const statusLine: Record<UpdateStage, string | null> = {
		idle: null,
		checking: t("about.checking"),
		downloading: nextVersion
			? t("about.downloadingVersion", { version: nextVersion })
			: t("about.downloading"),
		downloaded: t("about.installed"),
		upToDate: t("about.upToDate"),
		error: updateError ?? t("about.updateFailed"),
	};
	const statusTone =
		stage === "error"
			? "text-(--signal-neg)"
			: stage === "upToDate" || stage === "downloaded"
				? "text-(--signal-pos)"
				: "text-(--text-muted)";

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<LuInfo className="text-lg" />}
				title={t("nav.about")}
				subtitle={version ? `v${version}` : undefined}
			/>

			<div className={pageBodyClass}>
				{/*
				 * Identity strip. The old version set the wordmark at 6xl, which was the
				 * only thing in a 13px app that broke the type scale; the icon carries
				 * the weight now so the type can sit back down next to everything else.
				 */}
				<section className="panel flex flex-wrap items-center gap-4 px-5 py-4">
					<img
						src={valoUtilsIcon}
						alt=""
						aria-hidden="true"
						className="h-14 w-14 shrink-0 rounded-[10px] object-contain"
					/>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-baseline gap-2">
							<h1 className="text-[22px] font-semibold leading-none text-(--text-primary)">
								ValoUtils
							</h1>
							<span className="rounded-[5px] border border-(--border) bg-(--control) px-1.5 py-0.5 text-[11px] tabular-nums text-(--text-secondary)">
								{version ? `v${version}` : "—"}
							</span>
						</div>
						<p className="mt-1.5 text-[12px] text-(--text-muted)">{t("about.tagline")}</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{LINKS.map(({ icon: Icon, url, label }) => (
							<button
								key={url}
								type="button"
								onClick={() => openUrl(url)}
								className="flex h-8 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-2.5 text-[12px] font-medium text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary)"
							>
								<Icon className="text-[13px]" />
								{label}
							</button>
						))}
					</div>
				</section>

				<SectionCard title={t("about.sectionUpdates")}>
					<SectionRow>
						<span className="text-[12px] text-(--text-secondary)">{t("about.currentVersion")}</span>
						<span className="text-[12px] tabular-nums text-(--text-primary)">{version ?? "—"}</span>
					</SectionRow>
					<SectionRow leader={false}>
						<div className="min-w-0 flex-1">
							{statusLine[stage] && (
								<p className={`text-[11px] leading-4 ${statusTone}`} role="status">
									{statusLine[stage]}
								</p>
							)}
							{/*
							 * Indeterminate by necessity, not by choice: the updater reports
							 * progress without byte counts, so a percentage would be invented.
							 */}
							{(stage === "checking" || stage === "downloading") && (
								<div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-(--control)">
									<div className="h-full rounded-full bg-(--accent) animate-[progress-indeterminate_1.4s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:animate-none" />
								</div>
							)}
						</div>
						<button
							type="button"
							disabled={busy}
							onClick={() => invoke("update_check").catch(reportIpcError)}
							className="flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-(--accent-border) bg-(--accent-soft) px-3 text-[12px] font-medium text-(--accent-selected) transition-colors hover:bg-(--accent-soft-hover) disabled:cursor-not-allowed disabled:opacity-40"
						>
							<LuRotateCw className={`h-3 w-3 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`} />
							{t("about.checkForUpdates")}
						</button>
					</SectionRow>
				</SectionCard>

				<SectionCard title={t("about.sectionCredits")}>
					<SectionRow>
						<span className="text-[12px] text-(--text-secondary)">{t("about.madeBy")}</span>
						<button
							type="button"
							onClick={() => openUrl("https://github.com/windowsedd")}
							className="text-[12px] font-medium text-(--text-primary) transition-colors hover:text-(--accent-selected)"
						>
							windowsed
						</button>
					</SectionRow>
				</SectionCard>

				<SectionCard title={t("about.sectionLegal")} accent="var(--text-muted)">
					<p className="px-2.5 py-1.5 text-[11px] leading-relaxed text-(--text-muted)">
						{t("about.disclaimer")}
					</p>
				</SectionCard>
			</div>
		</div>
	);
};

export default About;
