import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedChatMatch, SavedMatchDetails, SavedMatchDetailsResponse } from "@/types/chat";
import { matchesNeedingDetails, withFetchedDetails } from "./saved-match-history";

/** A failed lookup (usually a match still in progress) is tried again after this. */
const RETRY_MS = 5 * 60_000;

/**
 * Fills in map, mode, agent and result for saved matches. The backend reads
 * them from match-chat-history.json, or requests match-details once and saves
 * them there, so each match costs one request ever. Lookups run one at a time.
 */
export const useSavedMatchDetails = (
	matches: readonly SavedChatMatch[],
	owner: string | null | undefined,
	enabled: boolean,
): SavedChatMatch[] => {
	const [fetched, setFetched] = useState<{ owner: string; details: Map<string, SavedMatchDetails> }>({
		owner: "",
		details: new Map(),
	});
	const attempts = useRef<{ owner: string; at: Map<string, number> }>({ owner: "", at: new Map() });
	const pending = matchesNeedingDetails(matches).join(",");
	// Re-evaluated on each chat poll, so failed lookups get another try once it moves.
	const retryWindow = Math.floor(Date.now() / RETRY_MS);

	useEffect(() => {
		if (!enabled || !owner || !pending) return;
		if (attempts.current.owner !== owner) attempts.current = { owner, at: new Map() };
		const now = Date.now();
		const due = pending.split(",").filter((id) => now - (attempts.current.at.get(id) ?? -Infinity) >= RETRY_MS);
		if (due.length === 0) return;
		let active = true;
		(async () => {
			for (const id of due) {
				if (!active) return;
				attempts.current.at.set(id, Date.now());
				let reply: SavedMatchDetailsResponse;
				try {
					reply = await invoke<SavedMatchDetailsResponse>("chat_saved_match_details", { args: [id] });
				} catch {
					return;
				}
				if (!active) return;
				if (reply.success) {
					setFetched((current) => {
						const details = new Map(current.owner === owner ? current.details : []);
						details.set(id, reply.details);
						return { owner, details };
					});
				} else if (reply.code === "rateLimited" || reply.code === "loginRequired") {
					return;
				}
			}
		})();
		return () => {
			active = false;
		};
	}, [enabled, owner, pending, retryWindow]);

	return useMemo(
		() => withFetchedDetails(matches, fetched.owner === owner ? fetched.details : new Map()),
		[matches, fetched, owner],
	);
};
