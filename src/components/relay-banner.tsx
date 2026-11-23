import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuUnplug, LuX } from "react-icons/lu";
import { gooeyToast as toast } from "goey-toast";
import { Button } from "@/components/ui/button";
import { useRiotClientActions } from "@/components/riot-client-actions";
import { reportIpcError } from "@/util/ipc";

type ClientConfigStatus = {
	success?: boolean;
	relayRunning?: boolean;
	relayClientLost?: boolean;
	error?: string;
};

const POLL_MS = 10_000;
/**
 * A lost client usually reconnects on its own once the relay is back, so the
 * banner waits for this many polls in a row (~20 s) before speaking up.
 */
const LOST_POLLS = 2;

/**
 * App-wide warning when the Riot Client that used the XMPP relay is still
 * running without it (`relayClientLost`): the player shows offline and chat
 * commands stop. Offers Wake (when the relay itself is down) and Restart
 * through relay. A client opened without ValoUtils never triggers it.
 */
export const RelayBanner = () => {
	const { t } = useTranslation();
	const [status, setStatus] = useState<ClientConfigStatus | null>(null);
	const [lostPolls, setLostPolls] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	const [waking, setWaking] = useState(false);
	const { busy, run } = useRiotClientActions("relayBanner");
	const active = useRef(true);

	useEffect(() => {
		active.current = true;
		let timer: number | undefined;
		const poll = () => {
			window.clearTimeout(timer);
			if (document.hidden) {
				timer = window.setTimeout(poll, POLL_MS);
				return;
			}
			invoke<ClientConfigStatus>("client_config_status")
				.then((reply) => {
					if (!active.current || !reply?.success) return;
					setStatus(reply);
					setLostPolls((count) => (reply.relayClientLost ? count + 1 : 0));
					// Back to normal: a later loss should show the banner again.
					if (!reply.relayClientLost) setDismissed(false);
				})
				.catch(() => {})
				.finally(() => {
					if (active.current) timer = window.setTimeout(poll, POLL_MS);
				});
		};
		poll();
		const onVisible = () => {
			if (!document.hidden) poll();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			active.current = false;
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);

	if (dismissed || !status?.relayClientLost || lostPolls < LOST_POLLS) return null;

	const wake = async () => {
		setWaking(true);
		invoke("analytics_track", { args: ["relay_banner", JSON.stringify({ action: "wake" })] }).catch(reportIpcError);
		try {
			const reply = await invoke<ClientConfigStatus>("client_config_start");
			if (reply?.success === false) toast.error(reply.error || t("relayBanner.wakeFailed"));
			else toast.success(t("relayBanner.woken"));
		} catch (error) {
			toast.error(String(error));
		} finally {
			setWaking(false);
		}
	};

	return (
		<div
			role="alert"
			className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--signal-warn)/40 bg-(--signal-warn)/10 px-4 py-2"
		>
			<LuUnplug className="shrink-0 text-(--signal-warn)" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="text-[12px] font-medium text-(--text-primary)">{t("relayBanner.title")}</p>
				<p className="text-[11px] text-(--text-secondary)">{t("relayBanner.body")}</p>
			</div>
			<div className="flex items-center gap-1.5">
				{!status.relayRunning && (
					<Button variant="outline" size="default" pending={waking} disabled={waking || busy !== null} onClick={wake}>
						{t("relayBanner.wake")}
					</Button>
				)}
				<Button
					variant="accent"
					size="default"
					pending={busy === "restart"}
					disabled={waking || busy !== null}
					onClick={() => run("restart")}
				>
					{busy === "restart" ? t("riotClient.restarting") : t("riotClient.restart")}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					aria-label={t("relayBanner.dismiss")}
					onClick={() => {
						setDismissed(true);
						invoke("analytics_track", { args: ["relay_banner", JSON.stringify({ action: "dismiss" })] }).catch(
							reportIpcError,
						);
					}}
				>
					<LuX />
				</Button>
			</div>
		</div>
	);
};
