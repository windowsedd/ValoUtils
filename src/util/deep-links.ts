/**
 * `valoutils://` links: building them, and handing an opened one to the page
 * that shows it. The watcher (`components/deep-link-watcher.tsx`) receives links
 * from the backend, parks them here, and navigates; the page takes them.
 */
export type SharedCrosshair = { code: string; name: string | null };

export type DeepLink =
	| { kind: "crosshair"; code: string; name?: string | null }
	| { kind: "player"; query: string }
	| { kind: "match"; matchId: string };

export const isDeepLink = (value: unknown): value is DeepLink => {
	if (!value || typeof value !== "object") return false;
	const link = value as Record<string, unknown>;
	return (
		(link.kind === "crosshair" && typeof link.code === "string") ||
		(link.kind === "player" && typeof link.query === "string") ||
		(link.kind === "match" && typeof link.matchId === "string")
	);
};

/** A parked value pages can take once, with change notifications. */
const slot = <T>() => {
	let pending: T | null = null;
	const listeners = new Set<() => void>();
	return {
		put(value: T) {
			pending = value;
			for (const listener of listeners) listener();
		},
		has: () => pending !== null,
		take() {
			const value = pending;
			pending = null;
			return value;
		},
		listen(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};

const crosshairs = slot<SharedCrosshair>();
const players = slot<string>();

export const shareCrosshair = crosshairs.put;
export const hasSharedCrosshair = crosshairs.has;
export const takeSharedCrosshair = crosshairs.take;
export const onSharedCrosshair = crosshairs.listen;

export const sharePlayer = players.put;
export const hasSharedPlayer = players.has;
export const takeSharedPlayer = players.take;
export const onSharedPlayer = players.listen;

/** Opens this crosshair in ValoUtils. */
export const crosshairLink = (code: string, name?: string | null) =>
	`valoutils://crosshair?code=${encodeURIComponent(code)}${name ? `&name=${encodeURIComponent(name)}` : ""}`;

/** Looks this player up in ValoUtils (Tools → Player lookup). */
export const playerLink = (riotIdOrPuuid: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(riotIdOrPuuid)
		? `valoutils://player?puuid=${riotIdOrPuuid.toLowerCase()}`
		: `valoutils://player?riotId=${encodeURIComponent(riotIdOrPuuid)}`;

/** Opens this match's scoreboard in ValoUtils. */
export const matchLink = (matchId: string) => `valoutils://match?id=${matchId.toLowerCase()}`;

/** Asks the app to show a page (handled by the router). */
export const navigateTo = (routeId: string) =>
	window.dispatchEvent(new CustomEvent("valoutils:navigate", { detail: { routeId } }));

/** Asks the Tools page to open one of its tools. */
export const openTool = (tool: string) =>
	window.dispatchEvent(new CustomEvent("valoutils:tools-open", { detail: { tool } }));
