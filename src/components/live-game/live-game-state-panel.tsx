import { FaArrowRotateRight, FaTriangleExclamation, FaUsers } from "react-icons/fa6";
import { useTranslation } from "react-i18next";

type Props = {
	kind: "loading" | "idle" | "login" | "error";
	detail?: string;
	onRetry?: () => void;
};

export const LiveGameStatePanel = ({ kind, detail, onRetry }: Props) => {
	const { t } = useTranslation();
	if (kind === "loading") {
		return (
			<div className="flex-1 px-6 pt-4 pb-6" aria-label={t("liveGame.loading")}>
				<div className="glass rounded-2xl p-4 animate-pulse motion-reduce:animate-none flex flex-col gap-2">
					<div className="h-14 rounded-xl bg-white/5" />
					<div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
						{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-16 rounded-xl bg-white/4" />)}
					</div>
					{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-12 rounded-xl bg-white/4" />)}
				</div>
			</div>
		);
	}

	const isError = kind === "error";
	const title = kind === "login" ? t("liveGame.loginRequired") : kind === "idle" ? t("liveGame.idle") : t("liveGame.failedToLoad");
	const body = detail ?? (kind === "login" ? t("liveGame.loginRequiredDesc") : kind === "idle" ? t("liveGame.idleDesc") : "");
	return (
		<div className="flex-1 flex items-center justify-center px-6 pt-4 pb-6">
			<div className="glass rounded-2xl p-7 text-center max-w-md flex flex-col items-center gap-2" role={isError ? "alert" : undefined}>
				{isError ? <FaTriangleExclamation className="text-2xl text-red-400" /> : <FaUsers className="text-3xl text-gray-600" />}
				<p className="text-white font-semibold">{title}</p>
				<p className="text-gray-400 text-sm leading-relaxed">{body}</p>
				{isError && onRetry && (
					<button type="button" onClick={onRetry} className="mt-3 h-11 px-4 rounded-lg bg-white/8 border border-white/15 text-sm font-semibold text-white hover:bg-white/12 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] transition-colors motion-reduce:transition-none flex items-center gap-2">
						<FaArrowRotateRight /> {t("liveGame.retry")}
					</button>
				)}
			</div>
		</div>
	);
};
