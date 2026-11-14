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
	}, [open, signedInOwner, liveCount]);

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
	}, [open, owner, accounts]);

	const data = loaded?.owner === owner ? loaded : null;
	return {
		accounts,
		owner,
		setOwner: setChosen,
		isLive,
		matches: isLive ? liveMatches : (data?.matches ?? EMPTY),
		names: data?.names ?? {},
	};
};
