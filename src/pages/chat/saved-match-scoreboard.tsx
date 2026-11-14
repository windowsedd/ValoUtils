import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronDown, LuLink, LuTable2 } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { matchLink } from "@/util/deep-links";
import { MatchScoreboard, useMatchAssets, useMatchDetails } from "@/components/match-scoreboard";
import { reportIpcError } from "@/util/ipc";

const COLLAPSED_KEY = "valoutils-history-scoreboard-collapsed";

/**
 * Scoreboard above a saved match's chat in the History tab: every player's
 * line, from the same `match_details` request (and cache) the Matches page
 * uses. Open by default; nothing is fetched while it is collapsed.
 */
export const SavedMatchScoreboard = ({ matchUuid, ownerPuuid }: { matchUuid: string; ownerPuuid?: string | null }) => {
	const { t } = useTranslation();
	// Open by default; collapsing is remembered per viewer.
	const [open, setOpen] = useState(() => {
		try {
			return localStorage.getItem(COLLAPSED_KEY) !== "true";
		} catch {
			return true;
		}
	});
	const toggle = () => {
		const next = !open;
		setOpen(next);
		try {
			localStorage.setItem(COLLAPSED_KEY, String(!next));
		} catch {
			/* Storage can be unavailable; the choice just isn't remembered. */
		}
		if (next) invoke("analytics_track", { args: ["chat:history-scoreboard"] }).catch(reportIpcError);
	};
	const { details, errors, ensure } = useMatchDetails();
	const [linkCopied, setLinkCopied] = useState(false);
	useEffect(() => {
		if (!linkCopied) return;
		const timer = setTimeout(() => setLinkCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [linkCopied]);
	const match = details[matchUuid];
	const loaded = useMemo(() => (match ? [match] : []), [match]);
	const assets = useMatchAssets(loaded);

	useEffect(() => {
		if (open) ensure(matchUuid);
	}, [open, matchUuid, ensure]);

	const panelId = `saved-scoreboard-${matchUuid}`;
	return (
		<section data-saved-scoreboard="" className="shrink-0 border-b border-(--line)">
			<div className="flex items-center gap-1 pr-2">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={toggle}
				className="press-flat flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-(--text-secondary) outline-none transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:shadow-[inset_0_0_0_2px_var(--accent-soft)]"
			>
				<LuTable2 className="size-3.5 shrink-0 text-(--accent-selected)" aria-hidden="true" />
				<span className="flex-1">{t("chat.scoreboard")}</span>
				<LuChevronDown
					aria-hidden="true"
					className={`size-3.5 shrink-0 text-(--text-muted) transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
				/>
			</button>
			<Button
				size="sm"
				variant="ghost"
				title={t("chat.matchLinkHint")}
				onClick={() => {
					invoke("clipboard_set", { args: [matchLink(matchUuid)] }).catch(reportIpcError);
					invoke("analytics_track", { args: ["chat:history-match-link"] }).catch(reportIpcError);
					setLinkCopied(true);
				}}
			>
				{linkCopied ? <LuCheck className="text-(--signal-pos)" /> : <LuLink />}
				{linkCopied ? t("settings.copied") : t("chat.copyMatchLink")}
			</Button>
			</div>
			{open && (
				<div id={panelId} className="max-h-[45vh] overflow-y-auto px-3 pb-3">
					<MatchScoreboard
						details={match}
						assets={assets}
						// Opening starts the request, so anything not loaded or failed is loading.
						loading={!match && !errors[matchUuid]}
						error={errors[matchUuid]}
						highlightPuuid={ownerPuuid ?? undefined}
						copyPuuid
					/>
				</div>
			)}
		</section>
	);
};
