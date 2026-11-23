import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { SavedChatMatch } from "@/types/chat";

export type SavedHistoryAccount = {
	puuid: string;
	/** `GameName#Tag`, once the name service has been asked. */
	name: string | null;
	matchCount: number;
	updatedAt: number;
};

type AccountsReply = { success: true; accounts: SavedHistoryAccount[] } | { success: false; error?: string };
type RemoveReply = { success: true; removed: boolean } | { success: false; error?: string };
type HistoryReply =
	| { success: true; owner: string; matches: SavedChatMatch[]; names: Record<string, string> }
	| { success: false; error?: string };

const EMPTY: SavedChatMatch[] = [];

/**
 * Saved match chat for every account on this PC. The signed-in account uses
 * its live history (`liveMatches`, which also fills in match details); any
 * other account is read from the local file, so it works signed out too.
 * `names` maps lowercase PUUIDs to Riot IDs for owners and speakers.
 */
export const useSavedHistoryAccounts = (
	open: boolean,
	signedInOwner: string,
	liveMatches: readonly SavedChatMatch[],
) => {
	const [accounts, setAccounts] = useState<SavedHistoryAccount[]>([]);
	const [chosen, setChosen] = useState<string | null>(null);
	const [loaded, setLoaded] = useState<{ owner: string; matches: SavedChatMatch[]; names: Record<string, string> } | null>(null);
	// Removed here: hidden at once, before the next chat poll drops them too.
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [version, setVersion] = useState(0);
	const liveCount = liveMatches.length;

	// New saves change the list, so it is reread when the live count moves.
	useEffect(() => {
		if (!open) return;
		let active = true;
		invoke<AccountsReply>("chat_saved_history_accounts")
			.then((reply) => {
				if (active && reply.success) setAccounts(reply.accounts);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [open, signedInOwner, liveCount, version]);

	const known = (puuid: string | null) => !!puuid && accounts.some((account) => account.puuid === puuid);
	const owner =
		(known(chosen) ? chosen : null) ??
		(signedInOwner && (known(signedInOwner) || accounts.length === 0) ? signedInOwner : null) ??
		accounts[0]?.puuid ??
		"";
	const isLive = owner !== "" && owner === signedInOwner;

	// Names (and, for other accounts, the matches) come from the saved file.
	// Reread after the account list returns, since that is when names get saved.
	useEffect(() => {
		if (!open || !owner) return;
		let active = true;
		invoke<HistoryReply>("chat_saved_history_get", { args: [owner] })
			.then((reply) => {
				if (active && reply.success) setLoaded({ owner, matches: reply.matches, names: reply.names ?? {} });
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [open, owner, accounts, version]);

	const data = loaded?.owner === owner ? loaded : null;
	const visible = (list: readonly SavedChatMatch[]) =>
		removed.size === 0 ? list : list.filter((match) => !removed.has(`${owner}:${match.matchUuid}`));

	/** Deletes one saved match chat of the shown account on this PC. */
	const remove = async (matchUuid: string): Promise<RemoveReply> => {
		const reply = await invoke<RemoveReply>("chat_saved_history_remove", { args: [owner, matchUuid] });
		if (reply.success) {
			setRemoved((current) => new Set(current).add(`${owner}:${matchUuid}`));
			setVersion((current) => current + 1);
		}
		return reply;
	};

	return {
		accounts,
		owner,
		setOwner: setChosen,
		isLive,
		matches: visible(isLive ? liveMatches : (data?.matches ?? EMPTY)),
		remove,
		names: data?.names ?? {},
	};
};
