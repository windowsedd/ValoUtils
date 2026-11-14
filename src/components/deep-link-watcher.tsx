import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDynamicModal } from "@/components/dynamic-modal";
import { Button } from "@/components/ui/button";
import { MatchLinkView } from "@/components/match-link-view";
import { listenEvent, reportIpcError } from "@/util/ipc";
import { isDeepLink, navigateTo, openTool, shareCrosshair, sharePlayer, type DeepLink } from "@/util/deep-links";

/**
 * Opens `valoutils://` links: the one that launched the app (kept by the
 * backend until taken) and any opened while it runs (`deep-link:open`).
 * Crosshairs and players open on the Tools page; matches open their
 * scoreboard in the app-wide dialog over the current page.
 */
export const DeepLinkWatcher = ({ children }: { children?: ReactNode }) => {
	const { t } = useTranslation();
	const modal = useDynamicModal();
	const modalRef = useRef(modal);
	modalRef.current = modal;
	const tRef = useRef(t);
	tRef.current = t;

	useEffect(() => {
		const open = (value: unknown) => {
			if (!isDeepLink(value)) return;
			const link: DeepLink = value;
			invoke("analytics_track", { args: ["deeplink:open", JSON.stringify({ kind: link.kind })] }).catch(reportIpcError);
			if (link.kind === "crosshair") {
				shareCrosshair({ code: link.code, name: link.name ?? null });
				navigateTo("tools");
				openTool("crosshair");
			} else if (link.kind === "player") {
				sharePlayer(link.query);
				navigateTo("tools");
				openTool("lookup");
			} else {
				const { showModal, closeModal } = modalRef.current;
				showModal({
					title: tRef.current("deepLink.matchTitle"),
					body: <MatchLinkView matchId={link.matchId} />,
					footer: (
						<Button variant="secondary" onClick={() => closeModal()}>
							{tRef.current("common.close")}
						</Button>
					),
				});
			}
		};
		let active = true;
		invoke<unknown>("deep_link_take")
			.then((pending) => {
				if (active) open(pending);
			})
			.catch(() => {});
		const stop = listenEvent<unknown>("deep-link:open", (payload) => {
			// The pushed link is also kept as pending; take it so it isn't shown twice.
			invoke("deep_link_take").catch(() => {});
			open(payload);
		});
		return () => {
			active = false;
			stop();
		};
	}, []);
	return <>{children}</>;
};
