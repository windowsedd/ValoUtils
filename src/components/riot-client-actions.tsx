import { invoke } from "@tauri-apps/api/core";
import { gooeyToast as toast } from "goey-toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPower, LuRotateCw } from "react-icons/lu";
import { useDynamicModal } from "@/components/dynamic-modal";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { reportIpcError } from "@/util/ipc";

export type RiotClientAction = "close" | "restart";

const CHANNEL: Record<RiotClientAction, string> = {
	close: "riot_client_close",
	restart: "riot_client_restart",
};

type RiotClientReply =
	| { success: true; closedGame?: boolean; closedClient?: boolean; relaunchedGame?: boolean }
	| { success: false; code?: string; error?: string };

/**
 * Close the Riot Client, or close it and reopen it through the XMPP relay.
 * While VALORANT runs the backend refuses until the player confirms closing
 * the game too; that confirmation and the results go through the app-wide
 * modal and toasts, so they survive the caller (a menu, say) closing.
 */
export const useRiotClientActions = (from: string, onDone?: () => void) => {
	const { t } = useTranslation();
	const { showModal, closeModal } = useDynamicModal();
	const [busy, setBusy] = useState<RiotClientAction | null>(null);
	const mounted = useRef(true);
	const done = useRef(onDone);
	done.current = onDone;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const succeeded = (action: RiotClientAction, reply: Extract<RiotClientReply, { success: true }>) => {
		if (action === "restart") {
			toast.success(t(reply.relaunchedGame ? "riotClient.restartedGame" : "riotClient.restarted"));
		} else if (reply.closedGame) {
			toast.success(t("riotClient.closedBoth"));
		} else {
			toast.success(t(reply.closedClient ? "riotClient.closed" : "riotClient.notRunning"));
		}
	};

	/** `game`: VALORANT is running, so confirming closes it too. */
	const confirm = (action: RiotClientAction, game: boolean) => {
		showModal({
			title: t(game ? "riotClient.confirmTitle" : "riotClient.confirmCloseTitle"),
			body: (
				<p className="text-[12px] leading-5 text-(--text-secondary)">
					{t(game ? "riotClient.confirmBody" : "riotClient.confirmCloseBody")}
				</p>
			),
			footer: [
				<Button key="cancel" variant="secondary" onClick={closeModal}>
					{t("common.cancel")}
				</Button>,
				<Button
					key="confirm"
					variant="destructive"
					onClick={() => {
						closeModal();
						run(action, game);
					}}
				>
					{t(
						!game
							? "riotClient.close"
							: action === "restart"
								? "riotClient.confirmRestart"
								: "riotClient.confirmClose",
					)}
				</Button>,
			],
		});
	};

	/**
	 * Close always asks first, naming VALORANT when it is running so there is
	 * only one prompt. Restart asks only when the game would be closed.
	 */
	const request = (action: RiotClientAction) => {
		if (action !== "close") {
			run(action);
			return;
		}
		setBusy("close");
		invoke<{ success?: boolean; valorantRunning?: boolean }>("client_config_status")
			.then((status) => confirm("close", status?.valorantRunning === true))
			// The backend still refuses to close a running game unconfirmed.
			.catch(() => confirm("close", false))
			.finally(() => {
				if (mounted.current) setBusy(null);
			});
	};

	const run = (action: RiotClientAction, closeGame = false) => {
		setBusy(action);
		invoke("analytics_track", { args: ["riot_client", JSON.stringify({ action, from, closeGame })] }).catch(
			reportIpcError,
		);
		invoke<RiotClientReply>(CHANNEL[action], { args: [closeGame] })
			.then((reply) => {
				if (reply.success) {
					succeeded(action, reply);
					done.current?.();
				} else if (reply.code === "valorantRunning") {
					confirm(action, true);
				} else {
					toast.error(reply.error || t("riotClient.failed"));
				}
			})
			.catch((error) => toast.error(String(error)))
			.finally(() => {
				if (mounted.current) setBusy(null);
			});
	};

	return { busy, run: request };
};

/** Restart through relay and Close Riot Client, as buttons (`row`) or menu items (`menu`). */
export const RiotClientActions = ({
	from,
	layout = "row",
	actions = ["restart", "close"],
	onDone,
	className,
}: {
	/** Analytics source, e.g. "loginRequired" or "statusMenu". */
	from: string;
	/** Which buttons to show, in order. */
	actions?: RiotClientAction[];
	layout?: "row" | "menu";
	onDone?: () => void;
	className?: string;
}) => {
	const { t } = useTranslation();
	const { busy, run } = useRiotClientActions(from, onDone);
	const menu = layout === "menu";
	const items: { action: RiotClientAction; icon: React.ReactNode; label: string; pending: string; hint: string }[] = [
		{
			action: "restart",
			icon: <LuRotateCw aria-hidden="true" />,
			label: t("riotClient.restart"),
			pending: t("riotClient.restarting"),
			hint: t("riotClient.restartHint"),
		},
		{
			action: "close",
			icon: <LuPower aria-hidden="true" />,
			label: t("riotClient.close"),
			pending: t("riotClient.closing"),
			hint: t("riotClient.closeHint"),
		},
	];
	return (
		<div
			data-riot-client-actions={layout}
			className={cn(menu ? "flex flex-col gap-0.5" : "flex flex-wrap items-center justify-center gap-2", className)}
		>
			{items.filter((item) => actions.includes(item.action)).map((item) => (
				<Tooltip key={item.action}>
					<TooltipTrigger asChild>
						<Button
							variant={menu ? "ghost" : item.action === "restart" ? "accent" : "outline"}
							size={menu ? "default" : "lg"}
							pending={busy === item.action}
							disabled={busy !== null}
							onClick={() => run(item.action)}
							className={cn(
								menu && "h-8 w-full justify-start gap-2 rounded-[8px] px-2",
								menu && item.action === "close" && "hover:text-(--signal-neg)",
							)}
						>
							{busy !== item.action && item.icon}
							{busy === item.action ? item.pending : item.label}
						</Button>
					</TooltipTrigger>
					<TooltipContent side={menu ? "right" : "bottom"} className="max-w-64 whitespace-normal">
						{item.hint}
					</TooltipContent>
				</Tooltip>
			))}
		</div>
	);
};
