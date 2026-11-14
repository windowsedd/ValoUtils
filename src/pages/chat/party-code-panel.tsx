import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuCopy, LuLink, LuLogIn } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reportIpcError } from "@/util/ipc";
import { rateLimitedSeconds } from "@/util/rate-limit";

type PartyCodeReply =
	| { success: true; inviteCode: string; link?: string }
	| { success: false; code?: string; error?: string; retryInSeconds?: number };

/** Riot's party link, as the game's Party Link panel shows it. */
export const partyLink = (code: string) => `https://gg.riotgames.com/VAL?joinCode=${code}`;

/** Letters and digits only, the way Riot issues party codes. A pasted party link gives its code. */
export const cleanPartyCode = (value: string) => {
	const fromLink = /joincode=([a-z0-9]+)/i.exec(value)?.[1];
	return (fromLink ?? value).replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 64);
};

/**
 * Party invite codes in the Chat Party sidebar: create one for your current
 * party (and copy it), or join another party by its code.
 */
export const PartyCodePanel = () => {
	const { t } = useTranslation();
	const [created, setCreated] = useState<string | null>(null);
	const [joinCode, setJoinCode] = useState("");
	const [busy, setBusy] = useState<"create" | "join" | "disable" | null>(null);
	const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const [copied, setCopied] = useState<"code" | "link" | null>(null);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(null), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = (what: "code" | "link", text: string) => {
		invoke("clipboard_set", { args: [text] }).catch(reportIpcError);
		invoke("analytics_track", { args: ["party:copy", JSON.stringify({ what })] }).catch(reportIpcError);
		setCopied(what);
	};

	const disable = async () => {
		setBusy("disable");
		setStatus(null);
		try {
			const reply = await invoke<PartyCodeReply>("party_code_disable");
			if (reply.success) {
				setCreated(null);
				setStatus({ tone: "ok", text: t("chat.partyLinkDisabled") });
			} else {
				setStatus({ tone: "error", text: failure(reply) });
			}
			invoke("analytics_track", { args: ["party:link-disable"] }).catch(reportIpcError);
		} catch (error) {
			setStatus({ tone: "error", text: String(error) });
		} finally {
			setBusy(null);
		}
	};

	const failure = (reply: Extract<PartyCodeReply, { success: false }>) => {
		if (reply.code === "loginRequired") return t("chat.partyCodeLogin");
		const seconds = rateLimitedSeconds(reply);
		if (seconds !== null) return t("common.rateLimited", { seconds });
		return reply.error || t("chat.partyCodeFailed");
	};

	const create = async () => {
		setBusy("create");
		setStatus(null);
		try {
			const reply = await invoke<PartyCodeReply>("party_code_create");
			if (reply.success) setCreated(reply.inviteCode);
			else setStatus({ tone: "error", text: failure(reply) });
			invoke("analytics_track", { args: ["party:code-create"] }).catch(reportIpcError);
		} catch (error) {
			setStatus({ tone: "error", text: String(error) });
		} finally {
			setBusy(null);
		}
	};

	const join = async () => {
		const code = cleanPartyCode(joinCode);
		if (!code) return;
		setBusy("join");
		setStatus(null);
		try {
			const reply = await invoke<PartyCodeReply>("party_code_join", { args: [code] });
			if (reply.success) {
				setStatus({ tone: "ok", text: t("chat.partyJoined", { code: reply.inviteCode }) });
				setJoinCode("");
			} else {
				setStatus({ tone: "error", text: failure(reply) });
			}
			invoke("analytics_track", { args: ["party:code-join"] }).catch(reportIpcError);
		} catch (error) {
			setStatus({ tone: "error", text: String(error) });
		} finally {
			setBusy(null);
		}
	};

	return (
		<section data-party-code="" aria-label={t("chat.partyCode")} className="px-2 pb-1">
			<div className="flex flex-col gap-2 rounded-[8px] border border-(--line) bg-(--panel-raised) p-2.5">
				<h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">{t("chat.partyCode")}</h3>

				{created ? (
					<>
						<div className="flex items-center gap-1.5">
							<code data-party-invite-code="" className="min-w-0 flex-1 truncate rounded-[6px] border border-(--border) bg-(--control) px-2 py-1 font-mono text-[13px] font-semibold tracking-[0.12em] text-(--accent-selected)">
								{created}
							</code>
							<Button
								size="icon"
								variant="outline"
								aria-label={copied === "code" ? t("settings.copied") : t("chat.partyCopyCode")}
								title={copied === "code" ? t("settings.copied") : t("chat.partyCopyCode")}
								onClick={() => copy("code", created)}
							>
								{copied === "code" ? <LuCheck className="text-(--signal-pos)" /> : <LuCopy />}
							</Button>
						</div>
						<div className="flex flex-col gap-1">
							<span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">{t("chat.partyLink")}</span>
							<div className="flex items-center gap-1.5">
								<span data-party-link="" className="min-w-0 flex-1 truncate rounded-[6px] border border-(--border) bg-(--control) px-2 py-1 font-mono text-[11px] text-(--text-secondary)" title={partyLink(created)}>
									{partyLink(created).replace(/^https:\/\//, "")}
								</span>
								<Button
									size="icon"
									variant="outline"
									aria-label={copied === "link" ? t("settings.copied") : t("chat.partyCopyLink")}
									title={copied === "link" ? t("settings.copied") : t("chat.partyCopyLink")}
									onClick={() => copy("link", partyLink(created))}
								>
									{copied === "link" ? <LuCheck className="text-(--signal-pos)" /> : <LuCopy />}
								</Button>
							</div>
							<Button variant="destructive" size="sm" pending={busy === "disable"} disabled={busy !== null} onClick={disable}>
								{t("chat.partyLinkDisable")}
							</Button>
						</div>
					</>
				) : null}
				<Button variant="secondary" size="sm" pending={busy === "create"} disabled={busy !== null} onClick={create}>
					<LuLink />
					{created ? t("chat.partyCodeNew") : t("chat.partyCodeCreate")}
				</Button>

				<form
					className="flex items-center gap-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						void join();
					}}
				>
					<Input
						value={joinCode}
						onChange={(event) => setJoinCode(cleanPartyCode(event.target.value))}
						placeholder={t("chat.partyCodePlaceholder")}
						onPaste={(event) => {
							// A pasted party link becomes its code.
							const pasted = event.clipboardData.getData("text");
							if (/joincode=/i.test(pasted)) {
								event.preventDefault();
								setJoinCode(cleanPartyCode(pasted));
							}
						}}
						aria-label={t("chat.partyCodeJoinLabel")}
						spellCheck={false}
						autoComplete="off"
						className="font-mono uppercase tracking-[0.08em]"
					/>
					<Button type="submit" size="sm" variant="accent" pending={busy === "join"} disabled={busy !== null || !joinCode}>
						<LuLogIn />
						{t("chat.partyJoin")}
					</Button>
				</form>

				{status && (
					<p role={status.tone === "error" ? "alert" : "status"} className={`text-[11px] leading-4 ${status.tone === "error" ? "text-(--signal-neg)" : "text-(--signal-pos)"}`}>
						{status.text}
					</p>
				)}
			</div>
		</section>
	);
};
