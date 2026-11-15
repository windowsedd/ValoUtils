import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/** How often a player was in your recent matches, and on which side. */
export type Encounter = {
	with: number;
	against: number;
	lastMatchId: string;
	lastStartMillis: number;
};

export type Encounters = {
	/** How many of your recent matches were searched. */
	recentMatches: number;
	/** By lowercase PUUID. */
	players: Record<string, Encounter>;
};

type Reply = ({ success: true } & Encounters) | { success: false; code?: string; error?: string };

/** Matches the backend's match-list reuse, so repeated views cost nothing. */
const TTL_MS = 90_000;
const cache = new Map<string, { at: number; request: Promise<Encounters | null> }>();

/**
 * Who you've met in your last matches (`encounters_get`). `excludeMatchId`
 * leaves the match being viewed out so it doesn't count itself. Failures
 * (signed out, rate limited) resolve to null and are retried after the TTL.
 */
export const fetchEncounters = (excludeMatchId = ""): Promise<Encounters | null> => {
	const key = excludeMatchId.toLowerCase();
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.request;
	const request = invoke<Reply>("encounters_get", { args: key ? [key] : [] })
		.then((reply) => (reply.success ? { recentMatches: reply.recentMatches, players: reply.players } : null))
		.catch(() => null);
	cache.set(key, { at: Date.now(), request });
	return request;
};

export const encounterFor = (encounters: Encounters | null, puuid: string | null | undefined) =>
	(puuid && encounters?.players[puuid.toLowerCase()]) || null;

/** `fetchEncounters` for a component; `enabled: false` skips the request. */
export const useEncounters = (excludeMatchId: string | null | undefined, enabled = true) => {
	const [encounters, setEncounters] = useState<Encounters | null>(null);
	useEffect(() => {
		if (!enabled || excludeMatchId === undefined) return;
		let active = true;
		fetchEncounters(excludeMatchId ?? "").then((result) => {
			if (active) setEncounters(result);
		});
		return () => {
			active = false;
		};
	}, [excludeMatchId, enabled]);
	return encounters;
};
