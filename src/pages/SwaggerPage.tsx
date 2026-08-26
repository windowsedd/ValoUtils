import { PageHeader, SectionCard, pageBodyClass } from "@/components/section-card";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FaArrowLeft, FaArrowUpRightFromSquare, FaBook } from "react-icons/fa6";

// The Riot Client serves a genuine OpenAPI 3 document at
// `/swagger/v3/openapi.json`. `swagger:open` hosts it on a loopback port (see
// `src-tauri/src/api_docs.rs`) and opens that URL in the system browser — the
// spec is a live endpoint, so a refresh always shows the current client's API.
type SwaggerPageProps = { onBack?: () => void };

const SwaggerPage = ({ onBack }: SwaggerPageProps) => {
	const { t } = useTranslation();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [url, setUrl] = useState<string | null>(null);

	const openInBrowser = () => {
		if (!window.Main) return;
		setLoading(true);
		setError(null);
		window.Main.on("swagger:open", (msg: string) => {
			window.Main.removeAllListeners("swagger:open");
			setLoading(false);
			try {
				const res = JSON.parse(msg);
				if (res.success) setUrl(res.url ?? null);
				else setError(res.error ?? t("apiReference.openFailed"));
			} catch {
				setError(t("apiReference.parseFailed"));
			}
		});
		window.Main.send("swagger:open");
	};

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<FaBook className="text-(--accent) text-lg" />}
				title={t("nav.apiReference")}
				subtitle={t("apiReference.subtitle")}
			>
				{onBack && <button onClick={onBack} className="flex h-7 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[11px] font-medium text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)"><FaArrowLeft className="h-3 w-3" />{t("settings.title")}</button>}
			</PageHeader>

			<div className={pageBodyClass}>
				<SectionCard title={t("apiReference.sectionTitle")} accent="#8064e9">
					<div className="px-3 py-1 flex flex-col gap-3">
						<p className="text-[12px] text-(--text-secondary) leading-relaxed">{t("apiReference.description")}</p>

						<button
							onClick={openInBrowser}
							disabled={loading}
							className="self-start flex h-7 items-center gap-2 px-3 rounded-[6px] bg-(--accent-soft) border border-(--accent-border) text-(--accent-selected) text-[12px] font-medium hover:bg-(--accent-soft-hover) disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
						>
							<FaArrowUpRightFromSquare className="w-3 h-3" />
							{loading ? t("apiReference.loadingSpec") : t("apiReference.open")}
						</button>

						{error && (
							<p className="text-[11px] text-(--signal-neg)">
								{error} — {t("apiReference.startClient")}
							</p>
						)}

						{url && (
							<div className="text-[11px] text-(--text-muted) flex flex-col gap-1">
								<p>
									{t("apiReference.serving")} <code className="text-(--accent-selected)">{url}</code>
								</p>
								<p>
									{t("apiReference.rawDocument")} <code className="text-(--accent-selected)">{url}/openapi.json</code>
								</p>
							</div>
						)}
					</div>
				</SectionCard>

				<SectionCard title={t("apiReference.aboutTitle")} accent="#6b7280">
					<p className="px-3 py-1 text-[12px] text-(--text-secondary) leading-relaxed">{t("apiReference.aboutBody")}</p>
				</SectionCard>
			</div>
		</div>
	);
};

export default SwaggerPage;
