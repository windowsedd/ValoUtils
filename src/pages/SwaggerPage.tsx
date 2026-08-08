import { PageHeader, SectionCard } from "@/components/section-card";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FaArrowUpRightFromSquare, FaBook } from "react-icons/fa6";

// The Riot Client serves a genuine OpenAPI 3 document at
// `/swagger/v3/openapi.json`. `swagger:open` hosts it on a loopback port (see
// `src-tauri/src/api_docs.rs`) and opens that URL in the system browser — the
// spec is a live endpoint, so a refresh always shows the current client's API.
const SwaggerPage = () => {
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
				icon={<FaBook className="text-[#22d3ee] text-lg" />}
				title={t("nav.apiReference")}
				subtitle={t("apiReference.subtitle")}
			/>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 flex flex-col gap-4">
				<SectionCard title={t("apiReference.sectionTitle")} accent="#22d3ee">
					<div className="px-3 py-1 flex flex-col gap-3">
						<p className="text-sm text-gray-400 leading-relaxed">{t("apiReference.description")}</p>

						<button
							onClick={openInBrowser}
							disabled={loading}
							className="self-start flex items-center gap-2 px-4 py-2 rounded-lg bg-[#22d3ee]/10 border border-[#22d3ee]/30 text-[#22d3ee] text-sm font-semibold hover:bg-[#22d3ee]/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							<FaArrowUpRightFromSquare className="w-3.5 h-3.5" />
							{loading ? t("apiReference.loadingSpec") : t("apiReference.open")}
						</button>

						{error && (
							<p className="text-xs text-red-300">
								{error} — {t("apiReference.startClient")}
							</p>
						)}

						{url && (
							<div className="text-xs text-gray-500 flex flex-col gap-1">
								<p>
									{t("apiReference.serving")} <code className="text-[#22d3ee]">{url}</code>
								</p>
								<p>
									{t("apiReference.rawDocument")} <code className="text-[#22d3ee]">{url}/openapi.json</code>
								</p>
							</div>
						)}
					</div>
				</SectionCard>

				<SectionCard title={t("apiReference.aboutTitle")} accent="#6b7280">
					<p className="px-3 py-1 text-sm text-gray-400 leading-relaxed">{t("apiReference.aboutBody")}</p>
				</SectionCard>
			</div>
		</div>
	);
};

export default SwaggerPage;
