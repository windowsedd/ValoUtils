import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuPlay } from "react-icons/lu";
import { useTranslation } from "react-i18next";

/**
 * `relay` routes the client through the local client-config server so presence
 * masking works; `normal` is a plain launch for when that isn't wanted.
 */
type LaunchMode = "relay" | "normal";

const LAUNCH_CHANNEL: Record<LaunchMode, string> = {
	relay: "riot:launch-with-config",
	normal: "riot:launch-normal",
};

type LoginRequiredPanelProps = {
	icon?: ReactNode;
	title: string;
	description: string;
	/** Extra action rendered beside Launch — Chat passes its Refresh through here. */
	children?: ReactNode;
	/**
	 * Refetch the page's data. Called as soon as a Riot Client appears, then on a
	 * slow beat while one is running, so the page recovers on its own once the
	 * sign-in completes instead of stranding the user on this panel.
	 */
	onRetry?: () => void;
};

/**
 * The "Riot Client not signed in" state, shared by every page that needs a
 * session.
 *
 * Telling someone to go open the Riot Client and then leaving them to find it
 * themselves is a dead end, so this panel offers to start it — through the XMPP
 * relay, the same path the Bot page uses, so presence masking is available from
 * the moment the client comes up.
 *
 * `--client-config-url` is only read at process start, so the backend refuses to
 * launch while a client is already alive. The button tracks
 * `client:config-status` and steps aside with an explanation rather than handing
 * that error back after the click.
 */
export const LoginRequiredPanel = ({
	icon,
	title,
	description,
	children,
	onRetry,
}: LoginRequiredPanelProps) => {
	const { t } = useTranslation();
	const [clientRunning, setClientRunning] = useState<boolean | null>(null);
	/** Which button is in flight, so only that one shows the pending label. */
	const [launching, setLaunching] = useState<LaunchMode | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Held in a ref so a caller passing an inline arrow doesn't restart the poll
	// on every render.
	const retry = useRef(onRetry);
	retry.current = onRetry;

	useEffect(() => {
		if (!window.Main) return;

		const applyStatus = (message: string) => {
			try {
				const data = JSON.parse(message);
				if (!data?.success) return;
				const running = Boolean(data.riotClientRunning);
				setClientRunning((previous) => {
					// A client just appeared — the session may already be usable.
					if (running && previous === false) retry.current?.();
					return running;
				});
			} catch {
				/* Keep the last known state rather than flickering the button. */
			}
		};
		const applyLaunch = (message: string) => {
			setLaunching(null);
			try {
				const data = JSON.parse(message);
				setError(data?.success ? null : data?.error || t("common.launchFailed"));
			} catch {
				setError(t("common.launchFailed"));
			}
		};

		window.Main.on("client:config-status", applyStatus);
		window.Main.on("riot:launch-with-config", applyLaunch);
		window.Main.on("riot:launch-normal", applyLaunch);
		const poll = () => window.Main.send("client:config-status");
		poll();
		// Once the client is up the page's own poll picks the session up, so this
		// only has to notice the window opening.
		const timer = setInterval(poll, 3000);
		return () => {
			clearInterval(timer);
			window.Main.removeAllListeners("client:config-status");
			window.Main.removeAllListeners("riot:launch-with-config");
			window.Main.removeAllListeners("riot:launch-normal");
		};
	}, [t]);

	// Signing in takes a while after the window opens, and there is no event for
	// it, so poll the page's own fetch while a client is alive. Nothing to gain by
	// retrying when no client is running, so that case stays idle.
	useEffect(() => {
		if (!onRetry || clientRunning !== true) return;
		const timer = setInterval(() => retry.current?.(), 5000);
		return () => clearInterval(timer);
	}, [onRetry, clientRunning]);

	const launch = (mode: LaunchMode) => {
		setLaunching(mode);
		setError(null);
		window.Main.send(LAUNCH_CHANNEL[mode], "valorant", "live");
		window.Main.send("analytics:track", "riot_launch", JSON.stringify({ from: "loginRequired", mode }));
	};

	const alreadyRunning = clientRunning === true;
	const busy = launching !== null;

	return (
		<div className="flex flex-1 items-center justify-center p-6">
			<div
				data-login-required=""
				className="panel flex w-full max-w-md flex-col items-center gap-2 px-6 py-7 text-center"
			>
				{icon && <span className="mb-1 text-3xl text-(--text-muted)">{icon}</span>}
				<p className="text-[13px] font-semibold text-(--text-primary)">{title}</p>
				<p className="text-[12px] leading-5 text-(--text-muted)">{description}</p>

				<div className="mt-3 flex flex-wrap items-center justify-center gap-2">
					<button
						type="button"
						onClick={() => launch("relay")}
						disabled={busy || alreadyRunning}
						className="flex h-8 items-center gap-1.5 rounded-[6px] border border-(--accent-border) bg-(--accent-soft) px-3 text-[12px] font-medium text-(--accent-selected) transition-colors hover:bg-(--accent-soft-hover) disabled:cursor-not-allowed disabled:opacity-40"
					>
						<LuPlay className="h-3 w-3" />
						{launching === "relay" ? t("common.launching") : t("common.launchWithRelay")}
					</button>
					<button
						type="button"
						onClick={() => launch("normal")}
						disabled={busy || alreadyRunning}
						className="flex h-8 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-3 text-[12px] font-medium text-(--text-primary) transition-colors hover:bg-(--surface-hover) disabled:cursor-not-allowed disabled:opacity-40"
					>
						<LuPlay className="h-3 w-3" />
						{launching === "normal" ? t("common.launching") : t("common.launchNormal")}
					</button>
					{children}
				</div>

				{alreadyRunning && (
					<p className="mt-2 text-[11px] leading-4 text-(--signal-warn)">
						{t("common.riotClientRunningHint")}
					</p>
				)}
				{error && (
					<p role="alert" className="mt-2 text-[11px] leading-4 text-(--signal-neg)">
						{error}
					</p>
				)}
			</div>
		</div>
	);
};

export default LoginRequiredPanel;
